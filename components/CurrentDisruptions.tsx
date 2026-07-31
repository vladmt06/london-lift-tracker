"use client";

import { useId, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { OutageList } from "@/components/OutageList";
import type { MapMarker, OutageListItem } from "@/lib/utils/view-types";

/**
 * Search over current disruptions, driving the list and the map together so the
 * two never disagree. Leaflet touches `window` on import, so the map is loaded
 * on the client only; the list works with or without it.
 */

const LiftMap = dynamic(() => import("@/components/LiftMap").then((mod) => mod.LiftMap), {
  ssr: false,
  loading: () => (
    <div
      className="flex h-full items-center justify-center bg-canvas text-sm text-ink-muted"
      role="status"
    >
      Loading map…
    </div>
  ),
});

export function CurrentDisruptions({
  outages,
  markers,
  nowIso,
}: {
  outages: OutageListItem[];
  markers: MapMarker[];
  nowIso: string;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();

  const normalisedQuery = query.trim().toLowerCase();

  const filteredOutages = useMemo(() => {
    if (normalisedQuery.length === 0) return outages;
    return outages.filter((outage) =>
      `${outage.stationName} ${outage.liftName ?? ""} ${outage.message}`
        .toLowerCase()
        .includes(normalisedQuery),
    );
  }, [outages, normalisedQuery]);

  const filteredMarkers = useMemo(() => {
    if (normalisedQuery.length === 0) return markers;
    const stationSlugs = new Set(filteredOutages.map((outage) => outage.stationSlug));
    return markers.filter(
      (marker) =>
        stationSlugs.has(marker.stationSlug) ||
        marker.stationName.toLowerCase().includes(normalisedQuery),
    );
  }, [markers, filteredOutages, normalisedQuery]);

  return (
    <section aria-labelledby="current-disruptions-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="current-disruptions-heading" className="text-xl font-bold">
          Current lift disruptions
        </h2>

        <div>
          <label htmlFor={searchId} className="block text-sm font-medium">
            Search stations or messages
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Bank, Jubilee, ticket hall"
            className="mt-1 w-full rounded border border-rule-strong bg-paper px-3 py-2 text-sm sm:w-72"
          />
        </div>
      </div>

      {/* Announced whenever filtering changes what is on screen. */}
      <p aria-live="polite" className="text-sm text-ink-muted">
        Showing {filteredOutages.length} of {outages.length} current lift disruption
        {outages.length === 1 ? "" : "s"}
        {normalisedQuery.length > 0 ? ` matching “${query.trim()}”` : ""}.
      </p>

      <div className="grid gap-4 lg:grid-cols-[1.05fr_1fr]">
        {/* Mobile order puts the text list first; desktop shows map on the left. */}
        <div className="order-2 lg:order-1">
          <div className="h-[22rem] overflow-hidden rounded border border-rule bg-paper sm:h-[28rem]">
            <LiftMap markers={filteredMarkers} nowIso={nowIso} />
          </div>

          <p className="mt-2 text-xs text-ink-muted">
            <span aria-hidden="true">● </span>Active disruption
            <span aria-hidden="true"> · ■ </span>
            <span className="sr-only"> · </span>Restored in the last 24 hours
            <span aria-hidden="true"> · ○ </span>
            <span className="sr-only"> · </span>Station with earlier observed outages. Every
            marker is also listed as text.
          </p>
        </div>

        <div className="order-1 lg:order-2">
          <OutageList
            items={filteredOutages}
            headingId="current-disruptions-heading"
            emptyMessage={
              outages.length === 0
                ? "No lift disruptions are currently reported by TfL."
                : "No current disruptions match your search."
            }
          />
        </div>
      </div>
    </section>
  );
}

export default CurrentDisruptions;
