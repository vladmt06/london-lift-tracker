import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  formatDuration,
  formatDurationLong,
  formatLondonDate,
  formatLondonDateTime,
  formatRelativeToNow,
  londonTimeZoneAbbreviation,
  median,
  mergeIntervals,
  mergedDurationMs,
  minutesSince,
  outageDurationMs,
  outagesToIntervals,
  sumOutageDurations,
} from "@/lib/metrics/duration";
import { classifyFeedHealth, queryStationSummaries, summariseStation } from "@/lib/metrics/station-metrics";
import type { StationSummary } from "@/lib/metrics/station-metrics";

const at = (iso: string) => new Date(iso);

describe("outage duration", () => {
  it("measures a resolved outage from open to close", () => {
    expect(
      outageDurationMs({
        openedAt: at("2026-07-31T10:00:00Z"),
        closedAt: at("2026-07-31T12:30:00Z"),
      }),
    ).toBe(2.5 * HOUR_MS);
  });

  it("measures an active outage up to now", () => {
    expect(
      outageDurationMs(
        { openedAt: at("2026-07-31T10:00:00Z"), closedAt: null },
        at("2026-07-31T10:45:00Z"),
      ),
    ).toBe(45 * MINUTE_MS);
  });

  it("never reports a negative duration", () => {
    expect(
      outageDurationMs(
        { openedAt: at("2026-07-31T10:00:00Z"), closedAt: null },
        at("2026-07-31T09:00:00Z"),
      ),
    ).toBe(0);
  });

  it("sums each lift separately, without merging", () => {
    const now = at("2026-07-31T12:00:00Z");
    const outages = [
      { openedAt: at("2026-07-31T10:00:00Z"), closedAt: at("2026-07-31T11:00:00Z") },
      { openedAt: at("2026-07-31T10:00:00Z"), closedAt: at("2026-07-31T11:00:00Z") },
    ];

    expect(sumOutageDurations(outages, now)).toBe(2 * HOUR_MS);
  });
});

