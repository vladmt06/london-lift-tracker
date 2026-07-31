/**
 * Run a single collection cycle locally, against the real TfL feed and the
 * database in DATABASE_URL. This is the same code path the cron route uses.
 *
 *   npm run poll:once
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { PollLockedError, runPoll } from "@/lib/tfl/poll";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const outcome = await runPoll();

  console.info("── Poll result ──────────────────────────────────────────");
  console.info(`Status            : ${outcome.status}${outcome.ok ? "" : " (see error below)"}`);
  console.info(`PollRun id        : ${outcome.pollRunId}`);
  console.info(`Feed records      : ${outcome.itemsReceived}`);
  console.info(`Normalised lifts  : ${outcome.normalizedItems}`);
  console.info(`New outages       : ${outcome.newOutages}`);
  console.info(`Updated outages   : ${outcome.updatedOutages}`);
  console.info(`Resolved outages  : ${outcome.resolvedOutages}`);
  console.info(`Unresolved stations: ${outcome.unresolvedStations}`);
  console.info(`Duration          : ${outcome.durationMs}ms (wall ${Date.now() - startedAt}ms)`);

  if (outcome.errorMessage) {
    console.warn(`Note              : ${outcome.errorMessage}`);
  }

  const [openOutages, stations] = await Promise.all([
    prisma.outage.count({ where: { closedAt: null } }),
    prisma.station.count(),
  ]);

  console.info("");
  console.info(`Open outages now  : ${openOutages}`);
  console.info(`Known stations    : ${stations}`);

  if (!outcome.ok) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    if (error instanceof PollLockedError) {
      console.error("Another poll is already running; nothing was written.");
      process.exitCode = 0;
      return;
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
