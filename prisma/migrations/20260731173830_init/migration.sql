-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ResolutionStatus" AS ENUM ('RESOLVED', 'AMBIGUOUS', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "OutageState" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "PollRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" "PollStatus" NOT NULL,
    "httpStatus" INTEGER,
    "itemCount" INTEGER,
    "normalizedItemCount" INTEGER,
    "responseHash" TEXT,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "tflStationId" TEXT,
    "naptanId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "modes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolutionStatus" "ResolutionStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "metadataSource" TEXT,
    "rawMetadata" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lift" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "tflLiftId" TEXT NOT NULL,
    "displayName" TEXT,
    "fromAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intermediateAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "toAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "limitedCapacity" BOOLEAN,
    "notes" TEXT,
    "rawMetadata" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outage" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "liftId" TEXT,
    "assetKey" TEXT NOT NULL,
    "state" "OutageState" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "firstMissingAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "missingSuccessfulPolls" INTEGER NOT NULL DEFAULT 0,
    "sourceEventId" TEXT,
    "firstMessage" TEXT NOT NULL,
    "latestMessage" TEXT NOT NULL,
    "sourceStartedAt" TIMESTAMP(3),
    "closureInferred" BOOLEAN NOT NULL DEFAULT false,
    "rawFirst" JSONB NOT NULL,
    "rawLatest" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutageObservation" (
    "id" TEXT NOT NULL,
    "outageId" TEXT NOT NULL,
    "pollRunId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "message" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,

    CONSTRAINT "OutageObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationAlias" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PollRun_startedAt_idx" ON "PollRun"("startedAt");

-- CreateIndex
CREATE INDEX "PollRun_status_startedAt_idx" ON "PollRun"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Station_tflStationId_key" ON "Station"("tflStationId");

-- CreateIndex
CREATE UNIQUE INDEX "Station_slug_key" ON "Station"("slug");

-- CreateIndex
CREATE INDEX "Station_name_idx" ON "Station"("name");

-- CreateIndex
CREATE INDEX "Station_resolutionStatus_idx" ON "Station"("resolutionStatus");

-- CreateIndex
CREATE INDEX "Lift_stationId_idx" ON "Lift"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "Lift_stationId_tflLiftId_key" ON "Lift"("stationId", "tflLiftId");

-- CreateIndex
CREATE INDEX "Outage_assetKey_idx" ON "Outage"("assetKey");

-- CreateIndex
CREATE INDEX "Outage_stationId_openedAt_idx" ON "Outage"("stationId", "openedAt");

-- CreateIndex
CREATE INDEX "Outage_state_idx" ON "Outage"("state");

-- CreateIndex
CREATE INDEX "Outage_closedAt_idx" ON "Outage"("closedAt");

-- CreateIndex
CREATE INDEX "OutageObservation_outageId_observedAt_idx" ON "OutageObservation"("outageId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutageObservation_outageId_pollRunId_payloadHash_key" ON "OutageObservation"("outageId", "pollRunId", "payloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "StationAlias_alias_key" ON "StationAlias"("alias");

-- CreateIndex
CREATE INDEX "StationAlias_stationId_idx" ON "StationAlias"("stationId");

-- AddForeignKey
ALTER TABLE "Lift" ADD CONSTRAINT "Lift_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outage" ADD CONSTRAINT "Outage_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outage" ADD CONSTRAINT "Outage_liftId_fkey" FOREIGN KEY ("liftId") REFERENCES "Lift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageObservation" ADD CONSTRAINT "OutageObservation_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "Outage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageObservation" ADD CONSTRAINT "OutageObservation_pollRunId_fkey" FOREIGN KEY ("pollRunId") REFERENCES "PollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAlias" ADD CONSTRAINT "StationAlias_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A lift can have at most one OPEN outage at a time. Enforced in the database so
-- that two concurrent polls cannot create duplicate open outages for one asset.
CREATE UNIQUE INDEX "one_open_outage_per_asset"
ON "Outage" ("assetKey")
WHERE "closedAt" IS NULL;
