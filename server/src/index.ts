import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import rateLimit from "express-rate-limit";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { clerkMiddleware, getAuth, clerkClient } from "@clerk/express";
import { prisma } from "./db.js";
import { env, integrationStatus } from "./config.js";
import { storage } from "./lib/storage.js";
import { sandbox } from "./lib/sandbox.js";
import { encrypt, decrypt, sign, verifySigned } from "./lib/crypto.js";
import { redact } from "./lib/redact.js";
import { safeFetch, SsrfError } from "./lib/ssrf.js";
import { safeExtractZip, zipDirectory, ImportError } from "./import/zip.js";
import { parseGithubUrl, githubApi, cloneRepo } from "./import/github.js";
import { inspectProject, listFiles } from "./import/inspect.js";
import { gemini, vultr } from "./ai/providers.js";
import { PreviewError, previewAvailability, detectForRun, startPreview, previewStatus, stopPreview, rotateAccess, latestForRun, isPreviewHost, proxyPreviewHttp, proxyPreviewUpgrade } from "./preview/service.js";

const app = express();
app.set("trust proxy", 1);
// Live Preview hosts are handled before any app middleware: they never reach Clerk/JSON/CORS and
// never share the app origin. Only "<id>-<token>.<PREVIEW_BASE_DOMAIN>" hosts are matched.
const previewLimit = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
app.use((req, res, next) => (isPreviewHost(req.headers.host) ? previewLimit(req, res, () => proxyPreviewHttp(req, res).catch(next)) : next()));
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS.split(",").map((s) => s.trim()), credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(
  clerkMiddleware({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}),
  }),
);

/** Non-sensitive token metadata only: never the token, signature, or subject. */
function tokenMeta(authz: string | undefined) {
  if (!authz?.startsWith("Bearer ")) return { bearer: false };
  const parts = authz.slice(7).trim().split(".");
  if (parts.length !== 3) return { bearer: true, jwtParts: parts.length };
  try {
    const hdr = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    return {
      bearer: true, alg: hdr.alg, kidPresent: Boolean(hdr.kid), iss: c.iss, azp: c.azp,
      expInSec: typeof c.exp === "number" ? c.exp - now : null,
      nbfInSec: typeof c.nbf === "number" ? c.nbf - now : null,
    };
  } catch {
    return { bearer: true, decodable: false };
  }
}
const scrub = (v: unknown) => (v == null ? null : String(v).replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g, "[jwt]").replace(/(sk|pk)_(test|live)_[A-Za-z0-9]+/g, "[key]").slice(0, 300));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
const strictLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
const aiLimit = rateLimit({ windowMs: 60_000, limit: 20 });

type Authed = Request & { user: { id: string; clerkId: string } };
const h = (fn: (req: Authed, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req as Authed, res).catch(next);

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const { userId } = getAuth(req);
  if (!userId) {
    console.warn("[AUTH REJECTED]", JSON.stringify({
      path: req.path,
      status: scrub(res.getHeader("x-clerk-auth-status")),
      reason: scrub(res.getHeader("x-clerk-auth-reason")),
      message: scrub(res.getHeader("x-clerk-auth-message")),
      jwtKeyConfigured: Boolean(env.CLERK_JWT_KEY),
      token: tokenMeta(req.headers.authorization),
    }));
    return res.status(401).json({ error: "Unauthenticated" });
  }
  const user = await prisma.user.upsert({ where: { clerkId: userId }, create: { clerkId: userId }, update: {} });
  (req as Authed).user = { id: user.id, clerkId: userId };
  next();
}

async function ownedProject(req: Authed, id: string) {
  const p = await prisma.project.findFirst({ where: { id, userId: req.user.id } });
  if (!p) throw Object.assign(new Error("Project not found"), { status: 404 });
  return p;
}
async function ownedRun(req: Authed, id: string) {
  const r = await prisma.repairRun.findFirst({ where: { id, userId: req.user.id } });
  if (!r) throw Object.assign(new Error("Run not found"), { status: 404 });
  return r;
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x)));

