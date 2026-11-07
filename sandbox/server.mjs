// REWIND sandbox runner. Internal-only service. Executes untrusted project commands inside
// disposable, resource-limited Docker containers. This service is the ONLY component with access
// to a Docker daemon (ideally a dedicated rootless/isolated daemon, see DEPLOY.md). Project
// containers never receive the socket, secrets, or database network.
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

const TOKEN = process.env.SANDBOX_TOKEN;
const WS = path.resolve(process.env.WORKSPACE_PATH || "/workspaces");
const CPU = process.env.SANDBOX_CPU_LIMIT || "1";
const MEM = process.env.SANDBOX_MEMORY_LIMIT || "1g";
const DISK = process.env.SANDBOX_DISK_LIMIT || "2g";
const PIDS = process.env.SANDBOX_PIDS_LIMIT || "256";
const MAX_TIMEOUT = Number(process.env.SANDBOX_TIMEOUT_SECONDS || 600);
const MAX_CONC = Number(process.env.SANDBOX_MAX_CONCURRENT || 2);
const INSTALL_NET = process.env.SANDBOX_INSTALL_NETWORK || "rewind_sandbox_egress"; // isolated egress-only network
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:@-]{0,200}$/i;
const MAX_OUT = 2_000_000;
if (!TOKEN) { console.error("SANDBOX_TOKEN required"); process.exit(1); }

const running = new Map(); // jobId -> container name

// docker cp writes files as root on the shared volume. The API/worker run as
// node (uid/gid 1000), so restore workspace ownership after copying sandbox
// results back or the repair worker cannot apply its patch (EACCES).
async function restoreWorkspaceOwnership(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    const st = await fs.promises.lstat(target);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) await restoreWorkspaceOwnership(target);
    if (st.isDirectory() || st.isFile()) await fs.promises.chown(target, 1000, 1000);
  }
  await fs.promises.chown(dir, 1000, 1000);
}

