import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ResolutionStatus } from "@prisma/client";
import { disconnect, resetDatabase, testPrisma } from "./helpers/db";
import {
  buildOverrideMap,
  displayNameFrom,
  isBusRouteName,
  railLineNames,
  railModes,
  resolveStationCandidates,
  stationKeyFor,
} from "@/lib/tfl/station-resolver";
import { normalizeRecord } from "@/lib/tfl/normalize";
import type { StopPoint } from "@/lib/tfl/schema";

const WEMBLEY_STOP_POINT: StopPoint = {
  naptanId: "940GZZLUWYP",
  stationNaptan: "940GZZLUWYP",
  hubNaptanCode: null,
  commonName: "Wembley Park Underground Station",
  lat: 51.563198,
  lon: -0.279262,
  modes: ["tube"],
  stopType: "NaptanMetroStation",
  lines: [{ name: "Jubilee" }, { name: "Metropolitan" }],
};

function disruptionsFor(stationId: string, liftIds: string[], message: string) {
  return normalizeRecord({
    stationUniqueId: stationId,
    disruptedLiftUniqueIds: liftIds,
    message,
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnect();
});

describe("display names", () => {
  it("strips station-type suffixes", () => {
    expect(displayNameFrom("Wembley Park Underground Station")).toBe("Wembley Park");
    expect(displayNameFrom("Camden Road Rail Station")).toBe("Camden Road");
    expect(displayNameFrom("Langley (Berks) Rail Station")).toBe("Langley (Berks)");
    expect(displayNameFrom("Canada Water")).toBe("Canada Water");
  });

  it("never returns an empty name", () => {
    expect(displayNameFrom("Station")).toBe("Station");
  });
});

describe("line and mode filtering", () => {
  it("recognises bus route codes", () => {
    for (const route of ["188", "N199", "C10", "P12", "E1", "SL8", "X68"]) {
      expect(isBusRouteName(route)).toBe(true);
    }
  });

  it("does not mistake rail lines for bus routes", () => {
    for (const line of ["Jubilee", "Windrush", "Elizabeth line", "DLR", "c2c", "Mildmay"]) {
      expect(isBusRouteName(line)).toBe(false);
    }
  });

  it("drops bus routes from a hub's line list", () => {
    const lines = railLineNames({
      ...WEMBLEY_STOP_POINT,
      lines: [{ name: "Jubilee" }, { name: "C10" }, { name: "188" }, { name: "Windrush" }],
    });

    expect(lines).toEqual(["Jubilee", "Windrush"]);
  });

  it("keeps only rail-type modes", () => {
    expect(railModes({ ...WEMBLEY_STOP_POINT, modes: ["bus", "tube", "overground"] })).toEqual([
      "overground",
      "tube",
    ]);
  });
});

describe("station keys", () => {
  it("uses the TfL station id when there is one", () => {
    const [disruption] = disruptionsFor("940GZZLUWYP", ["940GZZLUWYP-Lift-5"], "Wembley Park: out");
    expect(stationKeyFor(disruption!)).toBe("940gzzluwyp");
  });
});

describe("resolution order", () => {
  it("1. reuses an existing station matched on tflStationId, with no network call", async () => {
    const existing = await testPrisma.station.create({
      data: {
        tflStationId: "940GZZLUWYP",
        name: "Wembley Park",
        slug: "wembley-park",
        latitude: 51.5,
        longitude: -0.27,
        resolutionStatus: ResolutionStatus.RESOLVED,
      },
    });

    const fetchStopPointImpl = vi.fn();

    const candidates = await resolveStationCandidates(
      disruptionsFor("940GZZLUWYP", ["940GZZLUWYP-Lift-5"], "Wembley Park: out"),
      { prisma: testPrisma, fetchStopPointImpl },
    );

    expect(fetchStopPointImpl).not.toHaveBeenCalled();
    expect(candidates.get("940gzzluwyp")?.existingStationId).toBe(existing.id);
  });

  it("2. matches an existing alias", async () => {
    const station = await testPrisma.station.create({
      data: { name: "Canada Water", slug: "canada-water", resolutionStatus: ResolutionStatus.RESOLVED },
    });
    await testPrisma.stationAlias.create({
      data: { alias: "canada water", stationId: station.id },
    });

    const candidates = await resolveStationCandidates(
      disruptionsFor("HUBZCW", ["HUBZCW-Lift-1"], "Canada Water: No Step Free Access"),
      { prisma: testPrisma, allowNetwork: false },
    );

    expect(candidates.get("hubzcw")?.existingStationId).toBe(station.id);
  });

  it("3. matches an existing station by normalised name", async () => {
    const station = await testPrisma.station.create({
      data: { name: "Gospel Oak", slug: "gospel-oak", resolutionStatus: ResolutionStatus.RESOLVED },
    });

    const candidates = await resolveStationCandidates(
      disruptionsFor("910GGOSPLOK", ["910GGOSPLOK-Lift-2"], "Gospel Oak: No Step Free Access"),
      { prisma: testPrisma, allowNetwork: false },
    );

    expect(candidates.get("910ggosplok")?.existingStationId).toBe(station.id);
  });

  it("4. uses coordinates carried by the disruption itself", async () => {
    const [disruption] = disruptionsFor("NEWSTATION", ["NEWSTATION-Lift-1"], "New Place: out");
    const withCoordinates = { ...disruption!, latitude: 51.51, longitude: -0.12 };

    const candidates = await resolveStationCandidates([withCoordinates], {
      prisma: testPrisma,
      allowNetwork: false,
    });

    const candidate = candidates.get("newstation");
    expect(candidate?.metadataSource).toBe("feed-coordinates");
    expect(candidate?.resolutionStatus).toBe(ResolutionStatus.RESOLVED);
    expect(candidate?.latitude).toBe(51.51);
  });

  it("5. resolves an unknown station from the StopPoint API", async () => {
    const fetchStopPointImpl = vi.fn(async () => WEMBLEY_STOP_POINT);

    const candidates = await resolveStationCandidates(
      disruptionsFor("940GZZLUWYP", ["940GZZLUWYP-Lift-5"], "WEMBLEY PARK STATION: out"),
      { prisma: testPrisma, fetchStopPointImpl },
    );

    const candidate = candidates.get("940gzzluwyp");
    expect(fetchStopPointImpl).toHaveBeenCalledWith("940GZZLUWYP");
    expect(candidate?.name).toBe("Wembley Park");
    expect(candidate?.slug).toBe("wembley-park");
    expect(candidate?.latitude).toBeCloseTo(51.5632, 3);
    expect(candidate?.lines).toEqual(["Jubilee", "Metropolitan"]);
    expect(candidate?.resolutionStatus).toBe(ResolutionStatus.RESOLVED);
    expect(candidate?.metadataSource).toBe("tfl-stoppoint");
  });

  it("5b. falls back to StopPoint search when the id lookup finds nothing", async () => {
    const fetchStopPointImpl = vi
      .fn<(id: string) => Promise<StopPoint | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(WEMBLEY_STOP_POINT);

    const searchStopPointsImpl = vi.fn(async () => ({
      matches: [{ id: "940GZZLUWYP", name: "Wembley Park", lat: 51.56, lon: -0.28, modes: ["tube"] }],
    }));

    const candidates = await resolveStationCandidates(
      disruptionsFor("UNKNOWNID", ["UNKNOWNID-Lift-1"], "WEMBLEY PARK STATION: out"),
      { prisma: testPrisma, fetchStopPointImpl, searchStopPointsImpl },
    );

    expect(searchStopPointsImpl).toHaveBeenCalled();
    expect(candidates.get("unknownid")?.name).toBe("Wembley Park");
  });

  it("6. uses the manual override file when TfL cannot resolve the station", async () => {
    const overrides = buildOverrideMap({
      "mystery halt": {
        name: "Mystery Halt",
        naptanId: "940GMYSTERY",
        latitude: 51.4,
        longitude: -0.2,
      },
    });

    const candidates = await resolveStationCandidates(
      disruptionsFor("910GMYSTERY", ["910GMYSTERY-Lift-1"], "Mystery Halt: out of service"),
      { prisma: testPrisma, allowNetwork: false, overrides },
    );

    const candidate = candidates.get("910gmystery");
    expect(candidate?.metadataSource).toBe("override-file");
    expect(candidate?.name).toBe("Mystery Halt");
    expect(candidate?.latitude).toBe(51.4);
    expect(candidate?.resolutionStatus).toBe(ResolutionStatus.RESOLVED);
  });

  it("7. marks a station unresolved rather than failing", async () => {
    const candidates = await resolveStationCandidates(
      disruptionsFor("910GMYSTERY", ["910GMYSTERY-Lift-1"], "Mystery Halt: out of service"),
      { prisma: testPrisma, allowNetwork: false },
    );

    const candidate = candidates.get("910gmystery");
    expect(candidate?.resolutionStatus).toBe(ResolutionStatus.UNRESOLVED);
    expect(candidate?.name).toBe("Mystery Halt");
    expect(candidate?.latitude).toBeNull();
  });

  it("survives a StopPoint API failure without throwing", async () => {
    const fetchStopPointImpl = vi.fn(async () => {
      throw new Error("TfL is down");
    });
    const searchStopPointsImpl = vi.fn(async () => {
      throw new Error("TfL is still down");
    });

    const candidates = await resolveStationCandidates(
      disruptionsFor("910GMYSTERY", ["910GMYSTERY-Lift-1"], "Mystery Halt: out"),
      { prisma: testPrisma, fetchStopPointImpl, searchStopPointsImpl },
    );

    expect(candidates.get("910gmystery")?.resolutionStatus).toBe(ResolutionStatus.UNRESOLVED);
  });

  it("treats a station without coordinates as ambiguous, not mappable", async () => {
    const fetchStopPointImpl = vi.fn(async () => ({
      ...WEMBLEY_STOP_POINT,
      lat: undefined,
      lon: undefined,
    }));

    const candidates = await resolveStationCandidates(
      disruptionsFor("940GZZLUWYP", ["940GZZLUWYP-Lift-5"], "WEMBLEY PARK STATION: out"),
      { prisma: testPrisma, fetchStopPointImpl },
    );

    expect(candidates.get("940gzzluwyp")?.resolutionStatus).toBe(ResolutionStatus.AMBIGUOUS);
  });

  it("resolves each distinct station only once per poll", async () => {
    const fetchStopPointImpl = vi.fn(async () => WEMBLEY_STOP_POINT);

    await resolveStationCandidates(
      disruptionsFor(
        "940GZZLUWYP",
        ["940GZZLUWYP-Lift-1", "940GZZLUWYP-Lift-2", "940GZZLUWYP-Lift-3"],
        "WEMBLEY PARK STATION: out",
      ),
      { prisma: testPrisma, fetchStopPointImpl },
    );

    expect(fetchStopPointImpl).toHaveBeenCalledTimes(1);
  });
});
