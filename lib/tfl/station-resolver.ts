import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ResolutionStatus } from "@prisma/client";
import overridesFile from "@/data/station-overrides.json";
import { fetchStopPoint, searchStopPoints } from "@/lib/tfl/client";
import type { StopPoint } from "@/lib/tfl/schema";
import type { NormalizedLiftDisruption } from "@/lib/tfl/normalize";
import { normalizeStationName, slugify } from "@/lib/utils/text";

/**
 * Station resolution.
 *
 * The disruption feed gives us only an opaque station id such as "940GZZLUWYP",
 * "910GCMDNRD" or "HUBZCW" — no name, no coordinates. This module turns that
 * into something displayable, in the priority order the spec requires:
 *
 *   1. a Station row we already have for this tflStationId
 *   2. a StationAlias exact match
 *   3. an exact normalised-name match against known stations
 *   4. coordinates carried by the disruption itself
 *   5. the TfL StopPoint API (by id, then by name search)
 *   6. data/station-overrides.json
 *   7. otherwise: UNRESOLVED
 *
 * Failure to resolve must never fail a poll. An unresolved station still gets a
 * row and still appears in lists; it just cannot be placed on the map.
 *
 * All network work happens here, BEFORE the write transaction opens.
 */

const OverrideSchema = z.object({
  name: z.string().min(1),
  naptanId: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  modes: z.array(z.string()).optional(),
  lines: z.array(z.string()).optional(),
});

export type StationOverride = z.infer<typeof OverrideSchema>;

function loadOverrides(): Map<string, StationOverride> {
  const map = new Map<string, StationOverride>();
  const entries = Object.entries(overridesFile as Record<string, unknown>);

  for (const [key, value] of entries) {
    if (key.startsWith("_")) continue;
    const parsed = OverrideSchema.safeParse(value);
    if (!parsed.success) {
      console.warn(`[station-resolver] Ignoring malformed override for "${key}"`);
      continue;
    }
    map.set(key.trim().toLowerCase(), parsed.data);
    map.set(normalizeStationName(key), parsed.data);
  }

  return map;
}

const OVERRIDES = loadOverrides();

/** Exposed so tests can exercise the override step without editing the data file. */
export function buildOverrideMap(
  entries: Record<string, StationOverride>,
): Map<string, StationOverride> {
  const map = new Map<string, StationOverride>();
  for (const [key, value] of Object.entries(entries)) {
    map.set(key.trim().toLowerCase(), value);
    map.set(normalizeStationName(key), value);
  }
  return map;
}

/** What the writer should persist for one station. */
export type StationCandidate = {
  /** Grouping key: the TfL station id when present, else the normalised name. */
  key: string;
  existingStationId: string | null;
  tflStationId: string | null;
  naptanId: string | null;
  name: string;
  slug: string;
  latitude: number | null;
  longitude: number | null;
  modes: string[];
  lines: string[];
  resolutionStatus: ResolutionStatus;
  metadataSource: string | null;
  rawMetadata: unknown;
};

export type StationResolverDeps = {
  prisma: Pick<PrismaClient, "station" | "stationAlias">;
  /** Injectable for tests; defaults to the real TfL client. */
  fetchStopPointImpl?: typeof fetchStopPoint;
  searchStopPointsImpl?: typeof searchStopPoints;
  /** When false, no external lookups are attempted (used by tests). */
  allowNetwork?: boolean;
  /** Defaults to data/station-overrides.json. */
  overrides?: Map<string, StationOverride>;
};

/** Group key for a disruption: station id when we have one, else its name. */
export function stationKeyFor(disruption: NormalizedLiftDisruption): string {
  const id = disruption.stationSourceId?.trim();
  if (id) return id.toLowerCase();
  return `name:${normalizeStationName(disruption.stationName)}`;
}

/**
 * "Wembley Park Underground Station" -> "Wembley Park".
 * "Langley (Berks) Rail Station" -> "Langley (Berks)".
 * The full official name is kept in rawMetadata.
 */
export function displayNameFrom(officialName: string): string {
  const cleaned = officialName
    .replace(/\s+(Underground|Rail|DLR|Overground|Tram)\s+Station$/i, "")
    .replace(/\s+Station$/i, "")
    .trim();

  return cleaned.length > 0 ? cleaned : officialName.trim();
}

// Bus route names are short letter/number codes: 188, N199, C10, P12, E1, SL8.
const BUS_ROUTE_PATTERN = /^[A-Z]{0,3}\d{1,3}[A-Z]?$/i;
// ...but "c2c" is a train operating company, and matches that shape exactly.
const NOT_BUS_ROUTES = new Set(["c2c"]);

