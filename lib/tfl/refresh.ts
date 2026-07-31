import { PollStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import { PollLockedError, runPoll } from "@/lib/tfl/poll";
import { MINUTE_MS } from "@/lib/metrics/duration";

/**
 * On-demand collection.
 *
 * GitHub Actions is the scheduled trigger, but its cron is explicitly
 * best-effort: runs are routinely delayed and sometimes dropped entirely. In
 * practice that left the site showing data twenty minutes old with no way to
 * catch up until someone pressed a button.
 *
 * So a page view also refreshes the feed: if the last successful poll is older
 * than the poll interval, one is started AFTER the response has been sent, so
 * nobody waits for it. The reader who triggered it sees the previous data; the
 * next reader sees fresh data.
 *
 * This supplements the schedule, it does not replace it — with no visitors,
 * the cron is still what keeps history complete.
 *
 * Safety:
 *   • the staleness gate keeps this to at most ~12 polls/hour regardless of traffic
 *   • an in-process guard stops one instance stacking polls
 *   • the Postgres advisory lock stops different instances colliding
 *   • it can never throw into a page render
 */

/** Refresh when the newest successful poll is older than this. */
export const REFRESH_AFTER_MS = 4 * MINUTE_MS;

let inFlight: Promise<void> | null = null;

type Db = Pick<PrismaClient, "pollRun">;

export async function isFeedStale(
  prisma: Db = defaultPrisma,
  now: Date = new Date(),
  thresholdMs: number = REFRESH_AFTER_MS,
): Promise<boolean> {
  const latest = await prisma.pollRun.findFirst({
    where: { status: PollStatus.SUCCESS },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });

  // Never polled successfully: definitely refresh.
  if (!latest) return true;

  return now.getTime() - latest.startedAt.getTime() >= thresholdMs;
}

/**
 * Poll if the data has gone stale. Resolves quietly whether or not it polled.
 * Intended to be called from `after()`, never awaited by a render.
 */
export async function maybeRefreshFeed(options: { prisma?: PrismaClient } = {}): Promise<void> {
  const prisma = options.prisma ?? defaultPrisma;

  if (inFlight) return inFlight;

  const task = (async () => {
    try {
      if (!(await isFeedStale(prisma))) return;

      const outcome = await runPoll({ prisma });

      if (!outcome.ok) {
        console.warn(`[refresh] Poll recorded as failed: ${outcome.errorMessage ?? "unknown"}`);
      }
    } catch (error) {
      if (error instanceof PollLockedError) return; // another poll has it; fine
      console.error(
        `[refresh] On-demand poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      inFlight = null;
    }
  })();

  inFlight = task;
  return task;
}

/** Test-only: clear the in-process guard between cases. */
export function resetRefreshGuard(): void {
  inFlight = null;
}
