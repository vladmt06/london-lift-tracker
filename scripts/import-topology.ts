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

/** TfL publishes the step-free topology openly, with no key required. */
const TFL_TOPOLOGY_URL = "https://api.tfl.gov.uk/stationdata/tfl-stationdata-detailed.zip";

type Args = { file: string | null; url: string | null; createStations: boolean };

function parseArgs(argv: string[]): Args {
  let file: string | null = null;
  let url: string | null = null;
  let createStations = false;

  for (const arg of argv) {
    if (arg.startsWith("--file=")) file = resolve(arg.slice("--file=".length));
    else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else if (arg === "--download") url = TFL_TOPOLOGY_URL;
    else if (arg === "--create-stations") createStations = true;
  }

  if (!file && !url) {
    throw new Error(
      "Provide a source. Usage:\n" +
        "  npm run import:topology -- --download [--create-stations]\n" +
        "  npm run import:topology -- --file=/absolute/path/to/topology.zip\n" +
        `  (--download fetches ${TFL_TOPOLOGY_URL})`,
    );
  }

  return { file, url, createStations };
}

/** Fetch the archive to a temporary path so the rest of the flow is identical. */
async function downloadArchive(url: string, destination: string): Promise<string> {
  console.info(`Downloading ${url}`);
  const response = await fetch(url, { headers: { Accept: "application/zip" } });

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  }

  const target = join(destination, "topology.zip");
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  return target;
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

/** Find a free slug, ignoring the station that already owns it. */
async function uniqueSlug(name: string, ownStationId: string | null): Promise<string> {
  const base = slugify(name);
  let candidate = base;

  for (let attempt = 2; attempt < 60; attempt += 1) {
    const clash = await prisma.station.findUnique({ where: { slug: candidate } });
    if (!clash || clash.id === ownStationId) return candidate;
    candidate = `${base}-${attempt}`;
  }

  return `${base}-${Date.now()}`;
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
    const archivePath = args.file ?? (await downloadArchive(args.url as string, workDirectory));

    console.info(`Extracting ${archivePath}`);
    console.info(`  into ${workDirectory}`);
    await extractZip(archivePath, workDirectory);

    const files = await listFilesRecursively(workDirectory);
    const csvFiles = files.filter((file) => file.toLowerCase().endsWith(".csv"));

    console.info("");
    console.info("── CSV files in this archive ─────────────────────────────");

    let liftsCsvPath: string | null = null;
    let stationsCsvPath: string | null = null;
    let stationPointsCsvPath: string | null = null;

    for (const file of csvFiles.sort()) {
      const contents = await readFile(file, "utf8");
      const { headers, rows } = parseCsv(contents);
      const name = relative(workDirectory, file);

      console.info(`\n${name}  (${rows.length} rows)`);
      console.info(`  headers: ${headers.join(", ")}`);

      if (name.toLowerCase().endsWith("lifts.csv")) liftsCsvPath = file;
      if (name.toLowerCase().endsWith("stations.csv")) stationsCsvPath = file;
      if (name.toLowerCase().endsWith("stationpoints.csv")) stationPointsCsvPath = file;
    }

    // Lifts.csv identifies its station only by opaque id, so without these two
    // a newly created station would be called "910GACTNCTL" and have no map.
    const stationNames = new Map<string, string>();
    if (stationsCsvPath) {
      for (const row of parseCsv(await readFile(stationsCsvPath, "utf8")).rows) {
        const id = readColumn(row, "UniqueId");
        const name = readColumn(row, "Name");
        if (id && name) stationNames.set(id, name);
      }
      console.info(`\nStation names available for ${stationNames.size} stations.`);
    }

    const stationCoordinates = new Map<string, { latitude: number; longitude: number }>();
    if (stationPointsCsvPath) {
      const sums = new Map<string, { lat: number; lon: number; n: number }>();
      for (const row of parseCsv(await readFile(stationPointsCsvPath, "utf8")).rows) {
        const id = readColumn(row, "StationUniqueId");
        const lat = Number(readColumn(row, "Lat"));
        const lon = Number(readColumn(row, "Lon"));
        if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
          continue;
        }
        const acc = sums.get(id) ?? { lat: 0, lon: 0, n: 0 };
        sums.set(id, { lat: acc.lat + lat, lon: acc.lon + lon, n: acc.n + 1 });
      }
      // A station has many mapped areas; their centroid is a fair pin location.
      for (const [id, acc] of sums) {
        stationCoordinates.set(id, { latitude: acc.lat / acc.n, longitude: acc.lon / acc.n });
      }
      console.info(`Coordinates available for ${stationCoordinates.size} stations.`);
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
    let stationsBackfilled = 0;
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
      const topologyName = stationNames.get(stationUniqueId);
      const topologyPoint = stationCoordinates.get(stationUniqueId);

      // Backfill anything a previous run, or the disruption feed, left missing —
      // without overwriting better data resolved from the StopPoint API.
      if (station) {
        const namePlaceholder = station.name === station.tflStationId;
        const patch: Record<string, unknown> = {};

        if (topologyName && namePlaceholder) {
          patch.name = topologyName;
          patch.slug = await uniqueSlug(topologyName, station.id);
        }
        if (topologyPoint && (station.latitude === null || station.longitude === null)) {
          patch.latitude = topologyPoint.latitude;
          patch.longitude = topologyPoint.longitude;
          patch.resolutionStatus = ResolutionStatus.RESOLVED;
        }

        if (Object.keys(patch).length > 0) {
          station = await prisma.station.update({ where: { id: station.id }, data: patch });
          stationsBackfilled += 1;
        }
      }

      if (!station) {
        if (!args.createStations) {
          skippedUnknownStation += 1;
          continue;
        }

        const name = topologyName || readColumn(row, "StationName") || stationUniqueId;

        station = await prisma.station.create({
          data: {
            tflStationId: stationUniqueId,
            name,
            slug: await uniqueSlug(name, null),
            latitude: topologyPoint?.latitude ?? null,
            longitude: topologyPoint?.longitude ?? null,
            resolutionStatus: topologyPoint
              ? ResolutionStatus.RESOLVED
              : ResolutionStatus.UNRESOLVED,
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
    console.info(`Stations backfilled    : ${stationsBackfilled}  (name and/or coordinates)`);
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
