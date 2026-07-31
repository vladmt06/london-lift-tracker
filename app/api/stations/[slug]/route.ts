import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStationDetail } from "@/lib/metrics/station-metrics";

/** GET /api/stations/[slug] — metadata, current outages, history and metrics. */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const detail = await getStationDetail(slug, prisma);

  if (!detail) {
    return NextResponse.json({ error: `No station with slug "${slug}"` }, { status: 404 });
  }

  const { summary } = detail;

  return NextResponse.json({
    station: {
      name: summary.name,
      slug: summary.slug,
      latitude: summary.latitude,
      longitude: summary.longitude,
      modes: summary.modes,
      lines: summary.lines,
      resolutionStatus: summary.resolutionStatus,
      tflStationId: detail.tflStationId,
      naptanId: detail.naptanId,
      metadataSource: detail.metadataSource,
      firstSeenAt: detail.firstSeenAt.toISOString(),
    },
    metrics: {
      activeOutages: summary.activeOutages,
      observedOutageCount: summary.observedOutageCount,
      observedDowntimeMs: summary.observedDowntimeMs,
      atLeastOneLiftDisruptedMs: summary.atLeastOneLiftDisruptedMs,
      medianResolvedMs: summary.medianResolvedMs,
      longestResolvedMs: summary.longestResolvedMs,
      lastObservedDisruptionAt: summary.lastObservedDisruptionAt?.toISOString() ?? null,
    },
    activeOutages: detail.activeOutages.map((outage) => ({
      id: outage.id,
      liftName: outage.liftName,
      message: outage.message,
      openedAt: outage.openedAt.toISOString(),
      firstSeenAt: outage.firstSeenAt.toISOString(),
      lastSeenAt: outage.lastSeenAt.toISOString(),
      durationMs: outage.durationMs,
      ongoingAtCollectionStart: outage.ongoingAtCollectionStart,
    })),
    resolvedOutages: detail.resolvedOutages.map((outage) => ({
      id: outage.id,
      liftName: outage.liftName,
      message: outage.message,
      openedAt: outage.openedAt.toISOString(),
      closedAt: outage.closedAt.toISOString(),
      durationMs: outage.durationMs,
      closureInferred: outage.closureInferred,
      ongoingAtCollectionStart: outage.ongoingAtCollectionStart,
    })),
    collectionStartedAt: detail.collectionStartedAt?.toISOString() ?? null,
    note:
      "Outage start times are when this service first observed the disruption, " +
      "not necessarily when the lift failed. End times are inferred from the " +
      "disruption disappearing from the TfL feed.",
  });
}
