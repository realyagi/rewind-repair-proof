-- CreateEnum
CREATE TYPE "ProjectSource" AS ENUM ('zip', 'github');
CREATE TYPE "ImportStatus" AS ENUM ('pending', 'extracting', 'inspecting', 'ready', 'failed');
CREATE TYPE "RunStatus" AS ENUM ('queued', 'inspecting', 'baseline_running', 'diagnosing', 'planning', 'patching', 'verifying', 'retrying', 'completed_verified', 'completed_unverified', 'failed', 'cancelled');
CREATE TYPE "RunOutcome" AS ENUM ('verified', 'unverified', 'failed', 'not_reproduced', 'cancelled');

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "githubTokenEnc" TEXT,
    "githubLogin" TEXT,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSettings" (
    "userId" TEXT NOT NULL,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 600,
    "vultrModel" TEXT,
    "geminiModel" TEXT,
    "allowInstallNet" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "ProjectSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "installCommand" TEXT,
    "buildCommand" TEXT,
    "testCommand" TEXT,
    "sandboxImage" TEXT,
    "inspection" JSONB,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectImport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "archiveKey" TEXT,
    "sourceKey" TEXT,
    "fileCount" INTEGER,
    "totalBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ProjectImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Repository" (
    "projectId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Repository_pkey" PRIMARY KEY ("projectId")
);

CREATE TABLE "RepairRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "outcome" "RunOutcome",
    "config" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "summary" TEXT,
    "workerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "RepairRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "RunStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "phase" TEXT NOT NULL,
    "command" TEXT,
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "message" TEXT,
    "fullLogKey" TEXT,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Diagnosis" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "rootCause" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "affectedFiles" JSONB NOT NULL,
    "confidence" TEXT,
    "model" TEXT NOT NULL,
    "usage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Diagnosis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RepairPlan" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepairPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Patch" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "changed" JSONB NOT NULL,
    "created" JSONB NOT NULL,
    "deleted" JSONB NOT NULL,
    "explanations" JSONB NOT NULL,
    "diff" TEXT NOT NULL,
    "rejected" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Patch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VerificationResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "exitCode" INTEGER,
    "passed" BOOLEAN NOT NULL,
    "baseline" BOOLEAN NOT NULL,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VerificationResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebsiteInspection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebsiteInspection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE INDEX "RepairRun_userId_idx" ON "RepairRun"("userId");
CREATE INDEX "RepairRun_status_idx" ON "RepairRun"("status");
CREATE INDEX "RunLog_runId_seq_idx" ON "RunLog"("runId", "seq");

ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectImport" ADD CONSTRAINT "ProjectImport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepairRun" ADD CONSTRAINT "RepairRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepairRun" ADD CONSTRAINT "RepairRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunStep" ADD CONSTRAINT "RunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunLog" ADD CONSTRAINT "RunLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepairPlan" ADD CONSTRAINT "RepairPlan_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Patch" ADD CONSTRAINT "Patch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebsiteInspection" ADD CONSTRAINT "WebsiteInspection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
