/**
 * Inspect the live TfL lift-disruption feed and save it as a fixture.
 *
 * Read-only by design: this script never touches the database. Its purpose is to
 * let a human see the payload's ACTUAL shape before any adapter is written, and
 * to capture a real response for tests.
 *
 *   npm run inspect:tfl
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import "dotenv/config";
import { fetchLiftDisruptions } from "@/lib/tfl/client";

const FIXTURE_PATH = resolve(process.cwd(), "fixtures/tfl-lift-disruptions.json");

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value instanceof Date) return "date";
  return typeof value;
}

async function main(): Promise<void> {
  console.info("Fetching GET https://api.tfl.gov.uk/Disruptions/Lifts/v2 ...");

  const response = await fetchLiftDisruptions();
  const payload = response.payload;

  console.info("");
  console.info("── Response ─────────────────────────────────────────────");
  console.info(`HTTP status     : ${response.httpStatus}`);
  console.info(`Round trip      : ${response.durationMs}ms (attempts: ${response.attempts})`);
  console.info(`Payload hash    : ${response.responseHash.slice(0, 16)}…`);
  console.info(`Top-level type  : ${describeValue(payload)}`);

  if (!Array.isArray(payload)) {
    console.warn("Payload is not an array — printing its keys instead.");
    console.info(Object.keys(payload as Record<string, unknown>).join(", "));
  } else {
    console.info(`Record count    : ${payload.length}`);

    const keyFrequency = new Map<string, number>();
    for (const record of payload) {
      if (record && typeof record === "object") {
        for (const key of Object.keys(record as Record<string, unknown>)) {
          keyFrequency.set(key, (keyFrequency.get(key) ?? 0) + 1);
        }
      }
    }

    console.info("");
    console.info("── Keys across all records ──────────────────────────────");
    for (const [key, count] of [...keyFrequency.entries()].sort((a, b) => b[1] - a[1])) {
      console.info(`  ${key.padEnd(26)} present on ${count}/${payload.length} records`);
    }

    console.info("");
    console.info("── First 3 records ──────────────────────────────────────");
    for (const [index, record] of payload.slice(0, 3).entries()) {
      console.info(`\n[${index}]`);
      if (record && typeof record === "object") {
        for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
          const rendered =
            typeof value === "string" && value.length > 160
              ? `${value.slice(0, 160)}…`
              : JSON.stringify(value);
          console.info(`  ${key} (${describeValue(value)}): ${rendered}`);
        }
      } else {
        console.info(`  ${JSON.stringify(record)}`);
      }
    }
  }

  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.info("");
  console.info(`Saved fixture → ${FIXTURE_PATH}`);
  console.info("No database writes were performed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
