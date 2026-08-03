import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { searchStopPoints } from "@/lib/tfl/client";
import { displayNameFrom, railLineNames, railModes } from "@/lib/tfl/station-resolver";
import { fetchStopPoint } from "@/lib/tfl/client";
import { getCollectionStartedAt, getFeedHealth } from "@/lib/metrics/station-metrics";
import { normalizeStationName, slugify } from "@/lib/utils/text";

/**
 * GET /api/lookup?q=oxford+circus
 *
 * Answers "is there a lift problem at this station?" for ANY London station,
 * including the great majority that have never appeared in the disruption feed
 * and therefore have no row in our database. Searching only our own records
 * would return nothing for a working station, which reads as "not found"
 * rather than "nothing wrong".
 *
 * A negative answer here means TfL is not reporting a fault. It is deliberately
 * not a claim that every lift works, nor that the station is step-free — some
 * stations have no lifts at all.
 */

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
});

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ q: url.searchParams.get("q") ?? "" });

  if (!parsed.success) {
    return NextResponse.json({ found: false, error: "Provide ?q= with at least 2 characters" }, { status: 400 });
  }

  const query = parsed.data.q;
  const normalized = normalizeStationName(query);
  const now = new Date();

  const [health, collectionStartedAt] = await Promise.all([
    getFeedHealth(prisma, now),
    getCollectionStartedAt(prisma),
  ]);

  const asOf = {
    asOf: health.lastSuccessfulPollAt?.toISOString() ?? null,
    collectionStartedAt: collectionStartedAt?.toISOString() ?? null,
    feedStatus: health.status,
  };

  // --- 1. A station we already track -------------------------------------
  const known = await prisma.station.findFirst({
    where: {
      OR: [
        { slug: slugify(normalized) },
        { name: { equals: query, mode: "insensitive" } },
        { name: { contains: query, mode: "insensitive" } },
      ],
    },
    include: {
      outages: {
        select: { closedAt: true, lastSeenAt: true },
      },
    },
    orderBy: { name: "asc" },
  });

  if (known) {
    const activeOutages = known.outages.filter((outage) => outage.closedAt === null).length;
    const lastDisruptionAt = known.outages.reduce<Date | null>(
      (latest, outage) => (!latest || outage.lastSeenAt > latest ? outage.lastSeenAt : latest),
      null,
    );

    return NextResponse.json({
      found: true,
      knownToUs: true,
      station: {
        name: known.name,
        slug: known.slug,
        lines: known.lines,
        modes: known.modes,
        latitude: known.latitude,
        longitude: known.longitude,
      },
      activeOutages,
      observedOutageCount: known.outages.length,
      lastDisruptionAt: lastDisruptionAt?.toISOString() ?? null,
      ...asOf,
    });
  }

  // --- 2. Any other London rail station, via TfL --------------------------
  // No row here means no disruption has ever been reported at it since
  // collection began — which is the answer, not a failure to find it.
  try {
    const search = await searchStopPoints(query);
    const match = search?.matches?.[0];

    if (!match?.id) {
      return NextResponse.json({ found: false, query, ...asOf });
    }

    const stopPoint = await fetchStopPoint(match.id).catch(() => null);
    const officialName = stopPoint?.commonName ?? match.name ?? query;

    return NextResponse.json({
      found: true,
      knownToUs: false,
      station: {
        name: displayNameFrom(officialName),
        slug: null,
        lines: stopPoint ? railLineNames(stopPoint) : [],
        modes: stopPoint ? railModes(stopPoint) : (match.modes ?? []),
        latitude: stopPoint?.lat ?? match.lat ?? null,
        longitude: stopPoint?.lon ?? match.lon ?? null,
      },
      activeOutages: 0,
      observedOutageCount: 0,
      lastDisruptionAt: null,
      ...asOf,
    });
  } catch {
    return NextResponse.json({ found: false, query, ...asOf });
  }
}
