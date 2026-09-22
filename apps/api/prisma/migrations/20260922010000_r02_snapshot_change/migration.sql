-- CreateTable
CREATE TABLE "SnapshotChange" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "baselineId" TEXT NOT NULL,
    "oldFiles" JSONB NOT NULL,
    "newFiles" JSONB NOT NULL,
    "excludedPaths" JSONB NOT NULL DEFAULT '[]',
    "input" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "output" JSONB,
    "outputHash" TEXT,
    "resolutions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnapshotChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotChange_jobId_key" ON "SnapshotChange"("jobId");

-- CreateIndex
CREATE INDEX "SnapshotChange_projectId_createdAt_idx" ON "SnapshotChange"("projectId","createdAt");

-- AddForeignKey
ALTER TABLE "SnapshotChange" ADD CONSTRAINT "SnapshotChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotChange" ADD CONSTRAINT "SnapshotChange_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
