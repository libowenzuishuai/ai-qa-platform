-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunEvent_runId_createdAt_idx" ON "RunEvent"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_seq_key" ON "RunEvent"("runId", "seq");

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

