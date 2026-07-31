import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDashboardData } from "@/lib/metrics/station-metrics";

/**
 * GET /api/dashboard — everything the homepage shows, in one response:
 * headline metrics, current disruptions, and station coordinates for the map.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const now = new Date();
  const data = await getDashboardData(prisma, now);

  return NextResponse.json({
    generatedAt: now.toISOString(),
    collectionStartedAt: data.collectionStartedAt?.toISOString() ?? null,
    feedHealth: {
      status: data.feedHealth.status,
      lastSuccessfulPoll: data.feedHealth.lastSuccessfulPollAt?.toISOString() ?? null,
      minutesSinceSuccess: data.feedHealth.minutesSinceSuccess,
      lastAttempt: data.feedHealth.lastAttemptAt?.toISOString() ?? null,
      lastAttemptStatus: data.feedHealth.lastAttemptStatus,
      successfulPollCount: data.feedHealth.successfulPollCount,
      failedPollsLast24h: data.feedHealth.failedPollsLast24h,
    },
    metrics: {
      activeOutageCount: data.activeOutageCount,
      affectedStationCount: data.affectedStationCount,
      longestActiveOutageMs: data.longestActiveOutage?.durationMs ?? null,
      unresolvedStationCount: data.unresolvedStationCount,
    },
    activeOutages: data.activeOutages.map((outage) => ({
      id: outage.id,
      stationName: outage.stationName,
      stationSlug: outage.stationSlug,
      latitude: outage.latitude,
      longitude: outage.longitude,
      liftName: outage.liftName,
      message: outage.message,
      openedAt: outage.openedAt.toISOString(),
      firstSeenAt: outage.firstSeenAt.toISOString(),
      lastSeenAt: outage.lastSeenAt.toISOString(),
      durationMs: outage.durationMs,
      ongoingAtCollectionStart: outage.ongoingAtCollectionStart,
    })),
    recentlyResolved: data.recentlyResolved.map((outage) => ({
      id: outage.id,
      stationName: outage.stationName,
      stationSlug: outage.stationSlug,
      latitude: outage.latitude,
      longitude: outage.longitude,
      liftName: outage.liftName,
      openedAt: outage.openedAt.toISOString(),
      closedAt: outage.closedAt.toISOString(),
      durationMs: outage.durationMs,
      closureInferred: outage.closureInferred,
    })),
    stationsWithHistory: data.stationsWithHistory,
    topStations: data.topStations.map((station) => ({
      name: station.name,
      slug: station.slug,
      activeOutages: station.activeOutages,
      observedOutageCount: station.observedOutageCount,
      observedDowntimeMs: station.observedDowntimeMs,
      medianResolvedMs: station.medianResolvedMs,
      lastObservedDisruptionAt: station.lastObservedDisruptionAt?.toISOString() ?? null,
    })),
    disclaimer:
      "All history is limited to what this service observed since collection began. " +
      "Restoration times are inferred from disruptions disappearing from the TfL feed.",
  });
}
