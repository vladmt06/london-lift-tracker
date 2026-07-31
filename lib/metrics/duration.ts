/**
 * Duration arithmetic and London-time formatting.
 *
 * Everything is stored and computed in UTC; only display converts to
 * Europe/London, which matters twice a year when the clocks change.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type Interval = { start: Date; end: Date };

export type OutageLike = {
  openedAt: Date;
  closedAt: Date | null;
};

/**
 * How long an outage lasted (resolved) or has lasted so far (active).
 * Never negative: a clock skew must not produce a negative downtime.
 */
export function outageDurationMs(outage: OutageLike, now: Date = new Date()): number {
  const end = outage.closedAt ?? now;
  return Math.max(0, end.getTime() - outage.openedAt.getTime());
}

export function isActive(outage: OutageLike): boolean {
  return outage.closedAt === null;
}

/** Sum of every outage duration, counting each lift separately. */
export function sumOutageDurations(outages: OutageLike[], now: Date = new Date()): number {
  return outages.reduce((total, outage) => total + outageDurationMs(outage, now), 0);
}

/**
 * Median of a numeric list. Returns null for an empty list so callers can show
 * "insufficient data" instead of a misleading zero.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }

  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Merge overlapping or touching intervals.
 *
 * Used ONLY for "time with at least one lift disrupted". Total lift downtime
 * deliberately does not merge: two lifts broken for an hour is two lift-hours.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals]
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (sorted.length === 0) return [];

  const merged: Interval[] = [{ ...(sorted[0] as Interval) }];

  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1] as Interval;

    if (interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

/** Total covered time after merging — "time with at least one lift disrupted". */
export function mergedDurationMs(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce(
    (total, interval) => total + (interval.end.getTime() - interval.start.getTime()),
    0,
  );
}

export function outagesToIntervals(outages: OutageLike[], now: Date = new Date()): Interval[] {
  return outages.map((outage) => ({
    start: outage.openedAt,
    end: outage.closedAt ?? now,
  }));
}

/**
 * Compact duration for tables and cards: "3d 4h", "2h 14m", "48m".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < MINUTE_MS) return "under a minute";

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Spoken form for screen readers: "3 days 4 hours". */
export function formatDurationLong(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < MINUTE_MS) return "under a minute";

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);

  return parts.length > 0 ? parts.join(" ") : "under a minute";
}

export const LONDON_TIME_ZONE = "Europe/London";

/** "31 Jul 2026, 18:45" in London local time. */
export function formatLondonDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "31 July 2026" in London local time. */
export function formatLondonDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** "18:45" in London local time. */
export function formatLondonTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Which UK clock a date falls under — shown so timestamps are unambiguous. */
export function londonTimeZoneAbbreviation(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIME_ZONE,
    timeZoneName: "short",
  }).formatToParts(date);

  return parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
}

/** "4 minutes ago", "2 hours ago", "just now". */
export function formatRelativeToNow(date: Date, now: Date = new Date()): string {
  const deltaMs = now.getTime() - date.getTime();
  if (deltaMs < 0) return "in the future";
  if (deltaMs < MINUTE_MS) return "just now";

  const minutes = Math.floor(deltaMs / MINUTE_MS);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;

  const hours = Math.floor(deltaMs / HOUR_MS);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.floor(deltaMs / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function minutesSince(date: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / MINUTE_MS));
}