function docker(args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { if (out.length < MAX_OUT) out += d; });
    p.stderr.on("data", (d) => { if (err.length < MAX_OUT) err += d; });
    const t = timeoutMs ? setTimeout(() => p.kill("SIGKILL"), timeoutMs) : null;
    p.on("close", (code) => { if (t) clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function exec(job) {
  const { jobId, workspace, image, command, network } = job;
  if (!/^[a-z0-9-]{1,80}$/i.test(jobId) || !/^run-[a-z0-9]{1,60}$/i.test(workspace)) throw new Error("bad ids");
  if (!IMAGE_RE.test(image)) throw new Error("bad image");
  if (typeof command !== "string" || command.length > 500) throw new Error("bad command");
  const dir = path.join(WS, workspace);
  if (!dir.startsWith(WS + path.sep) || !fs.existsSync(dir)) throw new Error("workspace missing");
  if (running.size >= MAX_CONC) throw Object.assign(new Error("sandbox busy"), { status: 429 });
  const timeout = Math.min(Number(job.timeoutSeconds) || MAX_TIMEOUT, MAX_TIMEOUT);
  const name = `rewind-${jobId}-${Date.now()}`;
  running.set(jobId, name);
  const started = Date.now();
  try {
    await docker(["pull", "-q", image], { timeoutMs: 300_000 });
    const create = await docker([
      "create", "--name", name, "--workdir", "/work",
      "--network", network ? INSTALL_NET : "none",
      "--cpus", CPU, "--memory", MEM, "--memory-swap", MEM, "--pids-limit", PIDS,
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges",
      ...(process.env.SANDBOX_STORAGE_OPT ? ["--storage-opt", `size=${DISK}`] : []),
      "--tmpfs", "/tmp:rw,exec,size=512m", "--tmpfs", "/root:rw,exec,size=1g",
      "--env", "CI=true", "--env", "HOME=/root",
      "--add-host", "metadata.google.internal:127.0.0.1", "--add-host", "169.254.169.254:127.0.0.1",
      image, "sh", "-lc", command,
    ]);
    if (create.code !== 0) throw new Error(`container create failed: ${create.err.slice(0, 500)}`);
    await docker(["cp", `${dir}/.`, `${name}:/work`]);
    const run = await docker(["start", "-a", name], { timeoutMs: timeout * 1000 });
    const timedOut = Date.now() - started >= timeout * 1000 - 50;
    const inspect = await docker(["inspect", "-f", "{{.State.ExitCode}}|{{.State.OOMKilled}}", name]);
    const [exit, oom] = inspect.out.trim().split("|");
    // copy results back so installs persist between commands in the same run
    await docker(["cp", `${name}:/work/.`, dir]);
    await restoreWorkspaceOwnership(dir);
    return { exitCode: timedOut ? null : Number(exit), stdout: run.out, stderr: run.err + (oom === "true" ? "\n[REWIND] Container killed: out of memory\n" : ""), durationMs: Date.now() - started, timedOut, resources: { memoryLimit: MEM, cpuLimit: CPU, oomKilled: oom === "true" } };
  } finally {
    running.delete(jobId);
    await docker(["rm", "-f", "-v", name]);
  }
}


// ======================= Live Preview =======================
// Dedicated lifecycle, separate from short-lived repair exec containers. Preview containers:
// - run on "rewind_preview": a bridge with NO masquerade (no internet egress) and no inter-container traffic
// - publish ONE fixed container port (3000) to a sandbox-allocated port on the dind host only
// - are reachable only via this service's authenticated /proxy route (upstream host is fixed config)
const PREVIEW_NET = "rewind_preview";
const PREVIEW_UPSTREAM = process.env.PREVIEW_UPSTREAM_HOST || "dind";
const PORT_BASE = Number(process.env.PREVIEW_PORT_BASE || 20000);
const PORT_COUNT = Number(process.env.PREVIEW_PORT_COUNT || 20);
const PREVIEW_MAX = Number(process.env.PREVIEW_MAX_CONCURRENT || 3);
const PREVIEW_MAX_TTL = Number(process.env.PREVIEW_MAX_TTL_SECONDS || 3600);
const PREVIEW_SETUP_TIMEOUT = Number(process.env.PREVIEW_SETUP_TIMEOUT_SECONDS || 600);
const PREVIEW_READY_TIMEOUT = Number(process.env.PREVIEW_READY_TIMEOUT_SECONDS || 120);
const PREVIEW_CPU = process.env.PREVIEW_CPU_LIMIT || "0.5";
const PREVIEW_MEM = process.env.PREVIEW_MEMORY_LIMIT || "512m";
const PREVIEW_PIDS = process.env.PREVIEW_PIDS_LIMIT || "128";
const previews = new Map(); // id -> session

const isActive = (p) => p.state === "starting" || p.state === "ready";
const plog = (p, line) => { for (const l of String(line).split("\n")) { if (l) p.logs.push(l.slice(0, 2000)); } if (p.logs.length > 500) p.logs.splice(0, p.logs.length - 500); };
const hardening = (mem, cpu, pids) => ["--cpus", cpu, "--memory", mem, "--memory-swap", mem, "--pids-limit", pids,
  "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "SETUID", "--cap-add", "SETGID",
  "--security-opt", "no-new-privileges", ...(process.env.SANDBOX_STORAGE_OPT ? ["--storage-opt", `size=${DISK}`] : []),
  "--tmpfs", "/tmp:rw,exec,size=256m", "--add-host", "metadata.google.internal:127.0.0.1", "--add-host", "169.254.169.254:127.0.0.1"];

async function ensurePreviewNetwork() {
  const i = await docker(["network", "inspect", PREVIEW_NET]);
  if (i.code === 0) return;
  const c = await docker(["network", "create", "--driver", "bridge", "--label", "rewind.preview=1",
    "-o", "com.docker.network.bridge.enable_ip_masquerade=false", "-o", "com.docker.network.bridge.enable_icc=false", PREVIEW_NET]);
  if (c.code !== 0 && !/already exists/.test(c.err)) throw new Error(`preview network create failed: ${c.err.slice(0, 300)}`);
}

function allocPort() {
  const used = new Set([...previews.values()].filter(isActive).map((p) => p.port));
  for (let i = 0; i < PORT_COUNT; i++) if (!used.has(PORT_BASE + i)) return PORT_BASE + i;
  return null;
}

async function waitReady(p) {
  const deadline = Date.now() + PREVIEW_READY_TIMEOUT * 1000;
  while (Date.now() < deadline && p.state === "starting") {
    const st = await docker(["inspect", "-f", "{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}", p.name]);
    const [running, code, oom] = st.out.trim().split("|");
    if (running !== "true") {
      const l = await docker(["logs", "--tail", "200", p.name]);
      plog(p, l.out + l.err);
      throw new Error(oom === "true" ? "Preview container was killed: out of memory" : `Preview process exited with code ${code} before serving HTTP`);
    }
    const ok = await new Promise((resolve) => {
      const r = http.get({ host: PREVIEW_UPSTREAM, port: p.port, path: "/", timeout: 3000, headers: { host: "localhost:3000" } }, (res) => { res.resume(); resolve(true); });
      r.on("error", () => resolve(false)); r.on("timeout", () => { r.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (p.state === "starting") throw new Error(`Preview did not respond on port 3000 within ${PREVIEW_READY_TIMEOUT}s`);
}

async function runPreview(p, job) {
  const dir = path.join(WS, job.workspace);
  try {
    await ensurePreviewNetwork();
    plog(p, `[rewind] pulling ${job.image}`);
    await docker(["pull", "-q", job.image], { timeoutMs: 300_000 });
    let image = job.image;
    if (job.setup) {
      const setupName = `rewind-pvsetup-${p.id}`;
      plog(p, `[rewind] setup: ${job.setup}`);
      const c = await docker(["create", "--name", setupName, "--label", "rewind.preview=1", "--workdir", "/work",
        "--network", INSTALL_NET, ...hardening(MEM, CPU, PIDS), "--env", "CI=true", "--env", "HOME=/tmp", "--env", "NEXT_TELEMETRY_DISABLED=1",
        job.image, "sh", "-lc", job.setup]);
      if (c.code !== 0) throw new Error(`setup container create failed: ${c.err.slice(0, 300)}`);
      try {
        await docker(["cp", `${dir}/.`, `${setupName}:/work`]);
        const r = await docker(["start", "-a", setupName], { timeoutMs: PREVIEW_SETUP_TIMEOUT * 1000 });
        plog(p, r.out); plog(p, r.err);
        const ec = (await docker(["inspect", "-f", "{{.State.ExitCode}}", setupName])).out.trim();
        if (p.state !== "starting") return;
        if (ec !== "0") throw new Error(`Setup command failed (exit ${ec}). See startup logs.`);
        image = `rewind-pvimg-${p.id}`;
        const cm = await docker(["commit", setupName, image]);
        if (cm.code !== 0) throw new Error(`could not snapshot setup result: ${cm.err.slice(0, 300)}`);
        p.image = image;
      } finally { await docker(["rm", "-f", "-v", setupName]); }
    }
    if (p.state !== "starting") return;
    const c = await docker(["create", "--name", p.name, "--label", "rewind.preview=1", "--workdir", "/work",
      "--network", PREVIEW_NET, "-p", `${p.port}:3000`, ...hardening(PREVIEW_MEM, PREVIEW_CPU, PREVIEW_PIDS),
      "--env", "NODE_ENV=production", "--env", "PORT=3000", "--env", "HOST=0.0.0.0", "--env", "HOME=/tmp", "--env", "NEXT_TELEMETRY_DISABLED=1",
      image, "sh", "-lc", job.start]);
    if (c.code !== 0) throw new Error(`preview container create failed: ${c.err.slice(0, 300)}`);
    if (!job.setup) await docker(["cp", `${dir}/.`, `${p.name}:/work`]);
    await docker(["cp", "/app/static.mjs", `${p.name}:/opt/rewind-static.mjs`]);
    plog(p, `[rewind] start: ${job.start}`);
    const s = await docker(["start", p.name]);
    if (s.code !== 0) throw new Error(`preview start failed: ${s.err.slice(0, 300)}`);
    await waitReady(p);
    if (p.state === "starting") { p.state = "ready"; p.readyAt = Date.now(); plog(p, "[rewind] preview is serving HTTP"); }
  } catch (e) {
    if (p.state === "starting") { p.state = "failed"; p.error = e.message; plog(p, `[rewind] FAILED: ${e.message}`); await teardown(p, "failed"); }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function teardown(p, state) {
  clearTimeout(p.timer);
  if (isActive(p)) p.state = state;
  if (p.state === "starting" || p.state === "ready") p.state = state;
  const l = await docker(["logs", "--tail", "100", p.name]);
  if (l.code === 0) plog(p, l.out + l.err);
  await docker(["rm", "-f", "-v", p.name]);
  await docker(["rm", "-f", "-v", `rewind-pvsetup-${p.id}`]);
  if (p.image) await docker(["rmi", "-f", p.image]);
  await fs.promises.rm(path.join(WS, `preview-${p.id}`), { recursive: true, force: true }).catch(() => {});
  setTimeout(() => previews.delete(p.id), 15 * 60_000).unref();
}

function startPreview(job) {
  const { id, workspace, image, setup, start } = job;
  if (!/^[a-f0-9]{20}$/.test(id) || workspace !== `preview-${id}`) throw new Error("bad ids");
  if (!IMAGE_RE.test(image)) throw new Error("bad image");
  if ((setup != null && (typeof setup !== "string" || setup.length > 600)) || typeof start !== "string" || start.length > 600) throw new Error("bad command");
  const dir = path.join(WS, workspace);
  if (!dir.startsWith(WS + path.sep) || !fs.existsSync(dir)) throw new Error("workspace missing");
  if (previews.get(id)) throw new Error("session exists");
  if ([...previews.values()].filter(isActive).length >= PREVIEW_MAX) throw Object.assign(new Error("Preview capacity reached on this server. Stop another preview or try later."), { status: 429 });
  const port = allocPort();
  if (!port) throw Object.assign(new Error("No preview ports available"), { status: 429 });
  const ttl = Math.min(Math.max(Number(job.ttlSeconds) || 600, 60), PREVIEW_MAX_TTL);
  const p = { id, port, name: `rewind-pv-${id}`, state: "starting", logs: [], error: null, createdAt: Date.now(), readyAt: null, expiresAt: Date.now() + ttl * 1000, image: null, timer: null };
  p.timer = setTimeout(() => teardown(p, "expired"), ttl * 1000);
  previews.set(id, p);
  runPreview(p, job);
  return previewView(p);
}

const previewView = (p) => ({ id: p.id, state: p.state, error: p.error, logs: p.logs.slice(-300), createdAt: p.createdAt, readyAt: p.readyAt, expiresAt: p.expiresAt });

async function previewStatus(id) {
  const p = previews.get(id);
  if (!p) return { id, state: "missing", error: "Preview container does not exist (sandbox restarted or session cleaned up)", logs: [] };
  if (p.state === "ready") {
    const st = await docker(["inspect", "-f", "{{.State.Running}}", p.name]);
    const l = await docker(["logs", "--tail", "150", p.name]);
    if (st.out.trim() !== "true") { p.error = "Preview process stopped unexpectedly"; plog(p, l.out + l.err); await teardown(p, "failed"); p.state = "failed"; }
    else return { ...previewView(p), logs: [...p.logs.slice(-150), ...(l.out + l.err).split("\n").filter(Boolean).slice(-150)] };
  }
  return previewView(p);
}

/** Startup: memory state is gone, so remove every leftover preview container/image/workspace. */
async function cleanupStalePreviews() {
  const ps = await docker(["ps", "-aq", "--filter", "label=rewind.preview=1"]);
  for (const c of ps.out.split("\n").filter(Boolean)) await docker(["rm", "-f", "-v", c]);
  const im = await docker(["images", "-q", "--filter", "reference=rewind-pvimg-*"]);
  for (const i of im.out.split("\n").filter(Boolean)) await docker(["rmi", "-f", i]);
  for (const d of fs.existsSync(WS) ? fs.readdirSync(WS) : []) if (d.startsWith("preview-")) fs.rmSync(path.join(WS, d), { recursive: true, force: true });
}

const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "authorization", "host", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"]);
function proxyTarget(url) {
  const m = /^\/proxy\/([a-f0-9]{20})(\/.*)?$/.exec(url.split("?")[0]);
  if (!m) return null;
  const p = previews.get(m[1]);
  if (!p || p.state !== "ready") return { error: 404 };
  const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  return { p, path: (m[2] || "/") + q };
}

function proxyHttp(req, res) {
  const t = proxyTarget(req.url);
  if (!t) return res.writeHead(404).end();
  if (t.error) return res.writeHead(t.error, { "content-type": "text/plain" }).end("Preview is not running");
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = "localhost:3000";
  const up = http.request({ host: PREVIEW_UPSTREAM, port: t.p.port, method: req.method, path: t.path, headers, timeout: 60_000 }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("Preview upstream error"); });
  up.on("timeout", () => up.destroy());
  req.pipe(up);
}

function proxyUpgrade(req, socket, head) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return socket.destroy();
  const t = proxyTarget(req.url || "");
  if (!t || t.error) return socket.destroy();
  const up = net.connect(t.p.port, PREVIEW_UPSTREAM, () => {
    let h = `${req.method} ${t.path} HTTP/1.1\r\nhost: localhost:3000\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase();
      if (["authorization", "host", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"].includes(k)) continue;
      h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(h + "\r\n"); if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
}

async function readBody(req) {
  let body = "";
  for await (const c of req) { body += c; if (body.length > 100_000) throw Object.assign(new Error("too large"), { status: 413 }); }
  return JSON.parse(body || "{}");
}

const server = http.createServer(async (req, res) => {
  const send = (s, b) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
  if (req.url?.startsWith("/proxy/")) return proxyHttp(req, res);
  if (req.url === "/health") {
    const v = await docker(["version", "--format", "{{.Server.Version}}"]);
    return send(v.code === 0 ? 200 : 503, { ok: v.code === 0, docker: v.out.trim() || v.err.trim().slice(0, 200), running: running.size, previews: [...previews.values()].filter(isActive).length, limits: { CPU, MEM, DISK, PIDS, MAX_TIMEOUT, PREVIEW_MAX, PREVIEW_MEM, PREVIEW_CPU } });
  }
  if (req.method === "POST" && req.url?.startsWith("/cancel/")) {
    const n = running.get(decodeURIComponent(req.url.slice(8)));
    if (n) await docker(["kill", n]);
    return send(200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/exec") {
    let body = "";
    for await (const c of req) { body += c; if (body.length > 100_000) return send(413, {}); }
    try { send(200, await exec(JSON.parse(body))); }
    catch (e) { send(e.status || 400, { error: e.message }); }
    return;
  }
  try {
    if (req.method === "POST" && req.url === "/preview/start") return send(200, startPreview(await readBody(req)));
    const m = /^\/preview\/([a-f0-9]{20})(\/stop)?$/.exec(req.url || "");
    if (m && req.method === "GET" && !m[2]) return send(200, await previewStatus(m[1]));
    if (m && req.method === "POST" && m[2]) { const p = previews.get(m[1]); if (p) await teardown(p, "stopped"); return send(200, { ok: true }); }
  } catch (e) { return send(e.status || 400, { error: e.message }); }
  send(404, { error: "not found" });
});
server.on("upgrade", proxyUpgrade);
await cleanupStalePreviews().catch((e) => console.error("[sandbox] preview cleanup", e.message));
server.listen(5000, () => console.log("[sandbox] listening on 5000"));
