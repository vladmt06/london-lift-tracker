"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { formatDuration, formatLondonDateTime } from "@/lib/metrics/duration";
import type { MapMarker, MapMarkerKind } from "@/lib/utils/view-types";

/**
 * Geographic view of lift disruptions.
 *
 * The map is an ALTERNATIVE presentation, never the only one — every marker
 * here also appears in the outage list beside it. Marker status is encoded as
 * shape as well as colour (filled circle = active, square = restored in the
 * last 24 hours, hollow dot = historical), and each marker carries a full
 * text label for assistive technology.
 */

const LONDON_CENTRE: [number, number] = [51.5074, -0.1278];

const KIND_LABEL: Record<MapMarkerKind, string> = {
  active: "Active lift disruption",
  restored: "Restored in the last 24 hours",
  historical: "Previously observed disruption",
};

function markerIcon(kind: MapMarkerKind, label: string): L.DivIcon {
  const size = kind === "active" ? 20 : kind === "restored" ? 16 : 12;

  return L.divIcon({
    className: "",
    html: `<span class="marker-glyph marker-${kind}" role="img" aria-label="${escapeHtml(label)}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function describeMarker(marker: MapMarker): string {
  const parts = [KIND_LABEL[marker.kind], `at ${marker.stationName}`];
  if (marker.liftName) parts.push(marker.liftName);
  if (marker.ongoingAtCollectionStart) {
    parts.push("ongoing, started before collection began so its length is unknown");
  } else if (marker.durationMs !== null) {
    parts.push(`for ${formatDuration(marker.durationMs)}`);
  }
  if (marker.kind === "historical") {
    parts.push(
      `${marker.observedOutageCount} observed outage${marker.observedOutageCount === 1 ? "" : "s"}`,
    );
  }
  return parts.join(", ");
}

/** Keep every marker in view without hard-coding a zoom level. */
function FitToMarkers({ markers }: { markers: MapMarker[] }) {
  const map = useMap();

  useEffect(() => {
    if (markers.length === 0) return;

    const bounds = L.latLngBounds(
      markers.map((marker) => [marker.latitude, marker.longitude] as [number, number]),
    );

    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 14, animate: false });
  }, [map, markers]);

  return null;
}

export function LiftMap({ markers, nowIso }: { markers: MapMarker[]; nowIso: string }) {
  const sorted = useMemo(
    () =>
      [...markers].sort((a, b) => {
        // Draw historical first so active markers sit on top.
        const weight: Record<MapMarkerKind, number> = { historical: 0, restored: 1, active: 2 };
        return weight[a.kind] - weight[b.kind];
      }),
    [markers],
  );

  return (
    <MapContainer
      center={LONDON_CENTRE}
      zoom={11}
      scrollWheelZoom={false}
      style={{ height: "100%", width: "100%" }}
      // Announced when a keyboard user tabs into the map.
      aria-label={`Map of ${markers.length} London stations with observed lift disruptions. The same information is listed below the map as text.`}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={18}
      />

      <FitToMarkers markers={sorted} />

      {sorted.map((marker) => {
        const label = describeMarker(marker);

        return (
          <Marker
            key={marker.id}
            position={[marker.latitude, marker.longitude]}
            icon={markerIcon(marker.kind, label)}
            title={label}
            alt={label}
            keyboard
          >
            <Popup>
              <div className="min-w-[14rem] text-sm">
                <p className="font-bold">{marker.stationName}</p>
                <p className="text-ink-muted">
                  {marker.liftName ?? "Lift not identified in the feed"}
                </p>
                <p className="mt-1 font-medium">{KIND_LABEL[marker.kind]}</p>

                {marker.message ? <p className="mt-1">{marker.message}</p> : null}

                {marker.firstSeenAtIso ? (
                  <p className="mt-1 text-ink-muted">
                    First observed {formatLondonDateTime(new Date(marker.firstSeenAtIso))}
                  </p>
                ) : null}

                {marker.ongoingAtCollectionStart ? (
                  <p className="text-ink-muted">
                    Ongoing. It began before collection started, so its length is unknown.
                  </p>
                ) : marker.durationMs !== null ? (
                  <p className="text-ink-muted">
                    {marker.kind === "active" ? "Disrupted for " : "Lasted "}
                    {formatDuration(marker.durationMs)}
                  </p>
                ) : null}

                {marker.kind === "historical" ? (
                  <p className="text-ink-muted">
                    {marker.observedOutageCount} observed outage
                    {marker.observedOutageCount === 1 ? "" : "s"} since collection began
                  </p>
                ) : null}

                <p className="mt-2">
                  <Link
                    href={`/stations/${marker.stationSlug}`}
                    className="text-link underline underline-offset-4"
                  >
                    Station history
                  </Link>
                </p>
              </div>
            </Popup>
          </Marker>
        );
      })}

      <MapDataTimestamp nowIso={nowIso} />
    </MapContainer>
  );
}

/** Non-visual: keeps the rendered map honest about when its data was read. */
function MapDataTimestamp({ nowIso }: { nowIso: string }) {
  return (
    <span className="sr-only">
      Map data as at {formatLondonDateTime(new Date(nowIso))} London time.
    </span>
  );
}

export default LiftMap;
