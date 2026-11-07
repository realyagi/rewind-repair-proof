// Live Preview orchestration (API side). Never executes project code: it only extracts the repaired
// artifact onto the shared workspace volume and asks the sandbox service to run it.
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import type { Duplex } from "node:stream";
import { prisma } from "../db.js";
import { env } from "../config.js";
import { storage } from "../lib/storage.js";
import { safeExtractZip } from "../import/zip.js";
import {
  planPreview, newSessionId, newAccessToken, hashToken, tokenMatches, previewHost,
  parsePreviewHost, previewDomainIsSafe, isExpired, ACTIVE_STATES, type PreviewPlan,
} from "./core.js";

export class PreviewError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

const audit = (event: string, d: Record<string, unknown>) => console.info(`[audit] ${event}`, JSON.stringify(d));

export function previewAvailability(): { ok: true } | { ok: false; reason: string } {
  if (!env.SANDBOX_URL || !env.SANDBOX_TOKEN) return { ok: false, reason: "Sandbox service is not configured (SANDBOX_URL, SANDBOX_TOKEN)." };
  if (!env.PREVIEW_BASE_DOMAIN) return { ok: false, reason: "Live Preview is not configured: set PREVIEW_BASE_DOMAIN to a wildcard host separate from the app (see DEPLOY.md)." };
  if (!previewDomainIsSafe(env.PREVIEW_BASE_DOMAIN, env.APP_URL)) return { ok: false, reason: "PREVIEW_BASE_DOMAIN must be a different site from APP_URL so preview code cannot read REWIND cookies or storage." };
  return { ok: true };
}

async function sb<T>(p: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${env.SANDBOX_URL}${p}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${env.SANDBOX_TOKEN}` }, signal: AbortSignal.timeout(15_000) })
    .catch((e) => { throw new PreviewError(`Sandbox unreachable: ${(e as Error).message}`, 503); });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new PreviewError((body as { error?: string }).error ?? `Sandbox error ${r.status}`, r.status === 429 ? 429 : 502);
  return body as T;
}

const urlFor = (id: string, token: string) => `${env.PREVIEW_SCHEME}://${previewHost(id, token, env.PREVIEW_BASE_DOMAIN!)}/`;

/** Inspect the repaired artifact and decide whether/how it can be previewed. */
export async function detectForRun(runId: string): Promise<{ plan: PreviewPlan; artifactKey: string | null }> {
  const a = await prisma.artifact.findFirst({ where: { runId, kind: "repaired_zip" }, orderBy: { createdAt: "desc" } });
  if (!a) return { artifactKey: null, plan: { supported: false, framework: null, reason: "This run has no repaired project artifact yet." } };
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(await storage.get(a.key));
  const names = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, "/"));
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes("/")) ? `${[...tops][0]}/` : "";
  const files = names.map((n) => (strip && n.startsWith(strip) ? n.slice(strip.length) : n));
  const pkgEntry = zip.getEntry(`${strip}package.json`);
  let pkg = null;
  if (pkgEntry) { try { pkg = JSON.parse(pkgEntry.getData().toString("utf8")); } catch { pkg = null; } }
  return { artifactKey: a.key, plan: planPreview(files, pkg) };
}

