/**
 * Plain, serialisable shapes passed from server components into client
 * components. Dates are ISO strings so that nothing depends on how a Date
 * survives the client boundary, and every duration is pre-computed on the
 * server against a single "now" — so the whole page tells a consistent story.
 */

export type OutageListItem = {
  id: string;
  stationName: string;
  stationSlug: string;
  liftName: string | null;
  message: string;
  openedAtIso: string;
  firstSeenAtIso: string;
  lastSeenAtIso: string;
  durationMs: number;
  /** Already disrupted when we started collecting: true start time unknown. */
  ongoingAtCollectionStart: boolean;
  /** Duration from the start date TfL states in its own message, if it gives one. */
  statedDurationMs: number | null;
  statedStartAtIso: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type ResolvedOutageListItem = OutageListItem & {
  closedAtIso: string;
  closureInferred: boolean;
};

export type MapMarkerKind = "active" | "restored" | "historical";

export type MapMarker = {
  id: string;
  kind: MapMarkerKind;
  stationName: string;
  stationSlug: string;
  latitude: number;
  longitude: number;
  liftName: string | null;
  message: string | null;
  firstSeenAtIso: string | null;
  durationMs: number | null;
  /** True when the outage predates collection, so its duration is unknown. */
  ongoingAtCollectionStart: boolean;
  observedOutageCount: number;
};

export type StationRow = {
  name: string;
  slug: string;
  modes: string[];
  lines: string[];
  mappable: boolean;
  activeOutages: number;
  observedOutageCount: number;
  observedDowntimeMs: number;
  atLeastOneLiftDisruptedMs: number;
  medianResolvedMs: number | null;
  longestResolvedMs: number | null;
  lastObservedDisruptionAtIso: string | null;
  /** At least one outage here began before collection: downtime is a floor. */
  hasOngoingSinceCollectionStart: boolean;
};