// ---------- health ----------
app.get("/api/health", async (_req, res) => {
  const db = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  res.status(db ? 200 : 503).json({ ok: db, db });
});

app.use("/api", (req, res, next) => (req.path === "/github/callback" ? next() : requireUser(req, res, next).catch(next)));

// ---------- status / settings ----------
app.get("/api/status", h(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { settings: true } });
  res.json({ integrations: integrationStatus(), sandbox: await sandbox.health(), githubConnected: Boolean(user?.githubTokenEnc), githubLogin: user?.githubLogin, settings: user?.settings, limits: { maxUploadMb: env.MAX_UPLOAD_MB, maxRetries: env.MAX_REPAIR_RETRIES, sandboxTimeout: env.SANDBOX_TIMEOUT_SECONDS, concurrency: env.MAX_CONCURRENT_REPAIR_RUNS } });
}));

const settingsSchema = z.object({ maxRetries: z.number().int().min(0).max(10), timeoutSeconds: z.number().int().min(30).max(3600), vultrModel: z.string().max(200).nullable(), geminiModel: z.string().max(200).nullable(), allowInstallNet: z.boolean() }).partial();
app.put("/api/settings", h(async (req, res) => {
  const d = settingsSchema.parse(req.body);
  if (d.maxRetries !== undefined) d.maxRetries = Math.min(d.maxRetries, env.MAX_REPAIR_RETRIES);
  const s = await prisma.userSettings.upsert({ where: { userId: req.user.id }, create: { userId: req.user.id, ...d }, update: d });
  res.json(s);
}));

// ---------- dashboard ----------
app.get("/api/dashboard", h(async (req, res) => {
  const [projects, runs, counts] = await Promise.all([
    prisma.project.findMany({ where: { userId: req.user.id }, orderBy: { updatedAt: "desc" }, include: { imports: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { runs: true } } } }),
    prisma.repairRun.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 20, include: { project: { select: { name: true } } } }),
    prisma.repairRun.groupBy({ by: ["outcome"], where: { userId: req.user.id }, _count: true }),
  ]);
  const total = counts.reduce((n, c) => n + c._count, 0);
  res.json(json({ projects, runs, counts, total }));
}));