describe("median", () => {
  it("returns null for an empty list so callers can say 'insufficient data'", () => {
    expect(median([])).toBeNull();
  });

  it("takes the middle value of an odd-length list", () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it("averages the two middle values of an even-length list", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("interval merging", () => {
  it("merges overlapping intervals", () => {
    const merged = mergeIntervals([
      { start: at("2026-07-31T10:00:00Z"), end: at("2026-07-31T12:00:00Z") },
      { start: at("2026-07-31T11:00:00Z"), end: at("2026-07-31T13:00:00Z") },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.start.toISOString()).toBe("2026-07-31T10:00:00.000Z");
    expect(merged[0]?.end.toISOString()).toBe("2026-07-31T13:00:00.000Z");
  });

  it("merges intervals that merely touch", () => {
    const merged = mergeIntervals([
      { start: at("2026-07-31T10:00:00Z"), end: at("2026-07-31T11:00:00Z") },
      { start: at("2026-07-31T11:00:00Z"), end: at("2026-07-31T12:00:00Z") },
    ]);

    expect(merged).toHaveLength(1);
  });

  it("keeps separate intervals apart", () => {
    const merged = mergeIntervals([
      { start: at("2026-07-31T10:00:00Z"), end: at("2026-07-31T11:00:00Z") },
      { start: at("2026-07-31T14:00:00Z"), end: at("2026-07-31T15:00:00Z") },
    ]);

    expect(merged).toHaveLength(2);
    expect(mergedDurationMs(merged)).toBe(2 * HOUR_MS);
  });

  it("swallows an interval fully contained in another", () => {
    const merged = mergeIntervals([
      { start: at("2026-07-31T10:00:00Z"), end: at("2026-07-31T18:00:00Z") },
      { start: at("2026-07-31T12:00:00Z"), end: at("2026-07-31T13:00:00Z") },
    ]);

    expect(merged).toHaveLength(1);
    expect(mergedDurationMs(merged)).toBe(8 * HOUR_MS);
  });

  it("distinguishes total lift downtime from time with at least one lift down", () => {
    const now = at("2026-07-31T12:00:00Z");
    const outages = [
      { openedAt: at("2026-07-31T10:00:00Z"), closedAt: at("2026-07-31T11:00:00Z") },
      { openedAt: at("2026-07-31T10:00:00Z"), closedAt: at("2026-07-31T11:00:00Z") },
    ];

    expect(sumOutageDurations(outages, now)).toBe(2 * HOUR_MS);
    expect(mergedDurationMs(outagesToIntervals(outages, now))).toBe(HOUR_MS);
  });

  it("handles an empty list", () => {
    expect(mergeIntervals([])).toEqual([]);
    expect(mergedDurationMs([])).toBe(0);
  });
});

describe("duration formatting", () => {
  it("formats compactly", () => {
    expect(formatDuration(30_000)).toBe("under a minute");
    expect(formatDuration(48 * MINUTE_MS)).toBe("48m");
    expect(formatDuration(2 * HOUR_MS + 14 * MINUTE_MS)).toBe("2h 14m");
    expect(formatDuration(3 * DAY_MS + 4 * HOUR_MS)).toBe("3d 4h");
    expect(formatDuration(2 * HOUR_MS)).toBe("2h");
  });

  it("formats a spoken version for screen readers", () => {
    expect(formatDurationLong(2 * HOUR_MS + 14 * MINUTE_MS)).toBe("2 hours 14 minutes");
    expect(formatDurationLong(HOUR_MS + MINUTE_MS)).toBe("1 hour 1 minute");
    expect(formatDurationLong(3 * DAY_MS + 4 * HOUR_MS)).toBe("3 days 4 hours");
  });
});

describe("London time display", () => {
  it("shows British Summer Time in summer", () => {
    const summer = at("2026-07-31T17:45:00Z");

    expect(formatLondonDateTime(summer)).toBe("31 Jul 2026, 18:45");
    expect(londonTimeZoneAbbreviation(summer)).toBe("BST");
  });

  it("shows GMT in winter", () => {
    const winter = at("2026-01-15T17:45:00Z");

    expect(formatLondonDateTime(winter)).toBe("15 Jan 2026, 17:45");
    expect(londonTimeZoneAbbreviation(winter)).toBe("GMT");
  });

  it("puts a late-evening UTC timestamp on the next London day in summer", () => {
    // 23:30 UTC on 30 July is 00:30 on 31 July in London.
    expect(formatLondonDate(at("2026-07-30T23:30:00Z"))).toBe("31 July 2026");
  });

  it("describes recency in plain words", () => {
    const now = at("2026-07-31T12:00:00Z");

    expect(formatRelativeToNow(at("2026-07-31T11:59:30Z"), now)).toBe("just now");
    expect(formatRelativeToNow(at("2026-07-31T11:56:00Z"), now)).toBe("4 minutes ago");
    expect(formatRelativeToNow(at("2026-07-31T11:00:00Z"), now)).toBe("1 hour ago");
    expect(formatRelativeToNow(at("2026-07-29T12:00:00Z"), now)).toBe("2 days ago");
  });

  it("counts whole minutes since a timestamp", () => {
    expect(minutesSince(at("2026-07-31T11:50:30Z"), at("2026-07-31T12:00:00Z"))).toBe(9);
  });
});

describe("feed health classification", () => {
  const now = at("2026-07-31T12:00:00Z");

  it("is unavailable when nothing has succeeded", () => {
    expect(classifyFeedHealth(null, now)).toBe("unavailable");
  });

  it("is healthy under 10 minutes", () => {
    expect(classifyFeedHealth(at("2026-07-31T11:55:00Z"), now)).toBe("healthy");
  });

  it("is delayed between 10 and 20 minutes", () => {
    expect(classifyFeedHealth(at("2026-07-31T11:50:00Z"), now)).toBe("delayed");
    expect(classifyFeedHealth(at("2026-07-31T11:40:00Z"), now)).toBe("delayed");
  });

  it("is stale beyond 20 minutes", () => {
    expect(classifyFeedHealth(at("2026-07-31T11:39:00Z"), now)).toBe("stale");
  });
});

describe("station summaries", () => {
  const station = {
    id: "s1",
    name: "Bank",
    slug: "bank",
    latitude: 51.5,
    longitude: -0.09,
    modes: ["tube"],
    lines: ["Central"],
    resolutionStatus: "RESOLVED" as const,
  };

  const now = at("2026-07-31T12:00:00Z");
  const collectionStart = at("2026-07-30T00:00:00Z");

  it("separates active from resolved and excludes active from the median", () => {
    const summary = summariseStation(
      station,
      [
        {
          openedAt: at("2026-07-31T08:00:00Z"),
          closedAt: at("2026-07-31T10:00:00Z"),
          firstSeenAt: at("2026-07-31T08:00:00Z"),
          lastSeenAt: at("2026-07-31T10:00:00Z"),
        },
        {
          openedAt: at("2026-07-31T09:00:00Z"),
          closedAt: at("2026-07-31T13:00:00Z"),
          firstSeenAt: at("2026-07-31T09:00:00Z"),
          lastSeenAt: at("2026-07-31T13:00:00Z"),
        },
        {
          // Active for 2 hours so far — much shorter than either resolved one,
          // and must not drag the median down.
          openedAt: at("2026-07-31T10:00:00Z"),
          closedAt: null,
          firstSeenAt: at("2026-07-31T10:00:00Z"),
          lastSeenAt: now,
        },
      ],
      collectionStart,
      now,
    );

    expect(summary.activeOutages).toBe(1);
    expect(summary.observedOutageCount).toBe(3);
    expect(summary.medianResolvedMs).toBe(3 * HOUR_MS); // median of 2h and 4h
    expect(summary.longestResolvedMs).toBe(4 * HOUR_MS);
    expect(summary.observedDowntimeMs).toBe(2 * HOUR_MS + 4 * HOUR_MS + 2 * HOUR_MS);
  });

  it("reports insufficient data rather than zero when nothing has resolved", () => {
    const summary = summariseStation(
      station,
      [
        {
          openedAt: at("2026-07-31T10:00:00Z"),
          closedAt: null,
          firstSeenAt: at("2026-07-31T10:00:00Z"),
          lastSeenAt: now,
        },
      ],
      collectionStart,
      now,
    );

    expect(summary.medianResolvedMs).toBeNull();
    expect(summary.longestResolvedMs).toBeNull();
  });

  it("flags outages that were already running when collection began", () => {
    const summary = summariseStation(
      station,
      [
        {
          openedAt: collectionStart,
          closedAt: null,
          firstSeenAt: collectionStart,
          lastSeenAt: now,
        },
      ],
      collectionStart,
      now,
    );

    expect(summary.hasOngoingSinceCollectionStart).toBe(true);
  });

  it("has no metrics at all for a station with no observed outages", () => {
    const summary = summariseStation(station, [], collectionStart, now);

    expect(summary.observedOutageCount).toBe(0);
    expect(summary.observedDowntimeMs).toBe(0);
    expect(summary.medianResolvedMs).toBeNull();
    expect(summary.lastObservedDisruptionAt).toBeNull();
  });
});

describe("station table ordering and filtering", () => {
  const base: StationSummary = {
    id: "x",
    name: "X",
    slug: "x",
    latitude: null,
    longitude: null,
    modes: [],
    lines: [],
    resolutionStatus: "RESOLVED",
    activeOutages: 0,
    observedOutageCount: 0,
    observedDowntimeMs: 0,
    atLeastOneLiftDisruptedMs: 0,
    medianResolvedMs: null,
    longestResolvedMs: null,
    lastObservedDisruptionAt: null,
    hasOngoingSinceCollectionStart: false,
  };

  const summaries: StationSummary[] = [
    { ...base, id: "a", name: "Angel", slug: "angel", observedDowntimeMs: 10 * HOUR_MS, observedOutageCount: 4 },
    { ...base, id: "b", name: "Bank", slug: "bank", activeOutages: 2, observedDowntimeMs: HOUR_MS, observedOutageCount: 2 },
    { ...base, id: "c", name: "Camden", slug: "camden", activeOutages: 1, observedDowntimeMs: 5 * HOUR_MS, observedOutageCount: 1 },
  ];

  it("defaults to active outages first, then most downtime", () => {
    const { rows } = queryStationSummaries(summaries);

    expect(rows.map((row) => row.name)).toEqual(["Bank", "Camden", "Angel"]);
  });

  it("filters to active only", () => {
    const { rows, total } = queryStationSummaries(summaries, { activeOnly: true });

    expect(total).toBe(2);
    expect(rows.every((row) => row.activeOutages > 0)).toBe(true);
  });

  it("filters by minimum observed outages", () => {
    const { rows } = queryStationSummaries(summaries, { minOutages: 3 });

    expect(rows.map((row) => row.name)).toEqual(["Angel"]);
  });

  it("searches by name", () => {
    const { rows } = queryStationSummaries(summaries, { search: "cam" });

    expect(rows.map((row) => row.name)).toEqual(["Camden"]);
  });

  it("sorts by observed downtime when asked", () => {
    const { rows } = queryStationSummaries(summaries, { sort: "observedDowntime" });

    expect(rows.map((row) => row.name)).toEqual(["Angel", "Camden", "Bank"]);
  });

  it("sorts null metrics last regardless of direction", () => {
    const withNulls: StationSummary[] = [
      { ...base, id: "1", name: "Has median", slug: "has", medianResolvedMs: HOUR_MS },
      { ...base, id: "2", name: "No median", slug: "no", medianResolvedMs: null },
    ];

    expect(
      queryStationSummaries(withNulls, { sort: "medianResolved" }).rows.map((row) => row.name),
    ).toEqual(["Has median", "No median"]);
  });

  it("paginates", () => {
    const { rows, total, page } = queryStationSummaries(summaries, { page: 2, pageSize: 2 });

    expect(total).toBe(3);
    expect(page).toBe(2);
    expect(rows).toHaveLength(1);
  });
});

describe("outages that predate collection", () => {
  const at = (iso: string) => new Date(iso);
  const collectionStart = at("2026-07-31T09:00:00Z");
  const now = at("2026-07-31T09:35:00Z");

  const station = {
    id: "s1",
    name: "Wembley Park",
    slug: "wembley-park",
    latitude: 51.56,
    longitude: -0.28,
    modes: ["tube"],
    lines: ["Jubilee"],
    resolutionStatus: "RESOLVED" as const,
  };

  it("flags an outage present at the very first poll", () => {
    // A lift broken since March looks identical to one broken at 09:00 — the
    // feed carries no start time — so it must be flagged, not timed.
    const summary = summariseStation(
      station,
      [
        {
          openedAt: collectionStart,
          closedAt: null,
          firstSeenAt: collectionStart,
          lastSeenAt: now,
        },
      ],
      collectionStart,
      now,
    );

    expect(summary.hasOngoingSinceCollectionStart).toBe(true);
    // 35 minutes of watching is NOT the outage's length; it is a lower bound.
    expect(summary.observedDowntimeMs).toBe(35 * MINUTE_MS);
  });

  it("does not flag an outage that began while we were watching", () => {
    const summary = summariseStation(
      station,
      [
        {
          openedAt: at("2026-07-31T09:20:00Z"),
          closedAt: null,
          firstSeenAt: at("2026-07-31T09:20:00Z"),
          lastSeenAt: now,
        },
      ],
      collectionStart,
      now,
    );

    expect(summary.hasOngoingSinceCollectionStart).toBe(false);
  });
});
