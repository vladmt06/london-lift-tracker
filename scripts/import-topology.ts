/**
 * Optional enrichment: import lift inventory from TfL's static step-free
 * topology extract.
 *
 *   npm run import:topology -- --file=/absolute/path/to/topology.zip
 *   npm run import:topology -- --file=... --create-stations
 *
 * The app does not need this. Feed-only operation is fully supported; this
 * script simply adds real lift names and the areas each lift connects.
 *
 * By default only lifts belonging to stations we already track are imported,
 * so that a bulk import cannot flood the station rankings with stations that
 * have never had an observed outage. Pass --create-stations to import the whole
 * inventory instead.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import "dotenv/config";
import unzipper from "unzipper";
import { ResolutionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseCsv, parseCsvBoolean, readColumn, splitList } from "@/lib/utils/csv";
import { slugify } from "@/lib/utils/text";

type Args = { file: string; createStations: boolean };

function parseArgs(argv: string[]): Args {
  let file = "";
  let createStations = false;

  for (const arg of argv) {
    if (arg.startsWith("--file=")) file = arg.slice("--file=".length);
    else if (arg === "--create-stations") createStations = true;
  }

  if (!file) {
    throw new Error(
      "Missing --file. Usage:\n" +
        "  npm run import:topology -- --file=/absolute/path/to/topology.zip [--create-stations]",
    );
  }

  return { file: resolve(file), createStations };
}

/** Extract the archive, refusing entries that would escape the target directory. */
async function extractZip(zipPath: string, destination: string): Promise<string[]> {
  const directory = await unzipper.Open.file(zipPath);
  const written: string[] = [];

  for (const entry of directory.files) {
    if (entry.type !== "File") continue;

    const target = resolve(destination, entry.path);
    const relation = relative(destination, target);
    if (relation.startsWith("..") || relation.startsWith(sep) || relation.length === 0) {
      console.warn(`  ! Skipping suspicious archive entry: ${entry.path}`);
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await entry.buffer());
    written.push(target);
  }

  return written;
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursively(full)));
    else files.push(full);
  }

  return files;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workDirectory = await mkdtemp(join(tmpdir(), "lift-topology-"));

  try {
    console.info(`Extracting ${args.file}`);
    console.info(`  into ${workDirectory}`);
    await extractZip(args.file, workDirectory);

    const files = await listFilesRecursively(workDirectory);
    const csvFiles = files.filter((file) => file.toLowerCase().endsWith(".csv"));

    console.info("");
    console.info("── CSV files in this archive ─────────────────────────────");

    let liftsCsvPath: string | null = null;

    for (const file of csvFiles.sort()) {
      const contents = await readFile(file, "utf8");
      const { headers, rows } = parseCsv(contents);
      const name = relative(workDirectory, file);

      console.info(`\n${name}  (${rows.length} rows)`);
      console.info(`  headers: ${headers.join(", ")}`);

      if (name.toLowerCase().endsWith("lifts.csv")) liftsCsvPath = file;
    }

    if (!liftsCsvPath) {
      console.warn("\nNo Lifts.csv found in this archive; nothing was imported.");
      return;
    }

    console.info("");
    console.info(`── Importing ${relative(workDirectory, liftsCsvPath)} ─────────────────────`);

    const { rows } = parseCsv(await readFile(liftsCsvPath, "utf8"));

    let imported = 0;
    let updated = 0;
    let rejected = 0;
    let skippedUnknownStation = 0;
    let stationsCreated = 0;
    const rejectReasons = new Map<string, number>();

    const noteRejection = (reason: string): void => {
      rejected += 1;
      rejectReasons.set(reason, (rejectReasons.get(reason) ?? 0) + 1);
    };

    for (const row of rows) {
      const stationUniqueId = readColumn(row, "StationUniqueId");
      const liftUniqueId = readColumn(row, "LiftUniqueId") || readColumn(row, "LiftId");

      if (!stationUniqueId) {
        noteRejection("missing StationUniqueId");
        continue;
      }
      if (!liftUniqueId) {
        noteRejection("missing LiftUniqueId and LiftId");
        continue;
      }

      let station = await prisma.station.findUnique({ where: { tflStationId: stationUniqueId } });

      if (!station) {
        if (!args.createStations) {
          skippedUnknownStation += 1;
          continue;
        }

        const name = readColumn(row, "StationName") || stationUniqueId;
        let slug = slugify(name);
        // Slugs are unique; disambiguate rather than fail the whole import.
        for (let attempt = 2; await prisma.station.findUnique({ where: { slug } }); attempt += 1) {
          slug = `${slugify(name)}-${attempt}`;
        }

        station = await prisma.station.create({
          data: {
            tflStationId: stationUniqueId,
            name,
            slug,
            resolutionStatus: ResolutionStatus.UNRESOLVED,
            metadataSource: "topology-import",
            rawMetadata: row,
          },
        });
        stationsCreated += 1;
      }

      const displayName =
        readColumn(row, "FriendlyName") || readColumn(row, "LiftName") || readColumn(row, "LiftId");

      const data = {
        displayName: displayName || null,
        fromAreas: splitList(readColumn(row, "FromAreas")),
        intermediateAreas: splitList(readColumn(row, "IntermediateAreas")),
        toAreas: splitList(readColumn(row, "ToAreas")),
        limitedCapacity: parseCsvBoolean(readColumn(row, "LimitedCapacityLift")),
        notes: readColumn(row, "LiftNotes") || null,
        // Every source column is preserved verbatim.
        rawMetadata: row,
        lastSeenAt: new Date(),
      };

      const existing = await prisma.lift.findUnique({
        where: { stationId_tflLiftId: { stationId: station.id, tflLiftId: liftUniqueId } },
      });

      if (existing) {
        await prisma.lift.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await prisma.lift.create({
          data: { ...data, stationId: station.id, tflLiftId: liftUniqueId },
        });
        imported += 1;
      }
    }

    console.info("");
    console.info("── Summary ───────────────────────────────────────────────");
    console.info(`Rows read              : ${rows.length}`);
    console.info(`Lifts imported (new)   : ${imported}`);
    console.info(`Lifts updated          : ${updated}`);
    console.info(`Rows rejected          : ${rejected}`);
    for (const [reason, count] of rejectReasons) {
      console.info(`  – ${reason}: ${count}`);
    }
    console.info(`Skipped, station unknown: ${skippedUnknownStation}`);
    if (args.createStations) {
      console.info(`Stations created       : ${stationsCreated}`);
    } else if (skippedUnknownStation > 0) {
      console.info(
        "  (re-run with --create-stations to import the full inventory, including\n" +
          "   stations that have never had an observed outage)",
      );
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
    console.info("");
    console.info(`Removed temporary directory ${workDirectory}`);
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
