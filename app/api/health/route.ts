import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getFeedHealth } from "@/lib/metrics/station-metrics";

/** GET /api/health — feed freshness, for monitoring and the UI banner. */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const health = await getFeedHealth(prisma);

    return NextResponse.json({
      status: health.status,
      lastSuccessfulPoll: health.lastSuccessfulPollAt?.toISOString() ?? null,
      minutesSinceSuccess: health.minutesSinceSuccess,
      collectionStartedAt: health.collectionStartedAt?.toISOString() ?? null,
      lastAttempt: health.lastAttemptAt?.toISOString() ?? null,
      lastAttemptStatus: health.lastAttemptStatus,
      successfulPollCount: health.successfulPollCount,
      failedPollsLast24h: health.failedPollsLast24h,
      pollIntervalMinutes: 5,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "unavailable",
        error: error instanceof Error ? error.message : "Health check failed",
      },
      { status: 503 },
    );
  }
}
