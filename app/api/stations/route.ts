import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  MAX_PAGE_SIZE,
  getCollectionStartedAt,
  getStationSummaries,
  queryStationSummaries,
  type StationSortKey,
} from "@/lib/metrics/station-metrics";

/** GET /api/stations?search=&activeOnly=&sort=&direction=&page=&pageSize= */

export const dynamic = "force-dynamic";

const SORT_KEYS = [
  "name",
  "activeOutages",
  "observedOutageCount",
  "observedDowntime",
  "medianResolved",
  "longestResolved",
  "lastObserved",
] as const satisfies readonly StationSortKey[];

const QuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  activeOnly: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
  minOutages: z.coerce.number().int().min(0).max(10_000).optional(),
  sort: z.enum(SORT_KEYS).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid query parameters",
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const [summaries, collectionStartedAt] = await Promise.all([
    getStationSummaries(prisma, now),
    getCollectionStartedAt(prisma),
  ]);

  const result = queryStationSummaries(summaries, parsed.data);

  return NextResponse.json({
    generatedAt: now.toISOString(),
    collectionStartedAt: collectionStartedAt?.toISOString() ?? null,
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
    stations: result.rows.map((station) => ({
      name: station.name,
      slug: station.slug,
      latitude: station.latitude,
      longitude: station.longitude,
      modes: station.modes,
      lines: station.lines,
      resolutionStatus: station.resolutionStatus,
      activeOutages: station.activeOutages,
      observedOutageCount: station.observedOutageCount,
      observedDowntimeMs: station.observedDowntimeMs,
      atLeastOneLiftDisruptedMs: station.atLeastOneLiftDisruptedMs,
      medianResolvedMs: station.medianResolvedMs,
      longestResolvedMs: station.longestResolvedMs,
      lastObservedDisruptionAt: station.lastObservedDisruptionAt?.toISOString() ?? null,
    })),
    note: "Counts and durations cover only the period since collection began.",
  });
}
