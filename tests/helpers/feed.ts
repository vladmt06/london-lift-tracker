import { hashJson } from "@/lib/utils/text";
import { TflRequestError, type fetchLiftDisruptions } from "@/lib/tfl/client";

/**
 * Fake feeds for the state-machine tests, shaped exactly like the real payload
 * (verified against the live endpoint): station id, lift ids, message.
 */

export type FeedRecord = {
  stationUniqueId: string;
  disruptedLiftUniqueIds: string[];
  message: string;
};

export function feedRecord(
  stationUniqueId: string,
  liftIds: string[],
  message: string,
): FeedRecord {
  return { stationUniqueId, disruptedLiftUniqueIds: liftIds, message };
}

/** A feed that returns exactly these records with HTTP 200. */
export function stubFeed(records: unknown[]): typeof fetchLiftDisruptions {
  return async () => ({
    payload: records,
    httpStatus: 200,
    responseHash: hashJson(records),
    durationMs: 5,
    attempts: 1,
  });
}

/** A feed whose request fails outright, as a timeout or 5xx would. */
export function failingFeed(
  message = "TfL request timed out after 15000ms",
): typeof fetchLiftDisruptions {
  return async () => {
    throw new TflRequestError(message, { kind: "timeout", attempts: 3 });
  };
}

/** A 200 response whose body is not a JSON array at all. */
export function malformedShapeFeed(): typeof fetchLiftDisruptions {
  return async () => ({
    payload: { unexpected: "object" },
    httpStatus: 200,
    responseHash: "deadbeef",
    durationMs: 5,
    attempts: 1,
  });
}

/** Advance a clock by whole minutes, mimicking five-minute polling. */
export function clockFrom(start: Date): { now: () => Date; advance: (minutes: number) => void } {
  let current = new Date(start.getTime());

  return {
    now: () => new Date(current.getTime()),
    advance: (minutes: number) => {
      current = new Date(current.getTime() + minutes * 60_000);
    },
  };
}
