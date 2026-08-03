import {
  LiftDisruptionRecordSchema,
  LiftDisruptionCollectionSchema,
  type LiftDisruptionRecord,
} from "@/lib/tfl/schema";
import { messageSignature, normalizeStationName, normalizeText } from "@/lib/utils/text";

/**
 * Adapter from the raw TfL payload to our internal shape.
 *
 * Written against the real feed: each record carries a station id, zero or more
 * disrupted lift ids, and a free-text message. Nothing else — no timestamps, no
 * coordinates, no event id. The optional fields below stay in the type because
 * the shape is a contract with the rest of the app, and because TfL may enrich
 * v2 later; they are simply null today.
 */

export type NormalizedLiftDisruption = {
  sourceEventId: string | null;
  stationSourceId: string | null;
  stationName: string;
  liftSourceId: string | null;
  liftName: string | null;
  message: string;
  sourceStartedAt: Date | null;
  sourceUpdatedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  raw: unknown;
};

export type NormalizationFailure = {
  index: number;
  reason: string;
  raw: unknown;
};

export type NormalizationResult = {
  items: NormalizedLiftDisruption[];
  failures: NormalizationFailure[];
  /** Number of records in the feed, NOT the number of fanned-out lift entries. */
  recordCount: number;
};

/** Fraction of unparseable records above which a poll is treated as PARTIAL. */
export const MAX_NORMALIZATION_FAILURE_RATIO = 0.2;

/**
 * Parse a TfL date string. Returns null for absent, malformed or nonsense
 * values so a bad timestamp can never become an outage start.
 */
export function parseTflDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  // TfL has been known to emit 0001-01-01 as a null sentinel.
  if (parsed.getUTCFullYear() < 1990) return null;

  return parsed;
}

const MONTH_INDEX: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Pull a start date out of TfL's own wording, e.g.
 * "From Monday 10 March until Autumn 2026" -> 10 March.
 *
 * This is TfL's claim about when the fault began, not our measurement, and it
 * is the only start information the API ever gives us — the structured feed has
 * no timestamps at all. Deliberately conservative: it matches only an explicit
 * "from <day> <month>" phrase, and rejects anything that lands in the future.
 *
 * The year is inferred, because TfL usually omits it: assume the most recent
 * occurrence of that day and month at or before the reference date.
 */
export function parseStatedStartDate(message: string, reference: Date = new Date()): Date | null {
  const match = message.match(
    new RegExp(
      String.raw`\bfrom\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\s+(\d{1,2})(?:st|nd|rd|th)?\s+(${Object.keys(MONTH_INDEX).join("|")})\b`,
      "i",
    ),
  );

  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTH_INDEX[(match[2] as string).toLowerCase()];
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) return null;

  let candidate = new Date(Date.UTC(reference.getUTCFullYear(), month, day));

  // TfL rarely writes the year; a date ahead of now must belong to last year.
  if (candidate.getTime() > reference.getTime()) {
    candidate = new Date(Date.UTC(reference.getUTCFullYear() - 1, month, day));
  }

  // Guard against a nonsense parse such as "31 February" rolling over.
  if (candidate.getUTCDate() !== day || candidate.getUTCMonth() !== month) return null;

  return candidate;
}

/**
 * Derive a human station name from the message, which conventionally begins
 * "STATION NAME: ..." or "Station Name - ...". This is only a fallback label:
 * station resolution replaces it with the official StopPoint name.
 */
export function stationNameFromMessage(message: string): string | null {
  const separatorIndex = message.search(/[:–—-]/);
  if (separatorIndex <= 0 || separatorIndex > 60) return null;

  const candidate = message.slice(0, separatorIndex).trim();
  if (candidate.length < 3) return null;
  // A prefix containing sentence punctuation is prose, not a name.
  if (/[.!?;]/.test(candidate)) return null;
  if (/\d{2,}/.test(candidate)) return null;

  return titleCaseStationName(candidate);
}