// ---------- projects ----------
async function finalizeImport(projectId: string, importId: string, dir: string, archive?: Buffer) {
  try {
    await prisma.projectImport.update({ where: { id: importId }, data: { status: "inspecting" } });
    const inspection = await inspectProject(dir);
    const src = await zipDirectory(dir);
    const sourceKey = `projects/${projectId}/${importId}/source.zip`;
    await storage.put(sourceKey, src);
    let archiveKey: string | null = null;
    if (archive) { archiveKey = `projects/${projectId}/${importId}/original.zip`; await storage.put(archiveKey, archive); }
    await prisma.project.update({ where: { id: projectId }, data: { inspection, installCommand: inspection.suggested.install ?? null, buildCommand: inspection.suggested.build ?? null, testCommand: inspection.suggested.test ?? null, sandboxImage: inspection.suggested.image ?? null } });
    await prisma.projectImport.update({ where: { id: importId }, data: { status: "ready", sourceKey, archiveKey, fileCount: inspection.fileCount, totalBytes: BigInt(src.length), completedAt: new Date() } });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

app.post("/api/projects/zip", strictLimit, upload.single("file"), h(async (req, res) => {
  const name = z.string().min(1).max(100).parse(req.body.name);
  const f = req.file;
  if (!f) return res.status(400).json({ error: "No file uploaded" });
  if (!/\.zip$/i.test(f.originalname)) return res.status(400).json({ error: "Only .zip files are accepted" });
  const project = await prisma.project.create({ data: { userId: req.user.id, name, source: "zip" } });
  const imp = await prisma.projectImport.create({ data: { projectId: project.id, status: "extracting" } });
  const dir = path.resolve(env.WORKSPACE_PATH, `import-${imp.id}`);
  try {
    await safeExtractZip(f.buffer, dir);
    await finalizeImport(project.id, imp.id, dir, f.buffer);
    res.json({ id: project.id });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    await prisma.projectImport.update({ where: { id: imp.id }, data: { status: "failed", error: (e as Error).message } });
    res.status(e instanceof ImportError ? 400 : 500).json({ error: (e as Error).message, projectId: project.id });
  }
}));

async function ghToken(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  return u?.githubTokenEnc ? decrypt(u.githubTokenEnc) : undefined;
}

app.get("/api/github/branches", h(async (req, res) => {
  const { owner, repo } = parseGithubUrl(String(req.query.url ?? ""));
  const token = await ghToken(req.user.id);
  const meta = await githubApi<{ default_branch: string; private: boolean }>(`/repos/${owner}/${repo}`, token);
  const branches = await githubApi<{ name: string }[]>(`/repos/${owner}/${repo}/branches?per_page=100`, token);
  res.json({ default: meta.default_branch, private: meta.private, branches: branches.map((b) => b.name) });
}));

app.get("/api/github/repos", h(async (req, res) => {
  const token = await ghToken(req.user.id);
  if (!token) return res.status(400).json({ error: "GitHub not connected" });
  const repos = await githubApi<{ full_name: string; html_url: string; private: boolean; default_branch: string }[]>(`/user/repos?per_page=100&sort=updated`, token);
  res.json(repos.map((r) => ({ fullName: r.full_name, url: r.html_url, private: r.private, defaultBranch: r.default_branch })));
}));

app.post("/api/projects/github", strictLimit, h(async (req, res) => {
  const body = z.object({ url: z.string().url(), branch: z.string().min(1).max(200), name: z.string().min(1).max(100).optional() }).parse(req.body);
  const { owner, repo } = parseGithubUrl(body.url);
  const token = await ghToken(req.user.id);
  const meta = await githubApi<{ private: boolean }>(`/repos/${owner}/${repo}`, token);
  const project = await prisma.project.create({ data: { userId: req.user.id, name: body.name ?? `${owner}/${repo}`, source: "github" } });
  const imp = await prisma.projectImport.create({ data: { projectId: project.id, status: "extracting" } });
  const dir = path.resolve(env.WORKSPACE_PATH, `import-${imp.id}`);
  try {
    const sha = await cloneRepo(owner, repo, body.branch, dir, token);
    await prisma.repository.create({ data: { projectId: project.id, owner, repo, branch: body.branch, commitSha: sha, isPrivate: meta.private } });
    await finalizeImport(project.id, imp.id, dir);
    res.json({ id: project.id });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    await prisma.projectImport.update({ where: { id: imp.id }, data: { status: "failed", error: (e as Error).message } });
    res.status(e instanceof ImportError ? 400 : 500).json({ error: (e as Error).message, projectId: project.id });
  }
}));

app.get("/api/projects/:id", h(async (req, res) => {
  await ownedProject(req, req.params.id!);
  const p = await prisma.project.findUnique({ where: { id: req.params.id }, include: { imports: { orderBy: { createdAt: "desc" } }, repository: true, runs: { orderBy: { createdAt: "desc" } } } });
  res.json(json(p));
}));

app.get("/api/projects/:id/files", h(async (req, res) => {
  const p = await ownedProject(req, req.params.id!);
  const imp = await prisma.projectImport.findFirst({ where: { projectId: p.id, status: "ready" }, orderBy: { createdAt: "desc" } });
  if (!imp?.sourceKey) return res.json({ files: [] });
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(await storage.get(imp.sourceKey));
  const file = typeof req.query.path === "string" ? req.query.path : null;
  if (file) {
    const e = zip.getEntry(file);
    if (!e || e.header.size > 500_000) return res.status(404).json({ error: "File not found or too large to preview" });
    const data = e.getData();
    return res.json({ path: file, content: data.includes(0) ? null : data.toString("utf8"), binary: data.includes(0) });
  }
  res.json({ files: zip.getEntries().filter((e) => !e.isDirectory).map((e) => ({ path: e.entryName, size: e.header.size })) });
}));

const cmd = z.string().max(500).nullable();
app.put("/api/projects/:id", h(async (req, res) => {
  await ownedProject(req, req.params.id!);
  const d = z.object({ name: z.string().min(1).max(100), installCommand: cmd, buildCommand: cmd, testCommand: cmd, sandboxImage: z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,200}$/i).nullable() }).partial().parse(req.body);
  res.json(json(await prisma.project.update({ where: { id: req.params.id }, data: d })));
}));

