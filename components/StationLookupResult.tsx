"use client";

import Link from "next/link";
import { formatLondonDateTime, londonTimeZoneAbbreviation } from "@/lib/metrics/duration";

/**
 * Shown when a search matches no current disruption.
 *
 * A station with working lifts is the normal case and must not look like "not
 * found". What it says is precisely what we know: TfL is not reporting a fault
 * as of the last successful poll — not that every lift is working, and not that
 * the station is step-free.
 */

export type StationLookup = {
  found: boolean;
  knownToUs?: boolean;
  station?: {
    name: string;
    slug: string | null;
    lines: string[];
    modes: string[];
  };
  activeOutages?: number;
  observedOutageCount?: number;
  lastDisruptionAt?: string | null;
  asOf?: string | null;
  collectionStartedAt?: string | null;
  query?: string;
};

export function StationLookupResult({ lookup }: { lookup: StationLookup }) {
  if (!lookup.found || !lookup.station) {
    return (
      <p className="rounded border border-rule bg-paper px-4 py-6 text-sm text-ink-muted">
        No current disruption matches that, and TfL does not recognise it as a London rail station.
        Check the spelling, or try the station&rsquo;s full name.
      </p>
    );
  }

  const { station } = lookup;
  const asOf = lookup.asOf ? new Date(lookup.asOf) : null;
  const lastDisruption = lookup.lastDisruptionAt ? new Date(lookup.lastDisruptionAt) : null;

  return (
    <article className="rounded border border-ok/40 border-l-4 border-l-ok bg-ok-tint px-4 py-3">
      <h3 className="text-base font-bold leading-snug">
        {station.slug ? (
          <Link href={`/stations/${station.slug}`} className="text-link underline underline-offset-4">
            {station.name}
          </Link>
        ) : (
          station.name
        )}
      </h3>

      <p className="mt-0.5 text-sm font-medium text-ok">
        <span aria-hidden="true">✓ </span>No lift disruption reported
        {asOf ? (
          <>
            {" as of "}
            <time dateTime={asOf.toISOString()}>
              {formatLondonDateTime(asOf)} {londonTimeZoneAbbreviation(asOf)}
            </time>
          </>
        ) : null}
      </p>

      {station.lines.length > 0 ? (
        <p className="mt-1 text-xs text-ink-muted">{station.lines.join(", ")}</p>
      ) : null}

      <p className="mt-2 text-sm text-ink">
        {lookup.knownToUs && lookup.observedOutageCount ? (
          <>
            {`TfL has reported ${lookup.observedOutageCount} lift `}
            {lookup.observedOutageCount === 1 ? "outage" : "outages"}
            {" here since collection began"}
            {lastDisruption ? (
              <>
                {", most recently "}
                <time dateTime={lastDisruption.toISOString()}>
                  {formatLondonDateTime(lastDisruption)}
                </time>
              </>
            ) : null}
            {"."}
          </>
        ) : (
          "TfL has reported no lift disruption here at any point since collection began."
        )}
      </p>

      <p className="mt-2 text-xs text-ink-muted">
        This means TfL is not reporting a fault. It is not a guarantee that every lift is working,
        and not a statement that the station is step-free — some stations have no lifts at all.
      </p>
    </article>
  );
}

export default StationLookupResult;
