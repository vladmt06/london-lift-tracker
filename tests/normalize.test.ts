import { describe, expect, it } from "vitest";
import realFeed from "@/fixtures/tfl-lift-disruptions.json";
import {
  buildAssetKey,
  isPartialResult,
  liftNameFromId,
  normalizeFeed,
  normalizeRecord,
  parseStatedStartDate,
  parseTflDate,
  stationNameFromMessage,
  titleCaseStationName,
  type NormalizedLiftDisruption,
} from "@/lib/tfl/normalize";
import {
  messageSignature,
  normalizeStationName,
  normalizeText,
  slugify,
  stripVolatileTimeReferences,
} from "@/lib/utils/text";

const record = (
  stationUniqueId: string,
  disruptedLiftUniqueIds: string[],
  message: string,
) => ({ stationUniqueId, disruptedLiftUniqueIds, message });

describe("text normalisation", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeText("  WEMBLEY   PARK  ")).toBe("wembley park");
  });

  it("drops punctuation that does not change meaning", () => {
    expect(normalizeText("King's Cross & St. Pancras!")).toBe("kings cross and st pancras");
  });

  it("removes accents", () => {
    expect(normalizeText("Café Station")).toBe("cafe station");
  });

  it("preserves platform numbers, directions and lift numbers", () => {
    expect(normalizeText("Lift 5 to Platform 3, northbound")).toBe(
      "lift 5 to platform 3 northbound",
    );
  });

  it("collapses station-name variants onto one form", () => {
    expect(normalizeStationName("Wembley Park Underground Station")).toBe("wembley park");
    expect(normalizeStationName("WEMBLEY PARK STATION")).toBe("wembley park");
    expect(normalizeStationName("Wembley Park")).toBe("wembley park");
    expect(normalizeStationName("Camden Road Rail Station")).toBe("camden road");
  });

  it("never normalises a name away to nothing", () => {
    expect(normalizeStationName("Elizabeth line station")).not.toBe("");
  });

  it("produces readable slugs", () => {
    expect(slugify("King's Cross & St Pancras International")).toBe(
      "kings-cross-and-st-pancras-international",
    );
  });
});

describe("volatile time references", () => {
  it("strips dates, clock times and years but keeps lift and platform numbers", () => {
    const stripped = stripVolatileTimeReferences(
      "From Monday 10 March until Autumn 2026, Lift 5 to platform 3 is out at 09:30",
    );

    expect(stripped).not.toContain("monday");
    expect(stripped).not.toContain("march");
    expect(stripped).not.toContain("2026");
    expect(stripped).not.toContain("09:30");
    expect(stripped).toContain("lift 5");
    expect(stripped).toContain("platform 3");
  });

  it("gives the same signature when only the dates change", () => {
    const a = "Lift 5 is unavailable until Monday 10 March 2026";
    const b = "Lift 5 is unavailable until Friday 21 August 2026";

    expect(messageSignature(a)).toBe(messageSignature(b));
  });

  it("gives different signatures for genuinely different faults", () => {
    expect(messageSignature("Lift 5 is unavailable")).not.toBe(
      messageSignature("Lift 6 is unavailable"),
    );
  });
});

describe("date parsing", () => {
  it("parses ISO-8601 timestamps", () => {
    expect(parseTflDate("2026-07-31T10:15:00Z")?.toISOString()).toBe("2026-07-31T10:15:00.000Z");
  });

  it("returns null for absent, blank or nonsense values", () => {
    expect(parseTflDate(undefined)).toBeNull();
    expect(parseTflDate("")).toBeNull();
    expect(parseTflDate("not a date")).toBeNull();
    expect(parseTflDate(12345)).toBeNull();
  });

  it("rejects the 0001-01-01 null sentinel", () => {
    expect(parseTflDate("0001-01-01T00:00:00")).toBeNull();
  });
});

describe("station name recovery from messages", () => {
  it("reads the name from the conventional prefix", () => {
    expect(stationNameFromMessage("WEMBLEY PARK STATION: no lift service")).toBe(
      "Wembley Park Station",
    );
    expect(stationNameFromMessage("Canada Water: No Step Free Access - lift fault")).toBe(
      "Canada Water",
    );
  });

  it("refuses prose that merely contains punctuation", () => {
    expect(
      stationNameFromMessage("The lift is broken. Please use the alternative route: see staff"),
    ).toBeNull();
  });

  it("title-cases shouting but leaves mixed case alone", () => {
    expect(titleCaseStationName("WEMBLEY PARK")).toBe("Wembley Park");
    expect(titleCaseStationName("Canada Water")).toBe("Canada Water");
  });
});