export function isBusRouteName(name: string): boolean {
  if (NOT_BUS_ROUTES.has(name.trim().toLowerCase())) return false;
  return BUS_ROUTE_PATTERN.test(name.trim());
}

/** Hub stop points list every bus route; keep only rail-type line names. */
export function railLineNames(stopPoint: StopPoint): string[] {
  const names = (stopPoint.lines ?? [])
    .map((line) => line.name?.trim())
    .filter((name): name is string => Boolean(name && name.length > 0))
    .filter((name) => !isBusRouteName(name));

  return [...new Set(names)].sort();
}

const RAIL_MODES = new Set([
  "tube",
  "dlr",
  "overground",
  "elizabeth-line",
  "national-rail",
  "tram",
  "international-rail",
  "cable-car",
]);

export function railModes(stopPoint: StopPoint): string[] {
  return (stopPoint.modes ?? []).filter((mode) => RAIL_MODES.has(mode)).sort();
}

function candidateFromStopPoint(
  key: string,
  existingStationId: string | null,
  stationSourceId: string | null,
  stopPoint: StopPoint,
): StationCandidate {
  const officialName = stopPoint.commonName?.trim() ?? stationSourceId ?? "Unknown station";
  const name = displayNameFrom(officialName);
  const hasCoordinates = typeof stopPoint.lat === "number" && typeof stopPoint.lon === "number";

  return {
    key,
    existingStationId,
    tflStationId: stationSourceId,
    naptanId: stopPoint.stationNaptan ?? stopPoint.naptanId ?? stopPoint.hubNaptanCode ?? null,
    name,
    slug: slugify(name),
    latitude: hasCoordinates ? (stopPoint.lat as number) : null,
    longitude: hasCoordinates ? (stopPoint.lon as number) : null,
    modes: railModes(stopPoint),
    lines: railLineNames(stopPoint),
    // Without coordinates a station cannot be mapped, so it is not fully resolved.
    resolutionStatus: hasCoordinates ? ResolutionStatus.RESOLVED : ResolutionStatus.AMBIGUOUS,
    metadataSource: "tfl-stoppoint",
    rawMetadata: { officialName, stopPoint },
  };
}

/**
 * Resolve every distinct station referenced by this poll.
 *
 * Only stations we do not already know trigger network calls, so the steady
 * state is zero external requests per poll.
 */