export async function startPreview(userId: string, runId: string) {
  const avail = previewAvailability();
  if (!avail.ok) throw new PreviewError(avail.reason, 503);
  const run = await prisma.repairRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new PreviewError("Run not found", 404);
  const { plan, artifactKey } = await detectForRun(run.id);
  if (!plan.supported || !artifactKey) throw new PreviewError(plan.supported ? "No repaired artifact" : plan.reason, 422);

  // Prevent uncontrolled containers: stop this user's previous active previews first.
  const active = await prisma.previewSession.findMany({ where: { userId, status: { in: [...ACTIVE_STATES] } }, orderBy: { createdAt: "asc" } });
  for (const s of active.slice(0, Math.max(0, active.length - env.PREVIEW_MAX_PER_USER + 1))) await stopPreview(userId, s.id, "stopped");

  const id = newSessionId();
  const token = newAccessToken();
  const ttl = env.PREVIEW_TTL_MINUTES * 60;
  const ws = path.resolve(env.WORKSPACE_PATH, `preview-${id}`);
  await prisma.previewSession.create({ data: { id, runId: run.id, projectId: run.projectId, userId, framework: plan.framework, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttl * 1000) } });
  try {
    await safeExtractZip(await storage.get(artifactKey), ws);
    await sb("/preview/start", { method: "POST", body: JSON.stringify({ id, workspace: `preview-${id}`, image: plan.image, setup: plan.setup, start: plan.start, ttlSeconds: ttl }) });
  } catch (e) {
    await fs.rm(ws, { recursive: true, force: true });
    await prisma.previewSession.update({ where: { id }, data: { status: "failed", error: (e as Error).message, stoppedAt: new Date() } });
    throw e;
  }
  audit("preview.start", { sessionId: id, runId: run.id, framework: plan.framework });
  return { id, url: urlFor(id, token) };
}

/** Issue a fresh access URL for an owned, active session (rotates the token; old URL stops working). */
export async function rotateAccess(userId: string, id: string) {
  const s = await prisma.previewSession.findFirst({ where: { id, userId } });
  if (!s) throw new PreviewError("Preview not found", 404);
  if (!ACTIVE_STATES.includes(s.status as never) || isExpired(s.expiresAt)) throw new PreviewError("Preview is not running", 409);
  const token = newAccessToken();
  await prisma.previewSession.update({ where: { id }, data: { tokenHash: hashToken(token) } });
  hostCache.delete(id);
  audit("preview.access_rotated", { sessionId: id });
  return { url: urlFor(id, token) };
}

type SbStatus = { state: string; error: string | null; logs: string[]; readyAt: number | null };

export async function previewStatus(userId: string, id: string) {
  const s = await prisma.previewSession.findFirst({ where: { id, userId } });
  if (!s) throw new PreviewError("Preview not found", 404);
  let logs: string[] = [];
  let cur = s;
  if (ACTIVE_STATES.includes(s.status as never)) {
    if (isExpired(s.expiresAt)) { await stopPreview(userId, id, "expired"); cur = (await prisma.previewSession.findUnique({ where: { id } }))!; }
    else {
      const st = await sb<SbStatus>(`/preview/${id}`).catch((e) => ({ state: "unreachable", error: (e as Error).message, logs: [], readyAt: null }) as SbStatus);
      logs = st.logs;
      const next = st.state === "missing" ? "failed" : st.state;
      if (next !== s.status && ["ready", "failed", "stopped", "expired"].includes(next)) {
        cur = await prisma.previewSession.update({ where: { id }, data: { status: next, error: st.error ?? null, ...(next === "ready" ? { readyAt: new Date() } : { stoppedAt: new Date() }) } });
        if (next !== "ready") hostCache.delete(id);
      }
      if (st.state === "unreachable") return { ...view(cur), logs, warning: st.error };
    }
  }
  return { ...view(cur), logs };
}

const view = (s: { id: string; runId: string; status: string; framework: string; error: string | null; createdAt: Date; readyAt: Date | null; expiresAt: Date; stoppedAt: Date | null }) =>
  ({ id: s.id, runId: s.runId, status: s.status, framework: s.framework, error: s.error, createdAt: s.createdAt, readyAt: s.readyAt, expiresAt: s.expiresAt, stoppedAt: s.stoppedAt });

export async function latestForRun(userId: string, runId: string) {
  const s = await prisma.previewSession.findFirst({ where: { runId, userId }, orderBy: { createdAt: "desc" } });
  return s ? view(s) : null;
}