describe("lift names", () => {
  it("derives a readable name from the lift id", () => {
    expect(liftNameFromId("940GZZLUWYP-Lift-5", "940GZZLUWYP")).toBe("Lift 5");
    expect(liftNameFromId("HUBKGX-Lift-A", "HUBKGX")).toBe("Lift A");
  });

  it("keeps an unconventional id intact rather than mangling it", () => {
    expect(liftNameFromId("SOMETHINGELSE", "HUBKGX")).toBe("SOMETHINGELSE");
  });
});

describe("record normalisation", () => {
  it("fans one record out into one disruption per lift", () => {
    const results = normalizeRecord(
      record("HUBBAN", ["HUBBAN-Lift-2", "HUBBAN-Lift-3", "HUBBAN-Lift-4"], "Bank: lifts out"),
    );

    expect(results).toHaveLength(3);
    expect(results.map((item) => item.liftSourceId)).toEqual([
      "HUBBAN-Lift-2",
      "HUBBAN-Lift-3",
      "HUBBAN-Lift-4",
    ]);
    expect(new Set(results.map((item) => buildAssetKey(item))).size).toBe(3);
  });

  it("de-duplicates repeated lift ids inside one record", () => {
    const results = normalizeRecord(
      record("HUBBAN", ["HUBBAN-Lift-2", "HUBBAN-Lift-2"], "Bank: lift out"),
    );

    expect(results).toHaveLength(1);
  });

  it("keeps a station-level entry when no lift ids are given", () => {
    const results = normalizeRecord(record("HUBZCW", [], "Canada Water: no step free access"));

    expect(results).toHaveLength(1);
    expect(results[0]?.liftSourceId).toBeNull();
    expect(results[0]?.stationName).toBe("Canada Water");
  });

  it("has no timestamps or coordinates, because the feed carries none", () => {
    const [item] = normalizeRecord(record("HUBZCW", ["HUBZCW-Lift-1"], "Canada Water: fault"));

    expect(item?.sourceStartedAt).toBeNull();
    expect(item?.sourceUpdatedAt).toBeNull();
    expect(item?.latitude).toBeNull();
    expect(item?.longitude).toBeNull();
  });

  it("preserves the complete raw record", () => {
    const raw = record("HUBZCW", ["HUBZCW-Lift-1"], "Canada Water: fault");
    const [item] = normalizeRecord(raw);

    expect(item?.raw).toMatchObject(raw);
  });
});

describe("asset keys", () => {
  const base: NormalizedLiftDisruption = {
    sourceEventId: null,
    stationSourceId: "940GZZLUWYP",
    stationName: "Wembley Park",
    liftSourceId: "940GZZLUWYP-Lift-5",
    liftName: "Lift 5",
    message: "Lift 5 unavailable",
    sourceStartedAt: null,
    sourceUpdatedAt: null,
    latitude: null,
    longitude: null,
    raw: {},
  };

  it("1. prefers the TfL lift id", () => {
    expect(buildAssetKey(base)).toBe("lift:940gzzluwyp-lift-5");
  });

  it("2. falls back to station id plus lift name", () => {
    expect(buildAssetKey({ ...base, liftSourceId: null })).toBe(
      "station:940gzzluwyp|lift:lift 5",
    );
  });

  it("3. falls back to station name plus lift name", () => {
    expect(buildAssetKey({ ...base, liftSourceId: null, stationSourceId: null })).toBe(
      "stationname:wembley park|lift:lift 5",
    );
  });

  it("4. falls back to a date-insensitive message signature", () => {
    const key = buildAssetKey({ ...base, liftSourceId: null, liftName: null });
    expect(key).toBe(`station:940gzzluwyp|msg:${messageSignature(base.message)}`);
  });

  it("stays stable when TfL rewords the message mid-outage", () => {
    const before = buildAssetKey({ ...base, message: "Lift 5 out of service until 10 March" });
    const after = buildAssetKey({
      ...base,
      message: "Lift 5 remains out of service until 21 August, engineers on site",
    });

    expect(before).toBe(after);
  });

  it("stays stable for message-only identity when just the date moves", () => {
    const stripped = { ...base, liftSourceId: null, liftName: null };
    const before = buildAssetKey({ ...stripped, message: "No lift service until Monday 10 March" });
    const after = buildAssetKey({ ...stripped, message: "No lift service until Friday 21 August" });

    expect(before).toBe(after);
  });

  it("separates different lifts at the same station", () => {
    const liftA = buildAssetKey({ ...base, liftSourceId: "HUBKGX-Lift-A" });
    const liftB = buildAssetKey({ ...base, liftSourceId: "HUBKGX-Lift-B" });

    expect(liftA).not.toBe(liftB);
  });
});

