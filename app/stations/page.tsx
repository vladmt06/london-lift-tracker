import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { StationTable } from "@/components/StationTable";
import { prisma } from "@/lib/db";
import { formatLondonDate } from "@/lib/metrics/duration";
import { getCollectionStartedAt, getStationSummaries } from "@/lib/metrics/station-metrics";
import { maybeRefreshFeed } from "@/lib/tfl/refresh";
import type { StationRow } from "@/lib/utils/view-types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stations",
  description:
    "Every London station with a lift, showing which have a disruption reported now and " +
    "which have had one since collection began.",
};

export default async function StationsPage() {
  const now = new Date();
  const [summaries, collectionStartedAt] = await Promise.all([
    getStationSummaries(prisma, now),
    getCollectionStartedAt(prisma),
  ]);

  after(() => maybeRefreshFeed());

  const collectionStartedLabel = collectionStartedAt ? formatLondonDate(collectionStartedAt) : null;

  const rows: StationRow[] = summaries.map((station) => ({
    name: station.name,
    slug: station.slug,
    modes: station.modes,
    lines: station.lines,
    mappable: station.latitude !== null && station.longitude !== null,
    activeOutages: station.activeOutages,
    observedOutageCount: station.observedOutageCount,
    observedDowntimeMs: station.observedDowntimeMs,
    atLeastOneLiftDisruptedMs: station.atLeastOneLiftDisruptedMs,
    medianResolvedMs: station.medianResolvedMs,
    longestResolvedMs: station.longestResolvedMs,
    lastObservedDisruptionAtIso: station.lastObservedDisruptionAt?.toISOString() ?? null,
    hasOngoingSinceCollectionStart: station.hasOngoingSinceCollectionStart,
  }));

  const activeStationCount = summaries.filter((station) => station.activeOutages > 0).length;

  const resolvedOutageTotal = summaries.reduce(
    (total, station) => total + (station.observedOutageCount - station.activeOutages),
    0,
  );

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          London stations with lifts
        </h1>
        <p className="max-w-3xl text-ink-muted">
          {collectionStartedLabel ? (
            <>
              {"Ranked by observed downtime since "}
              <strong className="font-semibold text-ink">{collectionStartedLabel}</strong>
              {". These figures describe what this service saw in that window — not a station’s "}
              {"full history, and not its overall accessibility."}
            </>
          ) : (
            <>No successful poll has been recorded yet, so there is nothing to rank.</>
          )}
        </p>
        <p className="max-w-3xl rounded border border-rule bg-paper px-4 py-3 text-sm text-ink">
          {`Every one of the ${rows.length} stations with a lift in TfL's published station data, `}
          {"whether or not anything has ever gone wrong there. "}
          {activeStationCount > 0 ? (
            <>
              <strong className="font-semibold">{activeStationCount}</strong>
              {activeStationCount === 1 ? " has" : " have"}
              {" a lift disruption right now; the rest are clear."}
            </>
          ) : (
            <>
              <strong className="font-semibold">None</strong>
              {" has a lift disruption right now."}
            </>
          )}
          {" Stations with no lifts at all are not listed, because there is nothing here to track."}
        </p>
        {resolvedOutageTotal === 0 ? (
          <p className="max-w-3xl rounded border border-rule bg-paper px-4 py-3 text-sm text-ink">
            No outage has been observed from start to finish yet, so median and longest resolved
            durations show “insufficient data”. They will fill in as outages are seen to end.
          </p>
        ) : null}
      </header>

      <StationTable
        rows={rows}
        collectionStartedLabel={collectionStartedLabel}
        nowIso={now.toISOString()}
      />

      <p className="text-sm text-ink-muted">
        Stations that could not be geocoded still appear here, but not on the map.{" "}
        <Link href="/methodology" className="text-link underline underline-offset-4">
          How these numbers are produced
        </Link>
        .
      </p>
    </div>
  );
}
