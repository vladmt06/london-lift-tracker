import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PollStatus } from "@prisma/client";
import { disconnect, resetDatabase, testPrisma } from "./helpers/db";
import { clockFrom, feedRecord, stubFeed } from "./helpers/feed";
import { runPoll } from "@/lib/tfl/poll";
import { REFRESH_AFTER_MS, isFeedStale, resetRefreshGuard } from "@/lib/tfl/refresh";
import { MINUTE_MS } from "@/lib/metrics/duration";

/**
 * On-demand refresh exists because GitHub's scheduler drops runs. What matters
 * is the gate: a page view must not turn into a poll on every request.
 */

const WEMBLEY = feedRecord(
  "940GZZLUWYP",
  ["940GZZLUWYP-Lift-5"],
  "WEMBLEY PARK STATION: no lift service.",
);

const START = "2026-07-31T09:00:00.000Z";

beforeEach(async () => {
  await resetDatabase();
  resetRefreshGuard();
});

afterAll(async () => {
  await disconnect();
});

describe("staleness gate", () => {
  it("treats a database with no successful poll as stale", async () => {
    expect(await isFeedStale(testPrisma, new Date(START))).toBe(true);
  });

  it("is not stale immediately after a successful poll", async () => {
    const clock = clockFrom(new Date(START));
    await runPoll({
      prisma: testPrisma,
      fetchLiftDisruptionsImpl: stubFeed([WEMBLEY]),
      resolver: { allowNetwork: false },
      now: clock.now,
    });

    const justAfter = new Date(new Date(START).getTime() + MINUTE_MS);
    expect(await isFeedStale(testPrisma, justAfter)).toBe(false);
  });

  it("becomes stale once the threshold has passed", async () => {
    const clock = clockFrom(new Date(START));
    await runPoll({
      prisma: testPrisma,
      fetchLiftDisruptionsImpl: stubFeed([WEMBLEY]),
      resolver: { allowNetwork: false },
      now: clock.now,
    });

    const justBefore = new Date(new Date(START).getTime() + REFRESH_AFTER_MS - 1);
    const atThreshold = new Date(new Date(START).getTime() + REFRESH_AFTER_MS);

    expect(await isFeedStale(testPrisma, justBefore)).toBe(false);
    expect(await isFeedStale(testPrisma, atThreshold)).toBe(true);
  });

  it("ignores failed polls when judging freshness", async () => {
    // A failure must not make the feed look fresh, or an outage-closing bug
    // could hide behind a broken feed.
    await testPrisma.pollRun.create({
      data: {
        startedAt: new Date(START),
        completedAt: new Date(START),
        status: PollStatus.FAILED,
        errorMessage: "timeout",
      },
    });

    expect(await isFeedStale(testPrisma, new Date(START))).toBe(true);
  });

  it("refreshes at most every few minutes regardless of traffic", async () => {
    const clock = clockFrom(new Date(START));
    await runPoll({
      prisma: testPrisma,
      fetchLiftDisruptionsImpl: stubFeed([WEMBLEY]),
      resolver: { allowNetwork: false },
      now: clock.now,
    });

    // Simulate a burst of page views one minute later: none should poll.
    const oneMinuteLater = new Date(new Date(START).getTime() + MINUTE_MS);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => isFeedStale(testPrisma, oneMinuteLater)),
    );

    expect(decisions.every((stale) => stale === false)).toBe(true);
    expect(await testPrisma.pollRun.count()).toBe(1);
  });
});