export async function resolveStationCandidates(
  disruptions: NormalizedLiftDisruption[],
  deps: StationResolverDeps,
): Promise<Map<string, StationCandidate>> {
  const { prisma, allowNetwork = true, overrides = OVERRIDES } = deps;
  const fetchStopPointImpl = deps.fetchStopPointImpl ?? fetchStopPoint;
  const searchStopPointsImpl = deps.searchStopPointsImpl ?? searchStopPoints;

  const byKey = new Map<string, NormalizedLiftDisruption>();
  for (const disruption of disruptions) {
    const key = stationKeyFor(disruption);
    if (!byKey.has(key)) byKey.set(key, disruption);
  }

  const candidates = new Map<string, StationCandidate>();

  for (const [key, disruption] of byKey) {
    const stationSourceId = disruption.stationSourceId?.trim() || null;
    const normalizedName = normalizeStationName(disruption.stationName);

    // --- 1. Known tflStationId -------------------------------------------
    const existing = stationSourceId
      ? await prisma.station.findUnique({ where: { tflStationId: stationSourceId } })
      : null;

    if (existing) {
      candidates.set(key, {
        key,
        existingStationId: existing.id,
        tflStationId: existing.tflStationId,
        naptanId: existing.naptanId,
        name: existing.name,
        slug: existing.slug,
        latitude: existing.latitude,
        longitude: existing.longitude,
        modes: existing.modes,
        lines: existing.lines,
        resolutionStatus: existing.resolutionStatus,
        metadataSource: existing.metadataSource,
        rawMetadata: existing.rawMetadata,
      });
      continue;
    }

    // --- 2. Alias --------------------------------------------------------
    const alias = await prisma.stationAlias.findUnique({
      where: { alias: normalizedName },
      include: { station: true },
    });

    if (alias?.station) {
      candidates.set(key, {
        key,
        existingStationId: alias.station.id,
        tflStationId: alias.station.tflStationId ?? stationSourceId,
        naptanId: alias.station.naptanId,
        name: alias.station.name,
        slug: alias.station.slug,
        latitude: alias.station.latitude,
        longitude: alias.station.longitude,
        modes: alias.station.modes,
        lines: alias.station.lines,
        resolutionStatus: alias.station.resolutionStatus,
        metadataSource: alias.station.metadataSource ?? "station-alias",
        rawMetadata: alias.station.rawMetadata,
      });
      continue;
    }

    // --- 3. Exact normalised name match ----------------------------------
    const named = await prisma.station.findFirst({
      where: { slug: slugify(normalizedName) },
    });

    if (named) {
      candidates.set(key, {
        key,
        existingStationId: named.id,
        tflStationId: named.tflStationId ?? stationSourceId,
        naptanId: named.naptanId,
        name: named.name,
        slug: named.slug,
        latitude: named.latitude,
        longitude: named.longitude,
        modes: named.modes,
        lines: named.lines,
        resolutionStatus: named.resolutionStatus,
        metadataSource: named.metadataSource ?? "name-match",
        rawMetadata: named.rawMetadata,
      });
      continue;
    }

    // --- 4. Coordinates carried by the disruption ------------------------
    if (disruption.latitude !== null && disruption.longitude !== null) {
      const name = disruption.stationName;
      candidates.set(key, {
        key,
        existingStationId: null,
        tflStationId: stationSourceId,
        naptanId: null,
        name,
        slug: slugify(name),
        latitude: disruption.latitude,
        longitude: disruption.longitude,
        modes: [],
        lines: [],
        resolutionStatus: ResolutionStatus.RESOLVED,
        metadataSource: "feed-coordinates",
        rawMetadata: { source: "disruption", raw: disruption.raw },
      });
      continue;
    }

    // --- 5. TfL StopPoint API --------------------------------------------
    let stopPoint: StopPoint | null = null;
    if (allowNetwork && stationSourceId) {
      try {
        stopPoint = await fetchStopPointImpl(stationSourceId);
      } catch (error) {
        console.warn(
          `[station-resolver] StopPoint lookup failed for ${stationSourceId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!stopPoint && allowNetwork && normalizedName.length > 0) {
      try {
        const search = await searchStopPointsImpl(disruption.stationName);
        const match = search?.matches?.[0];
        if (match?.id) {
          try {
            stopPoint = await fetchStopPointImpl(match.id);
          } catch {
            stopPoint = null;
          }
          if (!stopPoint && typeof match.lat === "number" && typeof match.lon === "number") {
            stopPoint = {
              naptanId: match.id,
              commonName: match.name ?? disruption.stationName,
              lat: match.lat,
              lon: match.lon,
              modes: match.modes ?? [],
              lines: [],
            };
          }
        }
      } catch (error) {
        console.warn(
          `[station-resolver] StopPoint search failed for "${disruption.stationName}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (stopPoint) {
      candidates.set(key, candidateFromStopPoint(key, null, stationSourceId, stopPoint));
      continue;
    }

    // --- 6. Manual override file -----------------------------------------
    const override =
      (stationSourceId ? overrides.get(stationSourceId.toLowerCase()) : undefined) ??
      overrides.get(normalizedName);

    if (override) {
      const hasCoordinates =
        typeof override.latitude === "number" && typeof override.longitude === "number";
      candidates.set(key, {
        key,
        existingStationId: null,
        tflStationId: stationSourceId,
        naptanId: override.naptanId ?? null,
        name: override.name,
        slug: slugify(override.name),
        latitude: hasCoordinates ? (override.latitude as number) : null,
        longitude: hasCoordinates ? (override.longitude as number) : null,
        modes: override.modes ?? [],
        lines: override.lines ?? [],
        resolutionStatus: hasCoordinates ? ResolutionStatus.RESOLVED : ResolutionStatus.AMBIGUOUS,
        metadataSource: "override-file",
        rawMetadata: { override },
      });
      continue;
    }

    // --- 7. Unresolved ----------------------------------------------------
    const fallbackName = disruption.stationName || stationSourceId || "Unknown station";
    candidates.set(key, {
      key,
      existingStationId: null,
      tflStationId: stationSourceId,
      naptanId: null,
      name: fallbackName,
      slug: slugify(fallbackName),
      latitude: null,
      longitude: null,
      modes: [],
      lines: [],
      resolutionStatus: ResolutionStatus.UNRESOLVED,
      metadataSource: "feed-message",
      rawMetadata: { reason: "no-stoppoint-match", stationSourceId },
    });
  }

  return candidates;
}