app.delete("/api/projects/:id", h(async (req, res) => {
  await ownedProject(req, req.params.id!);
  await prisma.project.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}));

// ---------- runs ----------
app.post("/api/projects/:id/runs", strictLimit, h(async (req, res) => {
  const p = await ownedProject(req, req.params.id!);
  const imp = await prisma.projectImport.findFirst({ where: { projectId: p.id, status: "ready" } });
  if (!imp) return res.status(400).json({ error: "Project import is not ready" });
  const settings = await prisma.userSettings.findUnique({ where: { userId: req.user.id } });
  if (!vultr.configured()) return res.status(400).json({ error: "Vultr Serverless Inference is not configured on the server (VULTR_INFERENCE_API_KEY, VULTR_INFERENCE_MODEL)." });
  const maxRetries = Math.min(settings?.maxRetries ?? 2, env.MAX_REPAIR_RETRIES);
  const config = { install: p.installCommand, build: p.buildCommand, test: p.testCommand, image: p.sandboxImage, installNetwork: settings?.allowInstallNet ?? true, timeoutSeconds: settings?.timeoutSeconds ?? env.SANDBOX_TIMEOUT_SECONDS, model: env.VULTR_INFERENCE_MODEL };
  const run = await prisma.repairRun.create({ data: { projectId: p.id, userId: req.user.id, config, maxRetries } });
  res.json({ id: run.id });
}));

app.get("/api/runs/:id", h(async (req, res) => {
  await ownedRun(req, req.params.id!);
  const after = Number(req.query.afterSeq ?? 0);
  const run = await prisma.repairRun.findUnique({ where: { id: req.params.id }, include: {
    project: { select: { id: true, name: true, source: true, imports: { where: { status: "ready" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, completedAt: true, fileCount: true } } } }, steps: { orderBy: { startedAt: "asc" } },
    logs: { where: { seq: { gt: after } }, orderBy: { seq: "asc" }, take: 200 },
    diagnoses: { orderBy: { attempt: "asc" } }, plans: { orderBy: { attempt: "asc" } }, patches: { orderBy: { attempt: "asc" } },
    verifications: { orderBy: { createdAt: "asc" } }, artifacts: true,
  } });
  res.json(json(run));
}));

app.post("/api/runs/:id/cancel", h(async (req, res) => {
  const r = await ownedRun(req, req.params.id!);
  if (["completed_verified", "completed_unverified", "failed", "cancelled"].includes(r.status)) return res.status(400).json({ error: "Run already finished" });
  await prisma.repairRun.update({ where: { id: r.id }, data: { cancelRequested: true } });
  await sandbox.cancel(r.id);
  res.json({ ok: true });
}));

app.get("/api/runs/:id/artifacts/:artifactId", h(async (req, res) => {
  const r = await ownedRun(req, req.params.id!);
  const a = await prisma.artifact.findFirst({ where: { id: req.params.artifactId, runId: r.id } });
  if (!a) return res.status(404).json({ error: "Not found" });
  const buf = await storage.get(a.key);
  res.setHeader("content-disposition", `attachment; filename="rewind-${r.id}${a.kind === "diff" ? ".diff" : ".zip"}"`);
  res.type(a.kind === "diff" ? "text/x-diff" : "application/zip").send(buf);
}));

