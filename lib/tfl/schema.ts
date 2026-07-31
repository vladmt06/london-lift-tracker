import { z } from "zod";

/**
 * Zod schemas for TfL responses.
 *
 * These describe the payload as it ACTUALLY is (verified against the live
 * endpoint on 2026-07-31), not as documentation implies. Objects are permissive
 * about unknown keys so that TfL adding fields never breaks a poll — and the
 * untouched record is stored regardless.
 *
 * Observed shape of GET /Disruptions/Lifts/v2 — exactly three fields:
 *   { "stationUniqueId": "940GZZLUWYP",
 *     "disruptedLiftUniqueIds": ["940GZZLUWYP-Lift-5"],
 *     "message": "WEMBLEY PARK STATION: ..." }
 *
 * Notably absent: event id, station name, coordinates, and any timestamp.
 */

export const LiftDisruptionRecordSchema = z.looseObject({
  stationUniqueId: z.string().trim().min(1),
  disruptedLiftUniqueIds: z.array(z.string().trim().min(1)).default([]),
  message: z.string().trim().min(1),

  // Not present today. Declared as optional so that if TfL enriches v2 we start
  // using the better data immediately instead of silently ignoring it.
  id: z.string().optional(),
  stationName: z.string().optional(),
  liftName: z.string().optional(),
  startDateTime: z.string().optional(),
  lastUpdateDateTime: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

export type LiftDisruptionRecord = z.infer<typeof LiftDisruptionRecordSchema>;

/** The endpoint returns a bare JSON array. */
export const LiftDisruptionCollectionSchema = z.array(z.unknown());

/** Subset of GET /StopPoint/{id} that station resolution needs. */
export const StopPointSchema = z.looseObject({
  naptanId: z.string().optional(),
  stationNaptan: z.string().nullish(),
  hubNaptanCode: z.string().nullish(),
  commonName: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  modes: z.array(z.string()).default([]),
  stopType: z.string().optional(),
  lines: z
    .array(z.looseObject({ name: z.string().optional() }))
    .default([]),
});

export type StopPoint = z.infer<typeof StopPointSchema>;

export const StopPointSearchSchema = z.looseObject({
  matches: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        name: z.string().optional(),
        lat: z.number().optional(),
        lon: z.number().optional(),
        modes: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type StopPointSearch = z.infer<typeof StopPointSearchSchema>;
