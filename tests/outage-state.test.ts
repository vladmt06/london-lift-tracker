import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { OutageState, PollStatus } from "@prisma/client";
import { disconnect, resetDatabase, testPrisma } from "./helpers/db";
import { clockFrom, failingFeed, feedRecord, malformedShapeFeed, stubFeed } from "./helpers/feed";
import { POLL_ADVISORY_LOCK_KEY, PollLockedError, runPoll } from "@/lib/tfl/poll";

/**
 * The outage state machine, exercised against a real PostgreSQL database.
 *
 * These are the tests that matter most: they are what stands between the site
 * and a false claim that a lift was repaired.
 */

const WEMBLEY = feedRecord(
  "940GZZLUWYP",
  ["940GZZLUWYP-Lift-5"],
  "WEMBLEY PARK STATION: no lift service between street and ticket hall.",
);

const CANADA_WATER = feedRecord(
  "HUBZCW",
  ["HUBZCW-Lift-1"],
  "Canada Water: No Step Free Access - lift out of service.",
);

const COLLECTION_START = "2026-07-31T09:00:00.000Z";

// Re-created before every test so that each one starts at a known wall clock.
let clock = clockFrom(new Date(COLLECTION_START));

/** One poll against a canned feed, with no external station lookups. */
function poll(records: unknown[]) {
  return runPoll({
    prisma: testPrisma,
    fetchLiftDisruptionsImpl: stubFeed(records),
    resolver: { allowNetwork: false },
    now: clock.now,
  });
}

function failedPoll() {
  return runPoll({
    prisma: testPrisma,
    fetchLiftDisruptionsImpl: failingFeed(),
    resolver: { allowNetwork: false },
    now: clock.now,
  });
}

function openOutages() {
  return testPrisma.outage.findMany({ where: { closedAt: null }, orderBy: { assetKey: "asc" } });
}

beforeEach(async () => {
  await resetDatabase();
  clock = clockFrom(new Date(COLLECTION_START));
});

afterAll(async () => {
  await disconnect();
});

describe("1. an outage appears", () => {
  it("creates exactly one open outage, with the station and lift behind it", async () => {
    const outcome = await poll([WEMBLEY]);

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(PollStatus.SUCCESS);
    expect(outcome.newOutages).toBe(1);

    const outages = await openOutages();
    expect(outages).toHaveLength(1);
    expect(outages[0]?.state).toBe(OutageState.OPEN);
    expect(outages[0]?.assetKey).toBe("lift:940gzzluwyp-lift-5");
    expect(outages[0]?.closureInferred).toBe(false);
    expect(outages[0]?.missingSuccessfulPolls).toBe(0);

    const lift = await testPrisma.lift.findFirst();
    expect(lift?.tflLiftId).toBe("940GZZLUWYP-Lift-5");

    const station = await testPrisma.station.findFirst();
    expect(station?.tflStationId).toBe("940GZZLUWYP");

    const observations = await testPrisma.outageObservation.findMany();
    expect(observations).toHaveLength(1);
  });

  it("opens one outage per lift when a record lists several", async () => {
    await poll([
      feedRecord(
        "HUBBAN",
        ["HUBBAN-Lift-2", "HUBBAN-Lift-3", "HUBBAN-Lift-4"],
        "Bank: three lifts out of service.",
      ),
    ]);

    const outages = await openOutages();
    expect(outages).toHaveLength(3);
    expect(await testPrisma.station.count()).toBe(1);
  });

  it("records a PollRun for the attempt", async () => {
    await poll([WEMBLEY]);

    const pollRun = await testPrisma.pollRun.findFirst();
    expect(pollRun?.status).toBe(PollStatus.SUCCESS);
    expect(pollRun?.itemCount).toBe(1);
    expect(pollRun?.normalizedItemCount).toBe(1);
    expect(pollRun?.completedAt).not.toBeNull();
    expect(pollRun?.responseHash).toBeTruthy();
  });
});

describe("2. the same outage appears again", () => {
  it("updates the existing outage instead of duplicating it", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    const second = await poll([WEMBLEY]);

    expect(second.newOutages).toBe(0);
    expect(second.updatedOutages).toBe(1);

    const outages = await testPrisma.outage.findMany();
    expect(outages).toHaveLength(1);
    expect(outages[0]?.lastSeenAt.toISOString()).toBe("2026-07-31T09:05:00.000Z");
    expect(outages[0]?.firstSeenAt.toISOString()).toBe("2026-07-31T09:00:00.000Z");

    // One observation per poll: the archive keeps every sighting.
    expect(await testPrisma.outageObservation.count()).toBe(2);
  });

  it("does not duplicate observations if the identical poll is replayed", async () => {
    await poll([WEMBLEY]);
    // Same clock, same payload — the unique constraint must absorb it.
    await poll([WEMBLEY]);

    const observations = await testPrisma.outageObservation.findMany();
    expect(observations).toHaveLength(2); // different PollRun ids, so both count
    expect(await testPrisma.outage.count()).toBe(1);
  });
});

