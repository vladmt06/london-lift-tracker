import { Prisma, PollStatus, OutageState, ResolutionStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { fetchLiftDisruptions, TflRequestError } from "@/lib/tfl/client";
import {
  buildAssetKey,
  isPartialResult,
  normalizeFeed,
  FeedShapeError,
  type NormalizedLiftDisruption,
} from "@/lib/tfl/normalize";
import {
  resolveStationCandidates,
  stationKeyFor,
  type StationCandidate,
  type StationResolverDeps,
} from "@/lib/tfl/station-resolver";
import { hashJson, normalizeStationName } from "@/lib/utils/text";

/**
 * The collector.
 *
 * Ordering matters and is deliberate:
 *
 *   network (fetch feed)  ->  pure (normalise)  ->  network (resolve stations)
 *   ->  ONE transaction (advisory lock + every write)
 *
 * The spec puts the fetch inside the transaction. It is moved out here because
 * holding a Postgres transaction open across a 15-second network timeout starves
 * the connection pool — and on a hosted pooler it will eventually deadlock the
 * app. Every guarantee the spec asks for is preserved: all writes are atomic,
 * only one poll runs at a time, the loser gets HTTP 409, and a failed fetch is
 * recorded without ever closing an outage.
 *
 * The single most important invariant in this file: NOTHING CLOSES AN OUTAGE
 * unless a poll genuinely succeeded and genuinely did not contain it, twice.
 */

/** Number of consecutive successful polls an outage must be absent from. */
export const MISSING_POLLS_BEFORE_CLOSURE = 2;

/** Postgres advisory lock id for "tfl-lift-poll" (31-bit, stable across runs). */
export const POLL_ADVISORY_LOCK_KEY = 1_869_506_676;

export class PollLockedError extends Error {
  constructor() {
    super("Another poll is already running (advisory lock held).");
    this.name = "PollLockedError";
  }
}

export type PollOutcome = {
  ok: boolean;
  pollRunId: string;
  status: PollStatus;
  itemsReceived: number;
  normalizedItems: number;
  newOutages: number;
  updatedOutages: number;
  resolvedOutages: number;
  unresolvedStations: number;
  durationMs: number;
  errorMessage: string | null;
};

export type RunPollOptions = {
  prisma?: PrismaClient;
  fetchLiftDisruptionsImpl?: typeof fetchLiftDisruptions;
  resolver?: Partial<StationResolverDeps>;
  now?: () => Date;
  /** Interactive-transaction budget; generous because a poll writes in bulk. */
  transactionTimeoutMs?: number;
};

type PendingObservation = {
  outageId: string;
  pollRunId: string;
  observedAt: Date;
  message: string;
  payloadHash: string;
  rawPayload: Prisma.InputJsonValue;
};

function asJson(value: unknown): Prisma.InputJsonValue {
  return (value ?? {}) as Prisma.InputJsonValue;
}

/**
 * Take the advisory lock for the duration of this transaction. Transaction-scoped
 * locks are released automatically on commit OR rollback, so a crashed poll can
 * never wedge the collector.
 */
async function acquireAdvisoryLock(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(${POLL_ADVISORY_LOCK_KEY}::bigint) AS locked
  `;
  return rows[0]?.locked === true;
}

/** Find a free slug, e.g. "bank" then "bank-2". */
async function ensureUniqueSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;

  // Bounded: station names collide at most a handful of times in practice.
  while (suffix < 50) {
    const clash = await tx.station.findUnique({ where: { slug: candidate } });
    if (!clash) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  return `${base}-${Date.now()}`;
}

async function persistStation(
  tx: Prisma.TransactionClient,
  candidate: StationCandidate,
  seenAt: Date,
): Promise<string> {
  if (candidate.existingStationId) {
    await tx.station.update({
      where: { id: candidate.existingStationId },
      data: { lastSeenAt: seenAt },
    });
    return candidate.existingStationId;
  }

  const slug = await ensureUniqueSlug(tx, candidate.slug);

  const station = await tx.station.create({
    data: {
      tflStationId: candidate.tflStationId,
      naptanId: candidate.naptanId,
      name: candidate.name,
      slug,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      modes: candidate.modes,
      lines: candidate.lines,
      resolutionStatus: candidate.resolutionStatus,
      metadataSource: candidate.metadataSource,
      rawMetadata: asJson(candidate.rawMetadata),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    },
  });

  // Remember how this station was named so a future feed wording change still
  // lands on the same row.
  const alias = normalizeStationName(candidate.name);
  if (alias.length > 0) {
    await tx.stationAlias.createMany({
      data: [{ alias, stationId: station.id }],
      skipDuplicates: true,
    });
  }

  return station.id;
}

async function persistLift(
  tx: Prisma.TransactionClient,
  stationId: string,
  disruption: NormalizedLiftDisruption,
  seenAt: Date,
): Promise<string | null> {
  if (!disruption.liftSourceId) return null;

  const lift = await tx.lift.upsert({
    where: {
      stationId_tflLiftId: { stationId, tflLiftId: disruption.liftSourceId },
    },
    create: {
      stationId,
      tflLiftId: disruption.liftSourceId,
      displayName: disruption.liftName,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      rawMetadata: asJson({ source: "disruption-feed" }),
    },
    update: {
      lastSeenAt: seenAt,
      // Only fill a missing name; never overwrite richer topology-import data.
      ...(disruption.liftName ? { displayName: disruption.liftName } : {}),
    },
  });

  return lift.id;
}

/**
 * Choose the outage start. TfL's v2 feed carries no timestamps today, so this
 * is virtually always the poll time — an upper bound on the true failure time,
 * which the UI and methodology page state plainly.
 */
export function chooseOpenedAt(
  sourceStartedAt: Date | null,
  pollTimestamp: Date,
): { openedAt: Date; usedSource: boolean } {
  if (sourceStartedAt && sourceStartedAt.getTime() <= pollTimestamp.getTime()) {
    return { openedAt: sourceStartedAt, usedSource: true };
  }
  return { openedAt: pollTimestamp, usedSource: false };
}

export async function runPoll(options: RunPollOptions = {}): Promise<PollOutcome> {
  const prisma = options.prisma ?? defaultPrisma;
  const fetchImpl = options.fetchLiftDisruptionsImpl ?? fetchLiftDisruptions;
  const now = options.now ?? (() => new Date());
  const transactionTimeoutMs = options.transactionTimeoutMs ?? 60_000;

  const startedAt = now();

  // ---------------------------------------------------------------- fetch ---
  let payload: unknown;
  let httpStatus: number | null = null;
  let responseHash: string | null = null;

  try {
    const response = await fetchImpl();
    payload = response.payload;
    httpStatus = response.httpStatus;
    responseHash = response.responseHash;
  } catch (error) {
    return recordFailedPoll(prisma, {
      startedAt,
      completedAt: now(),
      httpStatus: error instanceof TflRequestError ? error.httpStatus : null,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  // ------------------------------------------------------------ normalise ---
  let normalized;
  try {
    normalized = normalizeFeed(payload);
  } catch (error) {
    if (error instanceof FeedShapeError) {
      return recordFailedPoll(prisma, {
        startedAt,
        completedAt: now(),
        httpStatus,
        responseHash,
        errorMessage: error.message,
      });
    }
    throw error;
  }

  const partial = isPartialResult(normalized);
  const status = partial ? PollStatus.PARTIAL : PollStatus.SUCCESS;

  // --------------------------------------------------- resolve stations -----
  // Network work, deliberately outside the transaction.
  const stationCandidates = await resolveStationCandidates(normalized.items, {
    prisma,
    ...options.resolver,
  });

  // -------------------------------------------------------- write phase -----
  const pollTimestamp = startedAt;
  let newOutages = 0;
  let updatedOutages = 0;
  let resolvedOutages = 0;

  const result = await prisma.$transaction(
    async (tx) => {
      const locked = await acquireAdvisoryLock(tx);
      if (!locked) throw new PollLockedError();

      const pollRun = await tx.pollRun.create({
        data: {
          startedAt,
          status,
          httpStatus,
          itemCount: normalized.recordCount,
          normalizedItemCount: normalized.items.length,
          responseHash,
          errorMessage: partial
            ? `${normalized.failures.length} of ${normalized.recordCount} records failed validation; ` +
              "closures skipped for this poll."
            : null,
        },
      });

      const stationIdByKey = new Map<string, string>();
      const observations: PendingObservation[] = [];
      const seenAssetKeys = new Set<string>();

      for (const disruption of normalized.items) {
        const key = stationKeyFor(disruption);
        const candidate = stationCandidates.get(key);
        if (!candidate) continue; // unreachable: every item produced a candidate

        let stationId = stationIdByKey.get(key);
        if (!stationId) {
          stationId = await persistStation(tx, candidate, pollTimestamp);
          stationIdByKey.set(key, stationId);
        }

        const liftId = await persistLift(tx, stationId, disruption, pollTimestamp);
        const assetKey = buildAssetKey(disruption);
        seenAssetKeys.add(assetKey);

        const existing = await tx.outage.findFirst({
          where: { assetKey, closedAt: null },
        });

        const rawPayload = asJson(disruption.raw);
        const payloadHash = hashJson(disruption.raw);

        if (existing) {
          // --- still disrupted: refresh, and cancel any pending closure ---
          await tx.outage.update({
            where: { id: existing.id },
            data: {
              lastSeenAt: pollTimestamp,
              latestMessage: disruption.message,
              rawLatest: rawPayload,
              missingSuccessfulPolls: 0,
              firstMissingAt: null,
              // A lift can move under a station only if resolution improved.
              ...(liftId && !existing.liftId ? { liftId } : {}),
            },
          });
          updatedOutages += 1;

          observations.push({
            outageId: existing.id,
            pollRunId: pollRun.id,
            observedAt: pollTimestamp,
            message: disruption.message,
            payloadHash,
            rawPayload,
          });
          continue;
        }

        // --- newly observed disruption ---------------------------------
        const { openedAt } = chooseOpenedAt(disruption.sourceStartedAt, pollTimestamp);

        const created = await tx.outage.create({
          data: {
            stationId,
            liftId,
            assetKey,
            state: OutageState.OPEN,
            openedAt,
            firstSeenAt: pollTimestamp,
            lastSeenAt: pollTimestamp,
            missingSuccessfulPolls: 0,
            sourceEventId: disruption.sourceEventId,
            firstMessage: disruption.message,
            latestMessage: disruption.message,
            sourceStartedAt: disruption.sourceStartedAt,
            rawFirst: rawPayload,
            rawLatest: rawPayload,
          },
        });
        newOutages += 1;

        observations.push({
          outageId: created.id,
          pollRunId: pollRun.id,
          observedAt: pollTimestamp,
          message: disruption.message,
          payloadHash,
          rawPayload,
        });
      }

      if (observations.length > 0) {
        await tx.outageObservation.createMany({ data: observations, skipDuplicates: true });
      }

      // ------------------------------------------------ closure pass -------
      // Skipped entirely when the poll was not fully trustworthy. Absence of
      // evidence is not evidence of repair.
      if (!partial) {
        const openOutages = await tx.outage.findMany({ where: { closedAt: null } });

        for (const outage of openOutages) {
          if (seenAssetKeys.has(outage.assetKey)) continue;

          const missingCount = outage.missingSuccessfulPolls + 1;
          const firstMissingAt = outage.firstMissingAt ?? pollTimestamp;

          if (missingCount >= MISSING_POLLS_BEFORE_CLOSURE) {
            await tx.outage.update({
              where: { id: outage.id },
              data: {
                state: OutageState.RESOLVED,
                closedAt: firstMissingAt,
                closureInferred: true,
                missingSuccessfulPolls: missingCount,
                firstMissingAt,
              },
            });
            resolvedOutages += 1;
          } else {
            await tx.outage.update({
              where: { id: outage.id },
              data: { missingSuccessfulPolls: missingCount, firstMissingAt },
            });
          }
        }
      }

      const completedAt = now();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      await tx.pollRun.update({
        where: { id: pollRun.id },
        data: { completedAt, durationMs },
      });

      const unresolvedStations = [...stationCandidates.values()].filter(
        (candidate) => candidate.resolutionStatus === ResolutionStatus.UNRESOLVED,
      ).length;

      return {
        pollRunId: pollRun.id,
        durationMs,
        unresolvedStations,
      };
    },
    { timeout: transactionTimeoutMs, maxWait: 10_000 },
  );

  return {
    ok: true,
    pollRunId: result.pollRunId,
    status,
    itemsReceived: normalized.recordCount,
    normalizedItems: normalized.items.length,
    newOutages,
    updatedOutages,
    resolvedOutages,
    unresolvedStations: result.unresolvedStations,
    durationMs: result.durationMs,
    errorMessage: partial
      ? `${normalized.failures.length} of ${normalized.recordCount} records failed validation`
      : null,
  };
}

async function recordFailedPoll(
  prisma: PrismaClient,
  input: {
    startedAt: Date;
    completedAt: Date;
    httpStatus?: number | null;
    responseHash?: string | null;
    errorMessage: string;
  },
): Promise<PollOutcome> {
  const durationMs = input.completedAt.getTime() - input.startedAt.getTime();

  const pollRun = await prisma.pollRun.create({
    data: {
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: PollStatus.FAILED,
      httpStatus: input.httpStatus ?? null,
      responseHash: input.responseHash ?? null,
      durationMs,
      errorMessage: input.errorMessage,
    },
  });

  return {
    ok: false,
    pollRunId: pollRun.id,
    status: PollStatus.FAILED,
    itemsReceived: 0,
    normalizedItems: 0,
    newOutages: 0,
    updatedOutages: 0,
    resolvedOutages: 0,
    unresolvedStations: 0,
    durationMs,
    errorMessage: input.errorMessage,
  };
}
