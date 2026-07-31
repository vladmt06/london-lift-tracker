import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Duration } from "@/components/Duration";
import { MetricCard } from "@/components/MetricCard";
import { OutageList } from "@/components/OutageList";
import { StationMiniMap } from "@/components/StationMiniMap";
import { prisma } from "@/lib/db";
import {
  formatLondonDate,
  formatLondonDateTime,
  londonTimeZoneAbbreviation,
} from "@/lib/metrics/duration";
import { getStationDetail } from "@/lib/metrics/station-metrics";
import type { MapMarker, OutageListItem } from "@/lib/utils/view-types";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const detail = await getStationDetail(slug, prisma);

  if (!detail) return { title: "Station not found" };

  return {
    title: detail.summary.name,
    description:
      `Observed lift disruptions at ${detail.summary.name}: ` +
      `${detail.summary.activeOutages} active, ${detail.summary.observedOutageCount} observed since collection began.`,
  };
}

export default async function StationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const now = new Date();
  const detail = await getStationDetail(slug, prisma, now);

  if (!detail) notFound();

  const { summary } = detail;
  const collectionStartedLabel = detail.collectionStartedAt
    ? formatLondonDate(detail.collectionStartedAt)
    : null;

  const activeItems: OutageListItem[] = detail.activeOutages.map((outage) => ({
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

  const marker: MapMarker | null =
    summary.latitude !== null && summary.longitude !== null
      ? {
          id: `station-${summary.slug}`,
          kind: summary.activeOutages > 0 ? "active" : "historical",
          stationName: summary.name,
          stationSlug: summary.slug,
          latitude: summary.latitude,
          longitude: summary.longitude,
          liftName: null,
          message: null,
          firstSeenAtIso: null,
          durationMs: null,
          observedOutageCount: summary.observedOutageCount,
        }
      : null;

  // One chronological list of active and resolved outages, where an active
  // outage simply has no end yet.
  const timeline = [
    ...detail.activeOutages.map((outage) => ({
      ...outage,
      closedAt: null as Date | null,
      closureInferred: false,
    })),
    ...detail.resolvedOutages.map((outage) => ({
      ...outage,
      closedAt: outage.closedAt as Date | null,
    })),
  ].sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());

  return (
    <div className="space-y-8">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/stations" className="text-link underline underline-offset-4">
          ← All stations
        </Link>
      </nav>

      <header className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{summary.name}</h1>

          {summary.lines.length > 0 ? (
            <p className="text-sm text-ink-muted">Lines: {summary.lines.join(", ")}</p>
          ) : null}

          <p
            className={`inline-block rounded border px-3 py-1.5 text-sm font-semibold ${
              summary.activeOutages > 0
                ? "border-outage/40 bg-outage-tint text-outage"
                : "border-ok/40 bg-ok-tint text-ok"
            }`}
          >
            {summary.activeOutages > 0 ? (
              <>
                <span aria-hidden="true">● </span>
                {summary.activeOutages} lift{summary.activeOutages === 1 ? "" : "s"} currently
                reported as disrupted
              </>
            ) : (
              <>
                <span aria-hidden="true">✓ </span>No lift disruption currently reported
              </>
            )}
          </p>

          <p className="max-w-2xl text-sm text-ink-muted">
            This describes the lifts TfL reports as disrupted. It is not a statement about whether
            the station as a whole is step-free — proving that needs the full station topology.
          </p>
        </div>

        {marker ? (
          <StationMiniMap marker={marker} nowIso={now.toISOString()} />
        ) : (
          <p className="rounded border border-rule bg-paper px-4 py-3 text-sm text-ink-muted">
            This station could not be geocoded from TfL&rsquo;s StopPoint data, so it cannot be
            shown on a map. Its outage history is unaffected.
          </p>
        )}
      </header>

      <section aria-labelledby="station-metrics-heading" className="space-y-3">
        <h2 id="station-metrics-heading" className="text-xl font-bold">
          Observed since {collectionStartedLabel ?? "collection began"}
        </h2>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Observed outages"
            value={summary.observedOutageCount}
            hint="Distinct lift outages seen since collection began."
          />
          <MetricCard
            label="Observed downtime"
            value={<Duration ms={summary.observedDowntimeMs} />}
            hint="Summed per lift; two lifts down for an hour counts as two hours."
          />
          <MetricCard
            label="Median resolved outage"
            value={<Duration ms={summary.medianResolvedMs} />}
            hint="Resolved outages only. Active outages are excluded."
          />
          <MetricCard
            label="Longest resolved outage"
            value={<Duration ms={summary.longestResolvedMs} />}
            hint="Longest outage seen from first observation to inferred restoration."
          />
        </div>

        <p className="text-sm text-ink-muted">
          Time with at least one lift disrupted (overlaps merged):{" "}
          <Duration ms={summary.atLeastOneLiftDisruptedMs} />.
        </p>
      </section>

      {activeItems.length > 0 ? (
        <section aria-labelledby="current-outages-heading" className="space-y-3">
          <h2 id="current-outages-heading" className="text-xl font-bold">
            Current disruptions
          </h2>
          <OutageList items={activeItems} headingId="current-outages-heading" />
        </section>
      ) : null}

      <section aria-labelledby="timeline-heading" className="space-y-3">
        <h2 id="timeline-heading" className="text-xl font-bold">
          Outage timeline
        </h2>

        {timeline.length === 0 ? (
          <p className="rounded border border-rule bg-paper px-4 py-6 text-ink-muted">
            No outages have been observed at this station since collection began.
          </p>
        ) : (
          <ol className="space-y-3">
            {timeline.map((outage) => {
              const closedAt = outage.closedAt;

              return (
                <li key={outage.id}>
                  <article
                    className={`rounded border bg-paper px-4 py-3 ${
                      closedAt ? "border-rule" : "border-outage/40"
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-bold">
                        {outage.liftName ?? "Lift not identified in the feed"}
                      </h3>
                      <p
                        className={`text-sm font-semibold ${closedAt ? "text-ink-muted" : "text-outage"}`}
                      >
                        {closedAt ? "Resolved" : "Active"} · <Duration ms={outage.durationMs} />
                      </p>
                    </div>

                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                      <div className="flex gap-1">
                        <dt className="font-semibold">First observed:</dt>
                        <dd>
                          <time dateTime={outage.firstSeenAt.toISOString()}>
                            {formatLondonDateTime(outage.firstSeenAt)}{" "}
                            {londonTimeZoneAbbreviation(outage.firstSeenAt)}
                          </time>
                        </dd>
                      </div>

                      <div className="flex gap-1">
                        <dt className="font-semibold">
                          {closedAt ? "Inferred end:" : "Last confirmed:"}
                        </dt>
                        <dd>
                          <time dateTime={(closedAt ?? outage.lastSeenAt).toISOString()}>
                            {formatLondonDateTime(closedAt ?? outage.lastSeenAt)}{" "}
                            {londonTimeZoneAbbreviation(closedAt ?? outage.lastSeenAt)}
                          </time>
                          {closedAt ? " (inferred from the feed, not reported by TfL)" : ""}
                        </dd>
                      </div>
                    </dl>

                    {outage.ongoingAtCollectionStart ? (
                      <p className="mt-2 text-sm text-ink-muted">
                        This outage was already in the feed when collection began, so it started
                        before the time shown and its duration is a lower bound.
                      </p>
                    ) : null}

                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm font-medium text-link underline underline-offset-4">
                        TfL&rsquo;s message
                      </summary>
                      <p className="mt-1 border-l-2 border-rule pl-3 text-sm text-ink">
                        {outage.message}
                      </p>
                    </details>
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section
        aria-labelledby="data-quality-heading"
        className="rounded border border-rule bg-paper px-4 py-4"
      >
        <h2 id="data-quality-heading" className="text-lg font-bold">
          Data quality notes for this station
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>
            Station identity comes from TfL id{" "}
            <code className="font-mono text-xs">{detail.tflStationId ?? "unknown"}</code>
            {detail.metadataSource ? `, resolved via ${detail.metadataSource}` : ""}.
          </li>
          <li>
            First recorded here on{" "}
            <time dateTime={detail.firstSeenAt.toISOString()}>
              {formatLondonDateTime(detail.firstSeenAt)}
            </time>
            .
          </li>
          <li>
            {summary.resolutionStatus === "RESOLVED"
              ? "Coordinates were resolved from TfL's StopPoint API."
              : "Coordinates are missing or ambiguous, so this station may not appear on the map."}
          </li>
          <li>
            Durations of active outages are measured to now; they will keep growing until the
            disruption leaves the feed.
          </li>
        </ul>
        <p className="mt-3 text-sm">
          <Link href="/methodology" className="text-link underline underline-offset-4">
            Full methodology
          </Link>
        </p>
      </section>
    </div>
  );
}