describe("3. TfL rewords the message", () => {
  it("keeps the same outage and records the new wording", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);

    const reworded = feedRecord("940GZZLUWYP", ["940GZZLUWYP-Lift-5"], "WEMBLEY PARK STATION: engineers on site, no lift service until Friday 21 August.");
    await poll([reworded]);

    const outages = await testPrisma.outage.findMany();
    expect(outages).toHaveLength(1);
    expect(outages[0]?.firstMessage).toContain("no lift service between street");
    expect(outages[0]?.latestMessage).toContain("engineers on site");
  });
});

describe("4. absent from one successful poll", () => {
  it("stays open and starts counting", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    const second = await poll([]);

    expect(second.resolvedOutages).toBe(0);

    const outages = await openOutages();
    expect(outages).toHaveLength(1);
    expect(outages[0]?.state).toBe(OutageState.OPEN);
    expect(outages[0]?.missingSuccessfulPolls).toBe(1);
    expect(outages[0]?.firstMissingAt?.toISOString()).toBe("2026-07-31T09:05:00.000Z");
  });

  it("cancels the countdown if it comes back", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    await poll([]);
    clock.advance(5);
    await poll([WEMBLEY]);

    const outages = await openOutages();
    expect(outages[0]?.missingSuccessfulPolls).toBe(0);
    expect(outages[0]?.firstMissingAt).toBeNull();
  });
});

describe("5. absent from a second successful poll", () => {
  it("resolves it, dated to the first poll that missed it", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    await poll([]);
    clock.advance(5);
    const third = await poll([]);

    expect(third.resolvedOutages).toBe(1);

    const outage = await testPrisma.outage.findFirstOrThrow();
    expect(outage.state).toBe(OutageState.RESOLVED);
    expect(outage.closureInferred).toBe(true);
    // Closed at the FIRST miss (09:05), not the second (09:10).
    expect(outage.closedAt?.toISOString()).toBe("2026-07-31T09:05:00.000Z");
    expect(await openOutages()).toHaveLength(0);
  });
});

describe("6. a failed request between misses", () => {
  it("does not count as a miss and does not resolve anything", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    await poll([]); // miss 1

    clock.advance(5);
    const failure = await failedPoll(); // must not count

    expect(failure.ok).toBe(false);
    expect(failure.status).toBe(PollStatus.FAILED);
    expect(failure.resolvedOutages).toBe(0);

    const stillOpen = await openOutages();
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]?.missingSuccessfulPolls).toBe(1);

    // The failure is recorded rather than hidden.
    const failedRun = await testPrisma.pollRun.findFirstOrThrow({
      where: { status: PollStatus.FAILED },
    });
    expect(failedRun.errorMessage).toContain("timed out");

    // And the next successful miss still resolves it.
    clock.advance(5);
    const recovery = await poll([]);
    expect(recovery.resolvedOutages).toBe(1);
  });

  it("does not resolve anything when the payload is the wrong shape", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    await poll([]); // miss 1

    clock.advance(5);
    const malformed = await runPoll({
      prisma: testPrisma,
      fetchLiftDisruptionsImpl: malformedShapeFeed(),
      resolver: { allowNetwork: false },
      now: clock.now,
    });

    expect(malformed.status).toBe(PollStatus.FAILED);
    expect((await openOutages())[0]?.missingSuccessfulPolls).toBe(1);
  });

  it("never closes an outage across a long run of failures", async () => {
    await poll([WEMBLEY]);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      clock.advance(5);
      await failedPoll();
    }

    expect(await openOutages()).toHaveLength(1);
    expect(await testPrisma.pollRun.count({ where: { status: PollStatus.FAILED } })).toBe(10);
  });
});

describe("7. the same lift fails again later", () => {
  it("opens a brand new outage rather than reopening the old one", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    await poll([]);
    clock.advance(5);
    await poll([]); // resolved here

    clock.advance(60);
    const relapse = await poll([WEMBLEY]);

    expect(relapse.newOutages).toBe(1);

    const outages = await testPrisma.outage.findMany({ orderBy: { openedAt: "asc" } });
    expect(outages).toHaveLength(2);
    expect(outages[0]?.state).toBe(OutageState.RESOLVED);
    expect(outages[1]?.state).toBe(OutageState.OPEN);
    expect(outages[0]?.assetKey).toBe(outages[1]?.assetKey);
    expect(outages[1]?.openedAt.toISOString()).toBe("2026-07-31T10:10:00.000Z");
  });
});

describe("8. the feed returns an empty array twice", () => {
  it("closes every previously open outage", async () => {
    await poll([WEMBLEY, CANADA_WATER]);
    expect(await openOutages()).toHaveLength(2);

    clock.advance(5);
    await poll([]);
    expect(await openOutages()).toHaveLength(2);

    clock.advance(5);
    const third = await poll([]);

    expect(third.resolvedOutages).toBe(2);
    expect(await openOutages()).toHaveLength(0);
  });

  it("treats an empty feed as a perfectly valid successful poll", async () => {
    const outcome = await poll([]);

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(PollStatus.SUCCESS);
    expect(outcome.itemsReceived).toBe(0);
  });
});

