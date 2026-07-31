import { PrismaClient } from "@prisma/client";

/** One client for the whole test run, pointed at TEST_DATABASE_URL. */
export const testPrisma = new PrismaClient({ log: ["error"] });

const TABLES = [
  "OutageObservation",
  "Outage",
  "Lift",
  "StationAlias",
  "Station",
  "PollRun",
] as const;

export async function resetDatabase(): Promise<void> {
  await testPrisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export async function disconnect(): Promise<void> {
  await testPrisma.$disconnect();
}
