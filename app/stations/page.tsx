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
    "Every London station where a lift disruption has been observed since collection began, " +
    "ranked by observed downtime.",
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
          Stations with observed lift disruptions
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
          <strong className="font-semibold">This is not a list of London stations.</strong>
          {" A station appears here only once TfL has reported a lift disruption at it. "}
          {activeStationCount > 0 ? (
            <>
              {"Right now "}
              <strong className="font-semibold">{activeStationCount}</strong>
              {` of these ${rows.length} stations `}
              {activeStationCount === 1 ? "has" : "have"}
              {" a lift disruption; the rest are listed because of an earlier one. The hundreds "}
              {"of London stations with no reported disruption are absent entirely."}
            </>
          ) : (
            <>
              {"None of them has a disruption right now — they are listed because of earlier "}
              {"ones. Stations with no reported disruption are absent entirely."}
            </>
          )}
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