describe("feed normalisation", () => {
  it("rejects a payload that is not an array", () => {
    expect(() => normalizeFeed({ nope: true })).toThrowError(/not a JSON array/i);
  });

  it("accepts an empty feed", () => {
    const result = normalizeFeed([]);

    expect(result.items).toEqual([]);
    expect(result.recordCount).toBe(0);
    expect(isPartialResult(result)).toBe(false);
  });

  it("keeps the good records when one is malformed", () => {
    const good = Array.from({ length: 5 }, (_, index) =>
      record(`STATION${index}`, [`STATION${index}-Lift-1`], `Station ${index}: fault`),
    );

    const result = normalizeFeed([
      ...good,
      { stationUniqueId: "", disruptedLiftUniqueIds: [], message: "" },
    ]);

    expect(result.items).toHaveLength(5);
    expect(result.failures).toHaveLength(1);
    expect(isPartialResult(result)).toBe(false); // 1 of 6 = 17%, under the threshold
  });

  it("flags a poll as partial when more than 20% of records fail", () => {
    const good = Array.from({ length: 4 }, (_, index) =>
      record(`STATION${index}`, [`STATION${index}-Lift-1`], `Station ${index}: fault`),
    );
    const bad = [{ garbage: true }, { alsoGarbage: true }];

    const result = normalizeFeed([...good, ...bad]);

    expect(result.failures).toHaveLength(2);
    expect(isPartialResult(result)).toBe(true); // 2 of 6 = 33% > 20%
  });

  it("does not flag a poll as partial at exactly 20%", () => {
    const good = Array.from({ length: 4 }, (_, index) =>
      record(`STATION${index}`, [`STATION${index}-Lift-1`], `Station ${index}: fault`),
    );

    const result = normalizeFeed([...good, { garbage: true }]);

    expect(isPartialResult(result)).toBe(false); // 1 of 5 = exactly 20%
  });

  it("tolerates unknown fields that TfL might add later", () => {
    const result = normalizeFeed([
      { ...record("HUBZCW", ["HUBZCW-Lift-1"], "Canada Water: fault"), somethingNew: 42 },
    ]);

    expect(result.failures).toHaveLength(0);
    expect(result.items[0]?.raw).toMatchObject({ somethingNew: 42 });
  });
});

describe("the captured real feed", () => {
  it("normalises every record without failures", () => {
    const result = normalizeFeed(realFeed);

    expect(result.recordCount).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    // Fan-out means at least as many lift entries as records.
    expect(result.items.length).toBeGreaterThanOrEqual(result.recordCount);
  });

  it("produces a unique asset key for every disrupted lift", () => {
    const result = normalizeFeed(realFeed);
    const keys = result.items.map(buildAssetKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names every station it saw", () => {
    const result = normalizeFeed(realFeed);

    for (const item of result.items) {
      expect(item.stationName.length).toBeGreaterThan(0);
      expect(item.stationSourceId).toBeTruthy();
    }
  });
});

describe("start dates stated in TfL's own message", () => {
  const reference = new Date("2026-08-03T12:00:00Z");

  it("reads the date out of a 'From <weekday> <day> <month>' phrase", () => {
    const start = parseStatedStartDate(
      "WEMBLEY PARK STATION: From Monday 10 March until Autumn 2026, no lift service.",
      reference,
    );

    expect(start?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
  });

  it("assumes last year when the date has not happened yet this year", () => {
    // "From Monday 15 December" read in August must mean last December.
    const start = parseStatedStartDate("From Monday 15 December, no lift service.", reference);

    expect(start?.getUTCFullYear()).toBe(2025);
    expect(start?.getUTCMonth()).toBe(11);
  });

  it("ignores messages that state no start date", () => {
    expect(
      parseStatedStartDate(
        "Canada Water: No Step Free Access - lift out of service due to a fault.",
        reference,
      ),
    ).toBeNull();
  });

  it("does not mistake an end date for a start date", () => {
    expect(parseStatedStartDate("No lift service until Monday 10 March.", reference)).toBeNull();
  });

  it("rejects a date that does not exist", () => {
    expect(parseStatedStartDate("From Monday 31 February, no lift service.", reference)).toBeNull();
  });
});
