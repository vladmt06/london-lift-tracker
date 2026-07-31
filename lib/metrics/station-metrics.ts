import { PollStatus, ResolutionStatus, type Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import {
  DAY_MS,
  MINUTE_MS,
  median,
  mergedDurationMs,
  minutesSince,
  outageDurationMs,
  outagesToIntervals,
  sumOutageDurations,
} from "@/lib/metrics/duration";

/**
 * Read-side aggregation.
 *
 * Metrics are computed in TypeScript rather than SQL because the duration of an
 * ACTIVE outage depends on "now", and because the data is small (tens of open
 * outages, low thousands of rows per year). Correctness and testability matter
 * more than shaving milliseconds here; if this ever grows, the aggregation is
 * pure and can move into SQL without changing the API.
 *
 * Every number returned is "observed since collection began" — never a claim
 * about outages that happened before this app existed.
 */

export type FeedHealthStatus = "healthy" | "delayed" | "stale" | "unavailable";

export type FeedHealth = {
  status: FeedHealthStatus;
  lastSuccessfulPollAt: Date | null;
  minutesSinceSuccess: number | null;
  lastAttemptAt: Date | null;
  lastAttemptStatus: PollStatus | null;
  collectionStartedAt: Date | null;
  successfulPollCount: number;
  failedPollsLast24h: number;
};

export type ActiveOutageView = {
  id: string;
  stationId: string;
  stationName: string;
  stationSlug: string;
  latitude: number | null;
  longitude: number | null;
  liftName: string | null;
  message: string;
  openedAt: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  durationMs: number;
  /** True when the outage was already running at our very first poll. */
  ongoingAtCollectionStart: boolean;
};

export type ResolvedOutageView = ActiveOutageView & {
  closedAt: Date;
  closureInferred: boolean;
};

export type StationSummary = {
  id: string;
  name: string;
  slug: string;
  latitude: number | null;
  longitude: number | null;
  modes: string[];
  lines: string[];
  resolutionStatus: ResolutionStatus;
  activeOutages: number;
  observedOutageCount: number;
  /** Sum over lifts: two lifts down for an hour counts as two lift-hours. */
  observedDowntimeMs: number;
  /** Overlaps merged: "time with at least one lift disrupted". */
  atLeastOneLiftDisruptedMs: number;
  medianResolvedMs: number | null;
  longestResolvedMs: number | null;
  lastObservedDisruptionAt: Date | null;
  hasOngoingSinceCollectionStart: boolean;
};

type Db = Pick<PrismaClient, "pollRun" | "outage" | "station">;

const outageWithRelations = {
  include: {
    station: true,
    lift: true,
  },
} satisfies Prisma.OutageDefaultArgs;

type OutageWithRelations = Prisma.OutageGetPayload<typeof outageWithRelations>;

/** Timestamp of the first successful poll: the start of everything we can claim. */
export async function getCollectionStartedAt(prisma: Db = defaultPrisma): Promise<Date | null> {
  const first = await prisma.pollRun.findFirst({
    where: { status: { in: [PollStatus.SUCCESS, PollStatus.PARTIAL] } },
    orderBy: { startedAt: "asc" },
    select: { startedAt: true },
  });

  return first?.startedAt ?? null;
}

export function classifyFeedHealth(
  lastSuccessfulPollAt: Date | null,
  now: Date = new Date(),
): FeedHealthStatus {
  if (!lastSuccessfulPollAt) return "unavailable";

  const minutes = minutesSince(lastSuccessfulPollAt, now);
  if (minutes < 10) return "healthy";
  if (minutes <= 20) return "delayed";
  return "stale";
}

export async function getFeedHealth(
  prisma: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<FeedHealth> {
  const [lastSuccess, lastAttempt, firstSuccess, successfulPollCount, failedPollsLast24h] =
    await Promise.all([
      prisma.pollRun.findFirst({
        where: { status: PollStatus.SUCCESS },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      }),
      prisma.pollRun.findFirst({
        orderBy: { startedAt: "desc" },
        select: { startedAt: true, status: true },
      }),
      prisma.pollRun.findFirst({
        where: { status: { in: [PollStatus.SUCCESS, PollStatus.PARTIAL] } },
        orderBy: { startedAt: "asc" },
        select: { startedAt: true },
      }),
      prisma.pollRun.count({ where: { status: PollStatus.SUCCESS } }),
      prisma.pollRun.count({
        where: {
          status: PollStatus.FAILED,
          startedAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      }),
    ]);

  const lastSuccessfulPollAt = lastSuccess?.startedAt ?? null;

  return {
    status: classifyFeedHealth(lastSuccessfulPollAt, now),
    lastSuccessfulPollAt,
    minutesSinceSuccess: lastSuccessfulPollAt ? minutesSince(lastSuccessfulPollAt, now) : null,
    lastAttemptAt: lastAttempt?.startedAt ?? null,
    lastAttemptStatus: lastAttempt?.status ?? null,
    collectionStartedAt: firstSuccess?.startedAt ?? null,
    successfulPollCount,
    failedPollsLast24h,
  };
}

function toOutageView(
  outage: OutageWithRelations,
  collectionStartedAt: Date | null,
  now: Date,
): ActiveOutageView {
  return {
    id: outage.id,
    stationId: outage.stationId,
    stationName: outage.station.name,
    stationSlug: outage.station.slug,
    latitude: outage.station.latitude,
    longitude: outage.station.longitude,
    liftName: outage.lift?.displayName ?? outage.lift?.tflLiftId ?? null,
    message: outage.latestMessage,
    openedAt: outage.openedAt,
    firstSeenAt: outage.firstSeenAt,
    lastSeenAt: outage.lastSeenAt,
    durationMs: outageDurationMs(outage, now),
    ongoingAtCollectionStart: Boolean(
      collectionStartedAt &&
        outage.firstSeenAt.getTime() - collectionStartedAt.getTime() < MINUTE_MS,
    ),
  };
}

export async function getActiveOutages(
  prisma: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<ActiveOutageView[]> {
  const collectionStartedAt = await getCollectionStartedAt(prisma);

  const outages = await prisma.outage.findMany({
    where: { closedAt: null },
    ...outageWithRelations,
    orderBy: { openedAt: "asc" },
  });

  return outages
    .map((outage) => toOutageView(outage, collectionStartedAt, now))
    .sort((a, b) => b.durationMs - a.durationMs);
}

export async function getRecentlyResolvedOutages(
  prisma: Db = defaultPrisma,
  now: Date = new Date(),
  windowMs: number = DAY_MS,
): Promise<ResolvedOutageView[]> {
  const collectionStartedAt = await getCollectionStartedAt(prisma);

  const outages = await prisma.outage.findMany({
    where: { closedAt: { gte: new Date(now.getTime() - windowMs) } },
    ...outageWithRelations,
    orderBy: { closedAt: "desc" },
  });

  return outages.map((outage) => ({
    ...toOutageView(outage, collectionStartedAt, now),
    closedAt: outage.closedAt as Date,
    closureInferred: outage.closureInferred,
  }));
}

/** Aggregate one station's outages into the numbers the UI shows. */
export function summariseStation(
  station: {
    id: string;
    name: string;
    slug: string;
    latitude: number | null;
    longitude: number | null;
    modes: string[];
    lines: string[];
    resolutionStatus: ResolutionStatus;
  },
  outages: Array<{
    openedAt: Date;
    closedAt: Date | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
  }>,
  collectionStartedAt: Date | null,
  now: Date = new Date(),
): StationSummary {
  const resolved = outages.filter((outage) => outage.closedAt !== null);
  const resolvedDurations = resolved.map((outage) => outageDurationMs(outage, now));

  const lastObservedDisruptionAt = outages.reduce<Date | null>((latest, outage) => {
    if (!latest || outage.lastSeenAt > latest) return outage.lastSeenAt;
    return latest;
  }, null);

  return {
    ...station,
    activeOutages: outages.filter((outage) => outage.closedAt === null).length,
    observedOutageCount: outages.length,
    observedDowntimeMs: sumOutageDurations(outages, now),
    atLeastOneLiftDisruptedMs: mergedDurationMs(outagesToIntervals(outages, now)),
    medianResolvedMs: median(resolvedDurations),
    longestResolvedMs: resolvedDurations.length > 0 ? Math.max(...resolvedDurations) : null,
    lastObservedDisruptionAt,
    hasOngoingSinceCollectionStart: outages.some(
      (outage) =>
        outage.closedAt === null &&
        collectionStartedAt !== null &&
        outage.firstSeenAt.getTime() - collectionStartedAt.getTime() < MINUTE_MS,
    ),
  };
}

export async function getStationSummaries(
  prisma: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<StationSummary[]> {
  const [collectionStartedAt, stations] = await Promise.all([
    getCollectionStartedAt(prisma),
    prisma.station.findMany({
      include: {
        outages: {
          select: { openedAt: true, closedAt: true, firstSeenAt: true, lastSeenAt: true },
        },
      },
      orderBy: { name: "asc" },
    }),
  ]);

  return stations.map((station) =>
    summariseStation(station, station.outages, collectionStartedAt, now),
  );
}

export type StationSortKey =
  | "name"
  | "activeOutages"
  | "observedOutageCount"
  | "observedDowntime"
  | "medianResolved"
  | "longestResolved"
  | "lastObserved";

export type StationQuery = {
  search?: string;
  activeOnly?: boolean;
  minOutages?: number;
  sort?: StationSortKey;
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

function compareNullableNumber(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls always sort last
  if (b === null) return -1;
  return b - a;
}

/**
 * Filter, sort and paginate station summaries.
 *
 * Default order is the one the spec asks for: stations with active outages
 * first, then by most observed downtime.
 */
export function queryStationSummaries(
  summaries: StationSummary[],
  query: StationQuery = {},
): { rows: StationSummary[]; total: number; page: number; pageSize: number } {
  const search = query.search?.trim().toLowerCase();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

  let rows = summaries.filter((summary) => {
    if (query.activeOnly && summary.activeOutages === 0) return false;
    if (query.minOutages !== undefined && summary.observedOutageCount < query.minOutages) {
      return false;
    }
    if (search && search.length > 0) {
      const haystack = `${summary.name} ${summary.lines.join(" ")} ${summary.modes.join(" ")}`;
      if (!haystack.toLowerCase().includes(search)) return false;
    }
    return true;
  });

  const direction = query.direction ?? "desc";
  const sortKey = query.sort;

  rows = [...rows].sort((a, b) => {
    let comparison: number;

    switch (sortKey) {
      case "name":
        comparison = a.name.localeCompare(b.name, "en-GB");
        return direction === "asc" ? comparison : -comparison;
      case "activeOutages":
        comparison = b.activeOutages - a.activeOutages;
        break;
      case "observedOutageCount":
        comparison = b.observedOutageCount - a.observedOutageCount;
        break;
      case "observedDowntime":
        comparison = b.observedDowntimeMs - a.observedDowntimeMs;
        break;
      case "medianResolved":
        comparison = compareNullableNumber(a.medianResolvedMs, b.medianResolvedMs);
        break;
      case "longestResolved":
        comparison = compareNullableNumber(a.longestResolvedMs, b.longestResolvedMs);
        break;
      case "lastObserved":
        comparison = compareNullableNumber(
          a.lastObservedDisruptionAt?.getTime() ?? null,
          b.lastObservedDisruptionAt?.getTime() ?? null,
        );
        break;
      default:
        // Spec default: active outages first, then most observed downtime.
        comparison =
          b.activeOutages - a.activeOutages || b.observedDowntimeMs - a.observedDowntimeMs;
        return comparison !== 0 ? comparison : a.name.localeCompare(b.name, "en-GB");
    }

    if (comparison === 0) return a.name.localeCompare(b.name, "en-GB");
    return direction === "asc" ? -comparison : comparison;
  });

  const total = rows.length;
  const start = (page - 1) * pageSize;

  return { rows: rows.slice(start, start + pageSize), total, page, pageSize };
}

export type StationDetail = {
  summary: StationSummary;
  naptanId: string | null;
  tflStationId: string | null;
  metadataSource: string | null;
  firstSeenAt: Date;
  activeOutages: ActiveOutageView[];
  resolvedOutages: ResolvedOutageView[];
  collectionStartedAt: Date | null;
};

export async function getStationDetail(
  slug: string,
  prisma: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<StationDetail | null> {
  const collectionStartedAt = await getCollectionStartedAt(prisma);

  const station = await prisma.station.findUnique({
    where: { slug },
    include: {
      outages: {
        include: { station: true, lift: true },
        orderBy: { openedAt: "desc" },
      },
    },
  });

  if (!station) return null;

  const summary = summariseStation(station, station.outages, collectionStartedAt, now);

  const activeOutages = station.outages
    .filter((outage) => outage.closedAt === null)
    .map((outage) => toOutageView(outage, collectionStartedAt, now))
    .sort((a, b) => b.durationMs - a.durationMs);

  const resolvedOutages = station.outages
    .filter((outage) => outage.closedAt !== null)
    .map((outage) => ({
      ...toOutageView(outage, collectionStartedAt, now),
      closedAt: outage.closedAt as Date,
      closureInferred: outage.closureInferred,
    }));

  return {
    summary,
    naptanId: station.naptanId,
    tflStationId: station.tflStationId,
    metadataSource: station.metadataSource,
    firstSeenAt: station.firstSeenAt,
    activeOutages,
    resolvedOutages,
    collectionStartedAt,
  };
}

export type DashboardData = {
  feedHealth: FeedHealth;
  collectionStartedAt: Date | null;
  activeOutageCount: number;
  affectedStationCount: number;
  longestActiveOutage: ActiveOutageView | null;
  /**
   * Longest active outage we actually timed from its start. Outages already
   * running when collection began are excluded: we know they are ongoing but
   * not how long they have lasted, so reporting a duration for them would be
   * false precision.
   */
  longestTimedActiveOutage: ActiveOutageView | null;
  ongoingSinceCollectionStartCount: number;
  activeOutages: ActiveOutageView[];
  recentlyResolved: ResolvedOutageView[];
  stationsWithHistory: Array<
    Pick<StationSummary, "id" | "name" | "slug" | "latitude" | "longitude"> & {
      observedOutageCount: number;
      activeOutages: number;
    }
  >;
  topStations: StationSummary[];
  unresolvedStationCount: number;
};

export async function getDashboardData(
  prisma: Db = defaultPrisma,
  now: Date = new Date(),
): Promise<DashboardData> {
  const [feedHealth, activeOutages, recentlyResolved, summaries] = await Promise.all([
    getFeedHealth(prisma, now),
    getActiveOutages(prisma, now),
    getRecentlyResolvedOutages(prisma, now),
    getStationSummaries(prisma, now),
  ]);

  const affectedStationIds = new Set(activeOutages.map((outage) => outage.stationId));

  return {
    feedHealth,
    collectionStartedAt: feedHealth.collectionStartedAt,
    activeOutageCount: activeOutages.length,
    affectedStationCount: affectedStationIds.size,
    longestActiveOutage: activeOutages[0] ?? null,
    longestTimedActiveOutage:
      activeOutages.find((outage) => !outage.ongoingAtCollectionStart) ?? null,
    ongoingSinceCollectionStartCount: activeOutages.filter(
      (outage) => outage.ongoingAtCollectionStart,
    ).length,
    activeOutages,
    recentlyResolved,
    stationsWithHistory: summaries
      .filter((summary) => summary.observedOutageCount > 0)
      .map((summary) => ({
        id: summary.id,
        name: summary.name,
        slug: summary.slug,
        latitude: summary.latitude,
        longitude: summary.longitude,
        observedOutageCount: summary.observedOutageCount,
        activeOutages: summary.activeOutages,
      })),
    topStations: queryStationSummaries(summaries, { pageSize: 8 }).rows,
    unresolvedStationCount: summaries.filter(
      (summary) => summary.resolutionStatus === ResolutionStatus.UNRESOLVED,
    ).length,
  };
}