/** "WEMBLEY PARK STATION" -> "Wembley Park Station"; leaves mixed case alone. */
export function titleCaseStationName(input: string): string {
  const cleaned = input.replace(/\s+/g, " ").trim();
  const isShouting = cleaned === cleaned.toUpperCase();
  if (!isShouting) return cleaned;

  return cleaned
    .toLowerCase()
    .split(" ")
    .map((word) => {
      if (word.length === 0) return word;
      // Keep short connectives lowercase unless they lead.
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ")
    .replace(/\b(And|Of|The|At)\b/g, (match) => match.toLowerCase())
    .replace(/^(\w)/, (match) => match.toUpperCase());
}

/**
 * "940GZZLUWYP-Lift-5" -> "Lift 5", "HUBKGX-Lift-A" -> "Lift A".
 * Falls back to the raw id when it does not follow the convention.
 */
export function liftNameFromId(liftId: string, stationId: string | null): string | null {
  const trimmed = liftId.trim();
  if (trimmed.length === 0) return null;

  let remainder = trimmed;
  if (stationId && trimmed.toLowerCase().startsWith(`${stationId.toLowerCase()}-`)) {
    remainder = trimmed.slice(stationId.length + 1);
  }

  const words = remainder.split(/[-_]/).filter(Boolean);
  if (words.length === 0) return trimmed;

  return words
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Stable identity for one physical lift, in the priority order required by the
 * spec. The message is never the primary key because TfL rewords updates during
 * a single outage; it is only the last resort.
 */
export function buildAssetKey(disruption: NormalizedLiftDisruption): string {
  const { liftSourceId, stationSourceId, liftName, stationName, message } = disruption;

  // 1. A real lift id from TfL — by far the best case.
  if (liftSourceId && liftSourceId.trim().length > 0) {
    return `lift:${liftSourceId.trim().toLowerCase()}`;
  }

  const normalizedLift = liftName ? normalizeText(liftName) : "";

  // 2. Station id plus lift name.
  if (stationSourceId && stationSourceId.trim().length > 0 && normalizedLift.length > 0) {
    return `station:${stationSourceId.trim().toLowerCase()}|lift:${normalizedLift}`;
  }

  const normalizedStation = normalizeStationName(stationName);

  // 3. Station name plus lift name.
  if (normalizedLift.length > 0) {
    return `stationname:${normalizedStation}|lift:${normalizedLift}`;
  }

  // 4. Station plus a date-insensitive fingerprint of the message.
  if (stationSourceId && stationSourceId.trim().length > 0) {
    return `station:${stationSourceId.trim().toLowerCase()}|msg:${messageSignature(message)}`;
  }

  return `stationname:${normalizedStation}|msg:${messageSignature(message)}`;
}

/**
 * Expand one feed record into one disruption per affected lift.
 *
 * A single record routinely lists several lifts (Bank listed four), and each is
 * a distinct physical asset with its own history, so they must not be collapsed
 * into one outage. A record with no lift ids becomes a single station-level
 * entry with a null lift.
 */
export function normalizeRecord(record: LiftDisruptionRecord): NormalizedLiftDisruption[] {
  const stationSourceId = record.stationUniqueId.trim() || null;
  const stationName =
    record.stationName?.trim() ||
    stationNameFromMessage(record.message) ||
    stationSourceId ||
    "Unknown station";

  const base = {
    sourceEventId: record.id?.trim() || null,
    stationSourceId,
    stationName,
    message: record.message.trim(),
    sourceStartedAt: parseTflDate(record.startDateTime),
    sourceUpdatedAt: parseTflDate(record.lastUpdateDateTime),
    latitude: typeof record.lat === "number" && Number.isFinite(record.lat) ? record.lat : null,
    longitude: typeof record.lon === "number" && Number.isFinite(record.lon) ? record.lon : null,
    raw: record,
  } satisfies Omit<NormalizedLiftDisruption, "liftSourceId" | "liftName">;

  const liftIds = [...new Set(record.disruptedLiftUniqueIds.map((id) => id.trim()).filter(Boolean))];

  if (liftIds.length === 0) {
    return [
      {
        ...base,
        liftSourceId: null,
        liftName: record.liftName?.trim() || null,
      },
    ];
  }

  return liftIds.map((liftId) => ({
    ...base,
    liftSourceId: liftId,
    liftName: record.liftName?.trim() || liftNameFromId(liftId, stationSourceId),
    // Each lift gets its own copy of the record it came from, so the archived
    // raw payload always explains that specific row.
    raw: { ...record, _normalizedLiftUniqueId: liftId },
  }));
}

/**
 * Validate and normalise a whole feed response.
 *
 * Records are validated individually: one malformed entry must not discard the
 * other twenty. The caller compares `failures.length / recordCount` against
 * MAX_NORMALIZATION_FAILURE_RATIO to decide whether the poll is trustworthy
 * enough to close outages.
 */
export function normalizeFeed(payload: unknown): NormalizationResult {
  const collection = LiftDisruptionCollectionSchema.safeParse(payload);

  if (!collection.success) {
    throw new FeedShapeError(
      "TfL lift disruption feed was not a JSON array — refusing to interpret it.",
    );
  }

  const items: NormalizedLiftDisruption[] = [];
  const failures: NormalizationFailure[] = [];

  collection.data.forEach((rawRecord, index) => {
    const parsed = LiftDisruptionRecordSchema.safeParse(rawRecord);

    if (!parsed.success) {
      failures.push({
        index,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
        raw: rawRecord,
      });
      return;
    }

    try {
      items.push(...normalizeRecord(parsed.data));
    } catch (error) {
      failures.push({
        index,
        reason: error instanceof Error ? error.message : String(error),
        raw: rawRecord,
      });
    }
  });

  return { items, failures, recordCount: collection.data.length };
}

/** Thrown when the payload is not even the right shape to interpret. */
export class FeedShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedShapeError";
  }
}

/** True when too many records failed to parse for the poll to be authoritative. */
export function isPartialResult(result: NormalizationResult): boolean {
  if (result.recordCount === 0) return false;
  return result.failures.length / result.recordCount > MAX_NORMALIZATION_FAILURE_RATIO;
}
