import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { PollLockedError, runPoll } from "@/lib/tfl/poll";

/**
 * The collector endpoint, triggered every five minutes by GitHub Actions.
 *
 *   POST /api/internal/poll-lifts
 *   Authorization: Bearer <CRON_SECRET>
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorised(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(secret);

  // Constant-time compare, with a length guard because timingSafeEqual throws
  // when the buffers differ in length.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function POST(request: Request): Promise<NextResponse> {
  let secret: string;
  try {
    secret = getEnv().CRON_SECRET;
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid configuration" },
      { status: 500 },
    );
  }

  if (!isAuthorised(request, secret)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorised" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  try {
    const outcome = await runPoll();

    return NextResponse.json(
      {
        ok: outcome.ok,
        pollRunId: outcome.pollRunId,
        status: outcome.status,
        itemsReceived: outcome.itemsReceived,
        normalizedItems: outcome.normalizedItems,
        newOutages: outcome.newOutages,
        updatedOutages: outcome.updatedOutages,
        resolvedOutages: outcome.resolvedOutages,
        unresolvedStations: outcome.unresolvedStations,
        durationMs: outcome.durationMs,
        ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
      },
      // A recorded failure is still a successful *recording*, but the caller
      // (and `curl --fail`) should know the feed did not answer.
      { status: outcome.ok ? 200 : 502 },
    );
  } catch (error) {
    if (error instanceof PollLockedError) {
      return NextResponse.json(
        { ok: false, error: "A poll is already in progress; no work was done." },
        { status: 409 },
      );
    }

    console.error("[poll-lifts] Unexpected failure", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unexpected failure" },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: false, error: "Use POST with an Authorization: Bearer <CRON_SECRET> header." },
    { status: 405, headers: { Allow: "POST" } },
  );
}