app.get("/api/runs/:id/report", h(async (req, res) => {
  await ownedRun(req, req.params.id!);
  const run = await prisma.repairRun.findUnique({ where: { id: req.params.id }, include: { project: true, diagnoses: true, plans: true, patches: true, verifications: true, logs: { select: { phase: true, command: true, exitCode: true, durationMs: true, timedOut: true } } } });
  res.setHeader("content-disposition", `attachment; filename="rewind-report-${req.params.id}.json"`);
  res.json(json(run));
}));

// ---------- live preview ----------
const previewStartLimit = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false });
const pv = (fn: (req: Authed, res: Response) => Promise<unknown>) => h(async (req, res) => {
  try { await fn(req, res); } catch (e) { if (e instanceof PreviewError) return res.status(e.status).json({ error: e.message }); throw e; }
});
app.get("/api/runs/:id/preview", pv(async (req, res) => {
  const r = await ownedRun(req, req.params.id!);
  const avail = previewAvailability();
  const { plan } = await detectForRun(r.id);
  res.json({ available: avail.ok, unavailableReason: avail.ok ? null : avail.reason, plan, session: await latestForRun(req.user.id, r.id) });
}));
app.post("/api/runs/:id/preview", previewStartLimit, pv(async (req, res) => {
  const r = await ownedRun(req, req.params.id!);
  res.json(await startPreview(req.user.id, r.id));
}));
app.get("/api/previews/:id", pv(async (req, res) => { res.json(await previewStatus(req.user.id, z.string().regex(/^[a-f0-9]{20}$/).parse(req.params.id))); }));
app.post("/api/previews/:id/access", strictLimit, pv(async (req, res) => { res.json(await rotateAccess(req.user.id, z.string().regex(/^[a-f0-9]{20}$/).parse(req.params.id))); }));
app.post("/api/previews/:id/stop", pv(async (req, res) => { await stopPreview(req.user.id, z.string().regex(/^[a-f0-9]{20}$/).parse(req.params.id)); res.json({ ok: true }); }));

// ---------- AI assistant (Gemini, optional) ----------
app.post("/api/assist", aiLimit, h(async (req, res) => {
  const d = z.object({ question: z.string().min(1).max(4000), projectId: z.string().optional(), runId: z.string().optional() }).parse(req.body);
  if (!gemini.configured()) return res.status(503).json({ error: "Gemini is not configured (GEMINI_API_KEY)." });
  let context = "";
  if (d.runId) {
    await ownedRun(req, d.runId);
    const r = await prisma.repairRun.findUnique({ where: { id: d.runId }, include: { diagnoses: true, patches: true, logs: { orderBy: { seq: "desc" }, take: 5 } } });
    context = redact(JSON.stringify({ status: r?.status, summary: r?.summary, diagnoses: r?.diagnoses, diff: r?.patches.at(-1)?.diff?.slice(0, 20000), logs: r?.logs.map((l) => ({ phase: l.phase, exit: l.exitCode, stderr: l.stderr?.slice(0, 3000) })) }));
  } else if (d.projectId) {
    const p = await ownedProject(req, d.projectId);
    context = JSON.stringify({ name: p.name, inspection: p.inspection });
  }
  const settings = await prisma.userSettings.findUnique({ where: { userId: req.user.id } });
  const r = await gemini.chat([
    { role: "system", content: "You are REWIND's assistant. Answer only from the provided project/run context. If the context does not contain the answer, say so. Never invent test results." },
    { role: "user", content: `Context:\n${context || "(none)"}\n\nQuestion: ${d.question}` },
  ], settings?.geminiModel ? { model: settings.geminiModel } : {});
  res.json({ answer: r.text, model: r.model });
}));

