-- Live Preview sessions (additive; no existing data touched)
CREATE TABLE "PreviewSession" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "framework" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    CONSTRAINT "PreviewSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PreviewSession_userId_status_idx" ON "PreviewSession"("userId", "status");
CREATE INDEX "PreviewSession_runId_idx" ON "PreviewSession"("runId");
CREATE INDEX "PreviewSession_status_expiresAt_idx" ON "PreviewSession"("status", "expiresAt");

ALTER TABLE "PreviewSession" ADD CONSTRAINT "PreviewSession_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreviewSession" ADD CONSTRAINT "PreviewSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
