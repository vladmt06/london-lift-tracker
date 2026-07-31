import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();

/**
 * Integration tests run against a REAL PostgreSQL database, because the parts
 * most worth testing — the advisory lock, the partial unique index, transaction
 * rollback — do not exist in a mock.
 */
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/lift_tracker_test";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    env: {
      DATABASE_URL: testDatabaseUrl,
      TEST_DATABASE_URL: testDatabaseUrl,
      CRON_SECRET: "test-cron-secret-0123456789abcdef",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
    // Test files share one database, so they must not run in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