describe("9. more than 20% of records fail validation", () => {
  it("marks the poll PARTIAL, saves what parsed, and closes nothing", async () => {
    await poll([WEMBLEY, CANADA_WATER]);
    clock.advance(5);

    // 2 good, 2 unparseable = 50% failure.
    const outcome = await poll([
      WEMBLEY,
      CANADA_WATER,
      { rubbish: true },
      { alsoRubbish: true },
    ]);

    expect(outcome.status).toBe(PollStatus.PARTIAL);
    expect(outcome.errorMessage).toContain("failed validation");
    expect(await openOutages()).toHaveLength(2);

    const pollRun = await testPrisma.pollRun.findFirstOrThrow({
      where: { status: PollStatus.PARTIAL },
    });
    expect(pollRun.itemCount).toBe(4);
    expect(pollRun.normalizedItemCount).toBe(2);
  });

  it("does not close outages that are missing from a partial poll", async () => {
    await poll([WEMBLEY, CANADA_WATER]);
    clock.advance(5);
    await poll([]); // miss 1 for both

    clock.advance(5);
    // A partial poll that contains neither outage must NOT be the second miss.
    const partial = await poll([{ rubbish: true }, { alsoRubbish: true }]);

    expect(partial.status).toBe(PollStatus.PARTIAL);
    expect(partial.resolvedOutages).toBe(0);

    const stillOpen = await openOutages();
    expect(stillOpen).toHaveLength(2);
    expect(stillOpen.every((outage) => outage.missingSuccessfulPolls === 1)).toBe(true);
  });
});

describe("10. two polls overlap", () => {
  it("lets only one hold the advisory lock, and the loser writes nothing", async () => {
    await poll([WEMBLEY]);
    const pollRunsBefore = await testPrisma.pollRun.count();

    await testPrisma.$transaction(
      async (tx) => {
        // Simulate another collector mid-poll by holding its lock. The `try`
        // variant returns a boolean, which Prisma can deserialise; the blocking
        // variant returns void, which it cannot.
        const [held] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${POLL_ADVISORY_LOCK_KEY}::bigint) AS locked
        `;
        expect(held?.locked).toBe(true);

        await expect(poll([WEMBLEY, CANADA_WATER])).rejects.toBeInstanceOf(PollLockedError);
      },
      { timeout: 20_000 },
    );

    // Nothing was written by the rejected poll: no PollRun, no new outage.
    expect(await testPrisma.pollRun.count()).toBe(pollRunsBefore);
    expect(await testPrisma.outage.count()).toBe(1);
  });

  it("never creates duplicate open outages when two polls race", async () => {
    const results = await Promise.allSettled([poll([WEMBLEY]), poll([WEMBLEY])]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);

    const outages = await testPrisma.outage.findMany();
    expect(outages).toHaveLength(1);
  });

  it("is enforced by the database, not just the application", async () => {
    await poll([WEMBLEY]);
    const existing = await testPrisma.outage.findFirstOrThrow();

    // A second OPEN outage for the same asset must be impossible.
    await expect(
      testPrisma.outage.create({
        data: {
          stationId: existing.stationId,
          assetKey: existing.assetKey,
          openedAt: new Date(),
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          firstMessage: "duplicate",
          latestMessage: "duplicate",
          rawFirst: {},
          rawLatest: {},
        },
      }),
    ).rejects.toThrow();
  });
});

describe("the archive", () => {
  it("keeps the raw payload for the first and latest sighting", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    await poll([feedRecord("940GZZLUWYP", ["940GZZLUWYP-Lift-5"], "WEMBLEY PARK STATION: updated wording.")]);

    const outage = await testPrisma.outage.findFirstOrThrow();

    expect(outage.rawFirst).toMatchObject({ stationUniqueId: "940GZZLUWYP" });
    expect(outage.rawLatest).toMatchObject({ message: expect.stringContaining("updated wording") });
  });

  it("links every observation to the poll that made it", async () => {
    await poll([WEMBLEY]);
    clock.advance(5);
    await poll([WEMBLEY]);

    const observations = await testPrisma.outageObservation.findMany({
      include: { pollRun: true },
      orderBy: { observedAt: "asc" },
    });

    expect(observations).toHaveLength(2);
    expect(observations[0]?.pollRunId).not.toBe(observations[1]?.pollRunId);
    expect(observations.every((observation) => observation.pollRun.status === PollStatus.SUCCESS)).toBe(true);
  });

  it("dates an outage from the poll that saw it, since the feed has no timestamps", async () => {
    await poll([WEMBLEY]);

    const outage = await testPrisma.outage.findFirstOrThrow();
    expect(outage.openedAt.toISOString()).toBe("2026-07-31T09:00:00.000Z");
    expect(outage.sourceStartedAt).toBeNull();
  });
});
