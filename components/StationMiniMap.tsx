"use client";

import dynamic from "next/dynamic";
import type { MapMarker } from "@/lib/utils/view-types";

/** Single-station map. Leaflet is client-only, so it is loaded dynamically. */

const LiftMap = dynamic(() => import("@/components/LiftMap").then((mod) => mod.LiftMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-ink-muted" role="status">
      Loading map…
    </div>
  ),
});

export function StationMiniMap({ marker, nowIso }: { marker: MapMarker; nowIso: string }) {
  return (
    <div className="h-56 overflow-hidden rounded border border-rule bg-paper">
      <LiftMap markers={[marker]} nowIso={nowIso} />
    </div>
  );
}

export default StationMiniMap;
