// Typed client for the REWIND REST API. Auth via Clerk session token (Bearer).
export const API_BASE = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "";

let tokenGetter: (() => Promise<string | null>) | null = null;
export function setTokenGetter(fn: () => Promise<string | null>) {
  tokenGetter = fn;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenGetter ? await tokenGetter() : null;
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError("REWIND API is unreachable. Is the backend running?", 0);
  }
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "error" in body
        ? String(body.error)
        : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export async function download(path: string, filename: string) {
  const token = tokenGetter ? await tokenGetter() : null;
  const res = await fetch(`${API_BASE}/api${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export type RunStatus =
  | "queued"
  | "inspecting"
  | "baseline_running"
  | "diagnosing"
  | "planning"
  | "patching"
  | "verifying"
  | "retrying"
  | "completed_verified"
  | "completed_unverified"
  | "failed"
  | "cancelled";
export type Outcome = "verified" | "unverified" | "failed" | "not_reproduced" | "cancelled" | null;

export const TERMINAL: RunStatus[] = [
  "completed_verified",
  "completed_unverified",
  "failed",
  "cancelled",
];

export interface Inspection {
  languages: { name: string; files: number }[];
  frameworks: string[];
  packageManagers: string[];
  manifests: string[];
  buildConfig: string[];
  testConfig: string[];
  scripts: Record<string, string>;
  entryPoints: string[];
  testFiles: string[];
  suggested: { install?: string; build?: string; test?: string; image?: string };
  uncertainties: string[];
  fileCount: number;
}

export interface Project {
  id: string;
  name: string;
  source: "zip" | "github";
  createdAt: string;
  updatedAt: string;
  installCommand: string | null;
  buildCommand: string | null;
  testCommand: string | null;
  sandboxImage: string | null;
  inspection: Inspection | null;
  imports: {
    id: string;
    status: string;
    error: string | null;
    fileCount: number | null;
    createdAt: string;
  }[];
  repository?: {
    owner: string;
    repo: string;
    branch: string;
    commitSha: string | null;
    isPrivate: boolean;
  } | null;
  runs?: RunSummary[];
  _count?: { runs: number };
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  outcome: Outcome;
  createdAt: string;
  finishedAt: string | null;
  summary: string | null;
  attempt: number;
  maxRetries: number;
  project?: { name: string };
  projectId: string;
}

export interface RunLog {
  id: string;
  seq: number;
  phase: string;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string | null;
  stderr: string | null;
  message: string | null;
  timedOut: boolean;
  createdAt: string;
}

export interface RunDetail extends RunSummary {
  error: string | null;
  cancelRequested: boolean;
  config: Record<string, unknown>;
  project: {
    id: string;
    name: string;
    source?: "zip" | "github";
    imports?: { createdAt: string; completedAt: string | null; fileCount: number | null }[];
  };
  startedAt?: string | null;
  steps: {
    id: string;
    name: string;
    status: string;
    attempt: number;
    startedAt: string;
    finishedAt: string | null;
  }[];
  logs: RunLog[];
  diagnoses: {
    id: string;
    attempt: number;
    rootCause: string;
    confidence: string | null;
    model: string;
    evidence: { file?: string; line?: number; logExcerpt?: string; reasoning: string }[];
    affectedFiles: string[];
    createdAt?: string;
  }[];
  plans: { id: string; attempt: number; steps: string[]; createdAt?: string }[];
  patches: {
    id: string;
    attempt: number;
    changed: string[];
    created: string[];
    deleted: string[];
    explanations: { path: string; action: string; explanation: string }[];
    diff: string;
    rejected: { path: string; reason: string }[] | null;
    createdAt?: string;
  }[];
  verifications: {
    id: string;
    attempt: number;
    phase: string;
    command: string;
    exitCode: number | null;
    passed: boolean;
    baseline: boolean;
    timedOut: boolean;
    createdAt?: string;
  }[];
  artifacts: { id: string; kind: string; sizeBytes: number | null }[];
}

export interface Status {
  integrations: {
    clerk: boolean;
    vultr: boolean;
    vultrModel: string | null;
    vultrBaseUrl: string;
    gemini: boolean;
    geminiModel: string;
    githubOAuth: boolean;
    storage: string;
    sandboxConfigured: boolean;
    previewConfigured?: boolean;
  };
  sandbox: { ok: boolean; detail?: unknown };
  githubConnected: boolean;
  githubLogin: string | null;
  settings: {
    maxRetries: number;
    timeoutSeconds: number;
    vultrModel: string | null;
    geminiModel: string | null;
    allowInstallNet: boolean;
  } | null;
  limits: { maxUploadMb: number; maxRetries: number; sandboxTimeout: number; concurrency: number };
}

export type PreviewStatus = "starting" | "ready" | "stopped" | "failed" | "expired";
export type PreviewPlan =
  | {
      supported: true;
      framework: "static" | "vite" | "react" | "nextjs";
      image: string;
      setup: string | null;
      start: string;
      notes: string[];
    }
  | { supported: false; framework: string | null; reason: string };
export interface PreviewSession {
  id: string;
  runId: string;
  status: PreviewStatus;
  framework: string;
  error: string | null;
  createdAt: string;
  readyAt: string | null;
  expiresAt: string;
  stoppedAt: string | null;
  logs?: string[];
  warning?: string;
}
export interface RunPreviewInfo {
  available: boolean;
  unavailableReason: string | null;
  plan: PreviewPlan;
  session: PreviewSession | null;
}