// ---------- website inspection ----------
app.post("/api/website-inspect", strictLimit, h(async (req, res) => {
  const { url } = z.object({ url: z.string().max(2000) }).parse(req.body);
  try {
    const { res: r, body, chain, ms, truncated } = await safeFetch(url);
    const pick = (re: RegExp) => [...body.matchAll(re)].map((m) => m[1]!).slice(0, 100);
    const result = {
      finalUrl: chain.at(-1), redirects: chain, status: r.status, responseMs: ms, truncated,
      headers: Object.fromEntries(["content-type", "server", "content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "cache-control"].map((k) => [k, r.headers.get(k)])),
      title: body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null,
      metaDescription: body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? null,
      scripts: pick(/<script[^>]+src=["']([^"']+)/gi), stylesheets: pick(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)/gi),
      images: pick(/<img[^>]+src=["']([^"']+)/gi).length, imagesMissingAlt: (body.match(/<img(?![^>]*\balt=)[^>]*>/gi) ?? []).length,
      inlineScripts: (body.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) ?? []).length,
      hasViewport: /<meta[^>]+name=["']viewport/i.test(body), lang: body.match(/<html[^>]+lang=["']([^"']+)/i)?.[1] ?? null,
      mixedContent: chain.at(-1)?.startsWith("https:") ? pick(/(?:src|href)=["'](http:\/\/[^"']+)/gi) : [],
      sizeBytes: body.length,
      note: "Only publicly delivered HTML and headers were inspected. Original source code is not recovered.",
    };
    await prisma.websiteInspection.create({ data: { userId: req.user.id, url, result } });
    res.json(result);
  } catch (e) {
    res.status(e instanceof SsrfError ? 400 : 502).json({ error: (e as Error).message });
  }
}));

// ---------- GitHub OAuth (private repo access) ----------
app.get("/api/github/connect", h(async (req, res) => {
  if (!env.GITHUB_CLIENT_ID || !env.ENCRYPTION_KEY) return res.status(503).json({ error: "GitHub OAuth not configured" });
  const state = sign(`${req.user.id}:${crypto.randomBytes(8).toString("hex")}:${Date.now()}`);
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  u.searchParams.set("scope", "repo read:user");
  u.searchParams.set("state", state);
  u.searchParams.set("redirect_uri", `${env.APP_URL}/api/github/callback`);
  res.json({ url: u.toString() });
}));

app.get("/api/github/callback", async (req, res, next) => {
  try {
    const raw = verifySigned(String(req.query.state ?? ""));
    const [userId, , ts] = raw?.split(":") ?? [];
    if (!userId || Date.now() - Number(ts) > 10 * 60_000) return res.status(400).send("Invalid or expired state");
    const r = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: req.query.code }) });
    const j = (await r.json()) as { access_token?: string };
    if (!j.access_token) return res.status(400).send("GitHub authorization failed");
    const me = await githubApi<{ login: string }>("/user", j.access_token);
    await prisma.user.update({ where: { id: userId }, data: { githubTokenEnc: encrypt(j.access_token), githubLogin: me.login } });
    res.redirect(`${env.APP_URL}/settings?github=connected`);
  } catch (e) { next(e); }
});

app.delete("/api/github", h(async (req, res) => {
  await prisma.user.update({ where: { id: req.user.id }, data: { githubTokenEnc: null, githubLogin: null } });
  res.json({ ok: true });
}));

// ---------- errors ----------
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Validation failed", issues: err.issues });
  if (err instanceof ImportError) return res.status(400).json({ error: err.message });
  if ((err as { code?: string }).code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `File exceeds ${env.MAX_UPLOAD_MB}MB limit` });
  const status = err.status ?? 500;
  if (status >= 500) console.error("[api]", redact(err.stack ?? err.message));
  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

void clerkClient; void listFiles;
await fs.mkdir(env.WORKSPACE_PATH, { recursive: true });
const server = app.listen(env.PORT, () => console.log(`[api] listening on ${env.PORT}`, integrationStatus()));
server.on("upgrade", (req, socket, head) => {
  if (isPreviewHost(req.headers.host)) void proxyPreviewUpgrade(req, socket, head);
  else socket.destroy();
});
