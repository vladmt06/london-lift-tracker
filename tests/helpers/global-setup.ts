import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

loadEnv();

/**
 * Bring the test database up to the current migration state once per run.
 * `migrate deploy` is idempotent, so this is safe to repeat.
 */
export default function setup(): void {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/lift_tracker_test";

  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a throwaway PostgreSQL database " +
        "— they truncate every table between cases.",
    );
  }

  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  } catch (error) {
    const details =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr?: Buffer }).stderr ?? error.message)
        : String(error);

    throw new Error(
      `Could not migrate the test database at ${databaseUrl}.\n` +
        "Create it first, e.g. `createdb lift_tracker_test`.\n\n" +
        details,
    );
  }
}