export async function stopPreview(userId: string | null, id: string, final: "stopped" | "expired" = "stopped") {
  const s = await prisma.previewSession.findFirst({ where: { id, ...(userId ? { userId } : {}) } });
  if (!s) throw new PreviewError("Preview not found", 404);
  hostCache.delete(id);
  await sb(`/preview/${id}/stop`, { method: "POST" }).catch(() => {});
  await fs.rm(path.resolve(env.WORKSPACE_PATH, `preview-${id}`), { recursive: true, force: true });
  if (ACTIVE_STATES.includes(s.status as never)) await prisma.previewSession.update({ where: { id }, data: { status: final, stoppedAt: new Date() } });
  audit(`preview.${final}`, { sessionId: id });
}

/** Worker-side: expire sessions past their lifetime (survives API/worker restarts — state is in Postgres). */
export async function expirePreviews() {
  const due = await prisma.previewSession.findMany({ where: { status: { in: [...ACTIVE_STATES] }, expiresAt: { lte: new Date() } }, select: { id: true } });
  for (const s of due) await stopPreview(null, s.id, "expired").catch(() => {});
  return due.length;
}

// ---------- preview host proxy ----------
const hostCache = new Map<string, { ok: boolean; at: number; hash: string }>();
async function authorizeHost(host: string | undefined): Promise<string | null> {
  const p = parsePreviewHost(host, env.PREVIEW_BASE_DOMAIN);
  if (!p) return null;
  const c = hostCache.get(p.id);
  if (c && Date.now() - c.at < 5000) return c.ok && tokenMatches(p.token, c.hash) ? p.id : null;
  const s = await prisma.previewSession.findUnique({ where: { id: p.id }, select: { status: true, expiresAt: true, tokenHash: true } });
  const ok = Boolean(s && s.status === "ready" && !isExpired(s.expiresAt));
  hostCache.set(p.id, { ok, at: Date.now(), hash: s?.tokenHash ?? "" });
  return ok && s && tokenMatches(p.token, s.tokenHash) ? p.id : null;
}

export const isPreviewHost = (host: string | undefined) => Boolean(env.PREVIEW_BASE_DOMAIN && host && host.toLowerCase().replace(/:\d+$/, "").endsWith(`.${env.PREVIEW_BASE_DOMAIN}`));

const STRIP_REQ = new Set(["authorization", "host", "connection", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"]);

export async function proxyPreviewHttp(req: Request, res: Response) {
  const id = await authorizeHost(req.headers.host).catch(() => null);
  if (!id) return res.status(404).type("text/plain").send("Preview not found or expired");
  const sbUrl = new URL(env.SANDBOX_URL!);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !STRIP_REQ.has(k)) headers[k] = v;
  headers.authorization = `Bearer ${env.SANDBOX_TOKEN}`;
  const up = http.request({ host: sbUrl.hostname, port: sbUrl.port || 80, method: req.method, path: `/proxy/${id}${req.originalUrl}`, headers, timeout: 60_000 }, (r) => {
    const h = { ...r.headers };
    delete h["x-frame-options"];
    if (!h["content-security-policy"]) h["content-security-policy"] = `frame-ancestors ${new URL(env.APP_URL).origin}`;
    h["referrer-policy"] = "no-referrer"; // keep the capability host out of third-party Referer headers
    h["x-robots-tag"] = "noindex";
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.status(502).type("text/plain"); res.end("Preview upstream error"); });
  up.on("timeout", () => up.destroy());
  req.pipe(up);
}

export async function proxyPreviewUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  const id = await authorizeHost(req.headers.host).catch(() => null);
  if (!id) return socket.destroy();
  const sbUrl = new URL(env.SANDBOX_URL!);
  const up = net.connect(Number(sbUrl.port || 80), sbUrl.hostname, () => {
    let h = `${req.method} /proxy/${id}${req.url} HTTP/1.1\r\nhost: ${sbUrl.host}\r\nauthorization: Bearer ${env.SANDBOX_TOKEN}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (STRIP_REQ.has(req.rawHeaders[i]!.toLowerCase())) continue;
      h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    h += "connection: Upgrade\r\n";
    up.write(h + "\r\n"); if (head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
}

