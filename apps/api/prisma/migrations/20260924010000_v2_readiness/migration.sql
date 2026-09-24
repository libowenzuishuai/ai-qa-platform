CREATE TABLE "V2ReadinessCheck" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "configFingerprint" TEXT NOT NULL,
    "role" TEXT,
    "environmentRevision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "V2ReadinessCheck_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "V2ReadinessCheck_sessionId_configFingerprint_key" ON "V2ReadinessCheck"("sessionId","configFingerprint");
CREATE INDEX "V2ReadinessCheck_projectId_sessionId_idx" ON "V2ReadinessCheck"("projectId","sessionId");
ALTER TABLE "V2ReadinessCheck" ADD CONSTRAINT "V2ReadinessCheck_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
