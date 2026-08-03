import Link from "next/link";
import { after } from "next/server";
import { CurrentDisruptions } from "@/components/CurrentDisruptions";
import { FeedHealth } from "@/components/FeedHealth";
import { MetricCard } from "@/components/MetricCard";
import { StationTable } from "@/components/StationTable";
import { Duration } from "@/components/Duration";
import { prisma } from "@/lib/db";
import { getDashboardData } from "@/lib/metrics/station-metrics";
import { formatLondonDate } from "@/lib/metrics/duration";
import { maybeRefreshFeed } from "@/lib/tfl/refresh";
import type { MapMarker, OutageListItem, StationRow } from "@/lib/utils/view-types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const now = new Date();
  const data = await getDashboardData(prisma, now);

  // Top up the data after this response is sent, so the scheduled workflow
  // being late or dropped cannot leave the site frozen. Nobody waits for it.
  after(() => maybeRefreshFeed());

  const collectionStartedLabel = data.collectionStartedAt
    ? formatLondonDate(data.collectionStartedAt)
    : null;

  const outages: OutageListItem[] = data.activeOutages.map((outage) => ({
    id: outage.id,
    stationName: outage.stationName,
    stationSlug: outage.stationSlug,
    liftName: outage.liftName,
    message: outage.message,
    openedAtIso: outage.openedAt.toISOString(),
    firstSeenAtIso: outage.firstSeenAt.toISOString(),
    lastSeenAtIso: outage.lastSeenAt.toISOString(),
    durationMs: outage.durationMs,
    ongoingAtCollectionStart: outage.ongoingAtCollectionStart,
    latitude: outage.latitude,
    longitude: outage.longitude,
  }));

  // A station is on the map once: as an active disruption if it has one, else as
  // recently restored, else as a station with earlier observed outages.
  const markers: MapMarker[] = [];
  const placed = new Set<string>();

  for (const outage of data.activeOutages) {
    if (outage.latitude === null || outage.longitude === null) continue;
    markers.push({
      id: `active-${outage.id}`,
      kind: "active",
      stationName: outage.stationName,
      stationSlug: outage.stationSlug,
      latitude: outage.latitude,
      longitude: outage.longitude,
      liftName: outage.liftName,
      message: outage.message,
      firstSeenAtIso: outage.firstSeenAt.toISOString(),
      durationMs: outage.durationMs,
      ongoingAtCollectionStart: outage.ongoingAtCollectionStart,
      observedOutageCount: 0,
    });
    placed.add(outage.stationSlug);
  }

  for (const outage of data.recentlyResolved) {
    if (placed.has(outage.stationSlug)) continue;
    if (outage.latitude === null || outage.longitude === null) continue;
    markers.push({
      id: `restored-${outage.id}`,
      kind: "restored",
      stationName: outage.stationName,
      stationSlug: outage.stationSlug,
      latitude: outage.latitude,
      longitude: outage.longitude,
      liftName: outage.liftName,
      message: null,
      firstSeenAtIso: outage.firstSeenAt.toISOString(),
      durationMs: outage.durationMs,
      ongoingAtCollectionStart: false,
      observedOutageCount: 0,
    });
    placed.add(outage.stationSlug);
  }

  for (const station of data.stationsWithHistory) {
    if (placed.has(station.slug)) continue;
    if (station.latitude === null || station.longitude === null) continue;
    markers.push({
      id: `history-${station.id}`,
      kind: "historical",
      stationName: station.name,
      stationSlug: station.slug,
      latitude: station.latitude,
      longitude: station.longitude,
      liftName: null,
      message: null,
      firstSeenAtIso: null,
      durationMs: null,
      ongoingAtCollectionStart: false,
      observedOutageCount: station.observedOutageCount,
    });
    placed.add(station.slug);
  }

  const stationRows: StationRow[] = data.topStations.map((station) => ({
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

  const unmappableOutages = outages.filter(
    (outage) => outage.latitude === null || outage.longitude === null,
  ).length;

  return (
    <div className="space-y-8">
      <section aria-labelledby="overview-heading" className="space-y-4">
        <div>
          <h1 id="overview-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Lift disruptions across London&rsquo;s rail network
          </h1>
          <p className="mt-1 max-w-3xl text-ink-muted">
            This service repeatedly reads Transport for London&rsquo;s public lift-disruption feed
            and keeps a record of what it saw, so that lift outages have a history rather than
            disappearing once they are fixed.
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {collectionStartedLabel ? (
              <>
                Data collected since{" "}
                <strong className="font-semibold text-ink">{collectionStartedLabel}</strong>. All
                history below covers only that period.
              </>
            ) : (
              <>Collection has not recorded a successful poll yet.</>
            )}
          </p>
        </div>

        <FeedHealth
          status={data.feedHealth.status}
          lastSuccessfulPoll={data.feedHealth.lastSuccessfulPollAt}
          failedPollsLast24h={data.feedHealth.failedPollsLast24h}
          now={now}
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Lifts disrupted now"
            value={data.activeOutageCount}
            tone={data.activeOutageCount > 0 ? "outage" : "ok"}
            hint="Individual lifts currently reported as disrupted."
          />
          <MetricCard
            label="Stations affected now"
            value={data.affectedStationCount}
            hint="Out of hundreds across London. A disrupted lift does not necessarily mean the station is inaccessible."
          />
          <MetricCard
            label="Longest current outage"
            value={
              data.activeOutageCount === 0 ? (
                <span className="text-ink-muted">none</span>
              ) : data.longestTimedActiveOutage ? (
                <Duration ms={data.longestTimedActiveOutage.durationMs} />
              ) : (
                <span className="text-base font-semibold text-ink-muted">not yet measurable</span>
              )
            }
            hint={
              data.activeOutageCount === 0
                ? "No lift is currently reported as disrupted."
                : data.longestTimedActiveOutage
                  ? `${data.longestTimedActiveOutage.stationName} — timed from when we first saw it start.`
                  : "Every current outage was already running when collection began, so none can be timed yet."
            }
          />
          <MetricCard
            label="Stations affected ever"
            value={data.stationsWithHistory.length}
            hint="Stations with at least one outage observed since collection began — the only ones listed on this site."
          />
        </div>
      </section>

      {data.ongoingSinceCollectionStartCount > 0 ? (
        <p className="rounded border border-rule bg-paper px-4 py-3 text-sm text-ink">
          <strong className="font-semibold">Why most of these say “ongoing”.</strong>{" "}
          {data.ongoingSinceCollectionStartCount} of the {data.activeOutageCount}
          {" disrupted lifts below were already in TfL’s feed when collection began"}
          {collectionStartedLabel ? ` on ${collectionStartedLabel}` : ""}
          {". The feed carries no start times, so for those we can only say they are "}
          <em>ongoing</em>
          {"; a duration appears only once we have watched an outage begin."}{" "}
          <strong className="font-semibold">This is expected, not a fault.</strong>
          {" Any snapshot of what is broken right now is dominated by slow repairs: a lift fixed "}
          {"within the hour leaves the feed almost immediately, while one waiting on parts stays "}
          {"for weeks. TfL’s own messages here quote end dates months away."}
        </p>
      ) : null}

      <CurrentDisruptions outages={outages} markers={markers} nowIso={now.toISOString()} />

      {unmappableOutages > 0 ? (
        <p className="text-sm text-ink-muted">
          {unmappableOutages} current disruption{unmappableOutages === 1 ? "" : "s"} could not be
          placed on the map because the station could not be geocoded. They are included in the
          list above.
        </p>
      ) : null}

      <section aria-labelledby="rankings-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="rankings-heading" className="text-xl font-bold">
            Stations by observed downtime
          </h2>
          <Link href="/stations" className="text-sm text-link underline underline-offset-4">
            See all stations
          </Link>
        </div>

        <StationTable
          rows={stationRows}
          collectionStartedLabel={collectionStartedLabel}
          nowIso={now.toISOString()}
          showFilters={false}
        />
      </section>

      <section aria-labelledby="methodology-note-heading" className="rounded border border-rule bg-paper px-4 py-4">
        <h2 id="methodology-note-heading" className="text-lg font-bold">
          How to read these numbers
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
          <li>
            Outage start times are when this service <em>first observed</em> the disruption, which
            may be later than the lift actually failed.
          </li>
          <li>
            An outage is treated as over when it disappears from the TfL feed for two consecutive
            successful polls. That end time is inferred, not reported by TfL.
          </li>
          <li>
            A disrupted lift does not necessarily mean a station has lost step-free access — many
            stations have alternative lifts, ramps or level routes.
          </li>
          <li>
            Very short outages that begin and end between two polls will not appear here at all.
          </li>
        </ul>
        <p className="mt-3 text-sm">
          <Link href="/methodology" className="text-link underline underline-offset-4">
            Read the full methodology
          </Link>
        </p>
      </section>
    </div>
  );
}
