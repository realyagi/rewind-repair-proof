import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prisma } from "./db.js";
import { env } from "./config.js";
import { executeRun } from "./repair/engine.js";
import { expirePreviews } from "./preview/service.js";

const workerId = `${os.hostname()}-${process.pid}`;
const active = new Set<string>();
let lastTick = Date.now();

/** Claim the next queued run atomically (Postgres SKIP LOCKED queue). */
async function claim(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "RepairRun" SET status = 'inspecting', "workerId" = ${workerId}, "startedAt" = now()
    WHERE id = (SELECT id FROM "RepairRun" WHERE status = 'queued' AND "cancelRequested" = false
                ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return rows[0]?.id ?? null;
}

async function tick() {
  lastTick = Date.now();
  // cancel queued runs whose cancel was requested before pickup
  await prisma.repairRun.updateMany({ where: { status: "queued", cancelRequested: true }, data: { status: "cancelled", outcome: "cancelled", finishedAt: new Date() } });
  while (active.size < env.MAX_CONCURRENT_REPAIR_RUNS) {
    const id = await claim();
    if (!id) break;
    active.add(id);
    console.log(`[worker] picked run ${id}`);
    executeRun(id).finally(() => active.delete(id));
  }
}

/** Mark runs orphaned by a crashed worker as failed. */
async function recoverOrphans() {
  await prisma.repairRun.updateMany({
    where: { workerId, status: { notIn: ["queued", "completed_verified", "completed_unverified", "failed", "cancelled"] } },
    data: { status: "failed", outcome: "failed", error: "Worker restarted during execution", finishedAt: new Date() },
  });
}

async function cleanup() {
  const root = path.resolve(env.WORKSPACE_PATH);
  const cutoff = Date.now() - env.WORKSPACE_TTL_HOURS * 3600_000;
  for (const d of await fs.readdir(root).catch(() => [])) {
    const p = path.join(root, d);
    const st = await fs.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff && !active.has(d.replace(/^run-/, ""))) await fs.rm(p, { recursive: true, force: true });
  }
}

http.createServer((_, res) => {
  const ok = Date.now() - lastTick < 30_000;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok, active: active.size, workerId }));
}).listen(4100);

await fs.mkdir(env.WORKSPACE_PATH, { recursive: true });
await recoverOrphans();
setInterval(() => tick().catch((e) => console.error("[worker] tick", e.message)), 2000);
setInterval(() => cleanup().catch(() => {}), 15 * 60_000);
setInterval(() => expirePreviews().then((n) => { if (n) console.log(`[worker] expired ${n} preview(s)`); }).catch((e) => console.error("[worker] preview expiry", e.message)), 30_000);
console.log(`[worker] ${workerId} started, concurrency=${env.MAX_CONCURRENT_REPAIR_RUNS}`);
