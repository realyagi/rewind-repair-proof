import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { RepairRun, Project, RunStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { env } from "../config.js";
import { storage } from "../lib/storage.js";
import { sandbox, type SandboxResult } from "../lib/sandbox.js";
import { redact, truncate } from "../lib/redact.js";
import { vultr, parseJson } from "../ai/providers.js";
import { safeExtractZip, zipDirectory } from "../import/zip.js";
import { listFiles } from "../import/inspect.js";

class Cancelled extends Error {}

type Cmd = { phase: "install" | "build" | "test"; command: string };
type CmdResult = Cmd & SandboxResult & { passed: boolean };

type AgentOutput = {
  rootCause: string;
  confidence?: string;
  evidence: { file?: string; line?: number; logExcerpt?: string; reasoning: string }[];
  affectedFiles: string[];
  plan: string[];
  edits: { path: string; action: "replace" | "create" | "delete"; search?: string; replace?: string; content?: string; explanation: string }[];
};

const SYSTEM = `You are REWIND, a software repair agent. You receive REAL command output and REAL source files from an isolated sandbox.
Rules:
- Only reference files and lines that appear in the provided evidence. Never invent logs, files, or test results.
- Make the minimal change that fixes the root cause. Do not refactor unrelated code. Do not weaken or delete tests to make them pass.
- For "replace" edits, "search" must be an EXACT verbatim substring of the provided file content (include enough context to be unique).
- If the evidence is insufficient, return an empty "edits" array and explain in rootCause.
Respond with a single JSON object: {"rootCause": string, "confidence": "low"|"medium"|"high", "evidence": [{"file"?: string, "line"?: number, "logExcerpt"?: string, "reasoning": string}], "affectedFiles": string[], "plan": string[], "edits": [{"path": string, "action": "replace"|"create"|"delete", "search"?: string, "replace"?: string, "content"?: string, "explanation": string}]}`;

export async function executeRun(runId: string) {
  const run = await prisma.repairRun.findUniqueOrThrow({ where: { id: runId }, include: { project: { include: { imports: { orderBy: { createdAt: "desc" }, take: 1 } } } } });
  const ws = path.resolve(env.WORKSPACE_PATH, `run-${run.id}`);
  try {
    await doRun(run, run.project, ws);
  } catch (e) {
    if (e instanceof Cancelled) {
      await finish(run.id, "cancelled", "cancelled", "Run cancelled by user");
    } else {
      const msg = redact((e as Error).message ?? String(e));
      await log(run.id, "error", { message: msg });
      await finish(run.id, "failed", "failed", msg);
    }
  } finally {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  }
}

async function doRun(run: RepairRun, project: Project & { imports: { sourceKey: string | null }[] }, ws: string) {
  const cfg = run.config as { install?: string; build?: string; test?: string; image?: string; installNetwork?: boolean; timeoutSeconds?: number };
  const sourceKey = project.imports[0]?.sourceKey;
  if (!sourceKey) throw new Error("Project has no imported source");

  // B — isolated workspace (copy of the preserved source snapshot)
  await setStatus(run.id, "inspecting", "prepare_workspace");
  await fs.rm(ws, { recursive: true, force: true });
  await safeExtractZip(await storage.get(sourceKey), ws);
  const original = await snapshot(ws);
  await log(run.id, "workspace", { message: `Workspace prepared with ${original.size} files` });

  const sb = await sandbox.health();
  if (!sb.ok) throw new Error(`Sandbox unavailable — cannot execute project code safely. ${JSON.stringify(sb.detail)}`);

  const cmds: Cmd[] = [];
  if (cfg.build) cmds.push({ phase: "build", command: cfg.build });
  if (cfg.test) cmds.push({ phase: "test", command: cfg.test });
  if (!cmds.length) throw new Error("No build or test command configured or detected. Configure commands in project settings.");
  if (!cfg.image) throw new Error("No sandbox image configured or detected. Set a sandbox image in project settings.");

  // C — baseline
  await setStatus(run.id, "baseline_running", "baseline");
  if (cfg.install) await runCmd(run, ws, cfg, { phase: "install", command: cfg.install }, 0, true);
  const baseline: CmdResult[] = [];
  for (const c of cmds) baseline.push(await runCmd(run, ws, cfg, c, 0, true));
  if (baseline.every((r) => r.passed)) {
    await finish(run.id, "completed_unverified", "not_reproduced", "All baseline commands passed — the failure could not be reproduced. No changes were made.");
    return;
  }

  let failing = baseline.filter((r) => !r.passed);
  for (let attempt = 1; attempt <= run.maxRetries + 1; attempt++) {
    await prisma.repairRun.update({ where: { id: run.id }, data: { attempt } });
    if (attempt > 1) await setStatus(run.id, "retrying", "retry", attempt);

    // D — diagnosis with real evidence
    await setStatus(run.id, "diagnosing", "diagnose", attempt);
    const evidence = await gatherEvidence(ws, failing);
    const ai = await vultr.chat([
      { role: "system", content: SYSTEM },
      { role: "user", content: evidence.prompt },
    ], { json: true });
    let out: AgentOutput;
    try { out = parseJson<AgentOutput>(ai.text); } catch { throw new Error("Vultr Inference returned non-JSON output"); }
    out.evidence ??= []; out.affectedFiles ??= []; out.plan ??= []; out.edits ??= [];
    const fileSet = new Set(evidence.allFiles);
    out.affectedFiles = out.affectedFiles.filter((f) => fileSet.has(f));
    await prisma.diagnosis.create({ data: { runId: run.id, attempt, rootCause: out.rootCause ?? "", evidence: out.evidence, affectedFiles: out.affectedFiles, confidence: out.confidence ?? null, model: ai.model, usage: (ai.usage ?? undefined) as object | undefined } });

    await setStatus(run.id, "planning", "plan", attempt);
    await prisma.repairPlan.create({ data: { runId: run.id, attempt, steps: out.plan } });
    if (!out.edits.length) { await finish(run.id, "completed_unverified", "unverified", "Agent could not determine a safe patch from the evidence."); await writeReport(run.id, ws, original); return; }

    // E — patch
    await setStatus(run.id, "patching", "patch", attempt);
    const before = await snapshot(ws);
    const { rejected, explanations } = await applyEdits(ws, out.edits, fileSet);
    const after = await snapshot(ws);
    const diff = makeDiff(before, after);
    await prisma.patch.create({ data: { runId: run.id, attempt, ...diff.meta, explanations, diff: diff.text, rejected } });
    await log(run.id, "patch", { message: `Applied ${explanations.length} edit(s); rejected ${rejected.length}` });
    if (!diff.text) { failing = failing; if (attempt > run.maxRetries) break; continue; }

    // F — verify
    await setStatus(run.id, "verifying", "verify", attempt);
    const results: CmdResult[] = [];
    for (const c of cmds) results.push(await runCmd(run, ws, cfg, c, attempt, false));
    if (results.every((r) => r.passed)) {
      await writeReport(run.id, ws, original);
      await finish(run.id, "completed_verified", "verified", `Verified: ${results.map((r) => `${r.phase} exit ${r.exitCode}`).join(", ")} (baseline failed: ${baseline.filter((b) => !b.passed).map((b) => `${b.phase} exit ${b.exitCode}`).join(", ")}).`);
      return;
    }
    failing = results.filter((r) => !r.passed);
  }
  await writeReport(run.id, ws, original);
  await finish(run.id, "completed_unverified", "unverified", `Retry limit reached. Verification still failing: ${failing.map((f) => `${f.phase} exit ${f.exitCode}`).join(", ")}. Patch is NOT verified.`);
}

async function checkCancel(runId: string) {
  const r = await prisma.repairRun.findUnique({ where: { id: runId }, select: { cancelRequested: true } });
  if (r?.cancelRequested) throw new Cancelled();
}

async function setStatus(runId: string, status: RunStatus, step: string, attempt = 0) {
  await checkCancel(runId);
  await prisma.runStep.updateMany({ where: { runId, finishedAt: null }, data: { finishedAt: new Date(), status: "done" } });
  await prisma.repairRun.update({ where: { id: runId }, data: { status } });
  await prisma.runStep.create({ data: { runId, name: step, status: "running", attempt } });
}

async function finish(runId: string, status: RunStatus, outcome: "verified" | "unverified" | "failed" | "not_reproduced" | "cancelled", summary: string) {
  await prisma.runStep.updateMany({ where: { runId, finishedAt: null }, data: { finishedAt: new Date(), status: status === "failed" ? "failed" : "done" } });
  await prisma.repairRun.update({ where: { id: runId }, data: { status, outcome, summary, finishedAt: new Date(), ...(status === "failed" ? { error: summary } : {}) } });
}

async function log(runId: string, phase: string, d: { command?: string; exitCode?: number | null; durationMs?: number; stdout?: string; stderr?: string; message?: string; fullLogKey?: string; timedOut?: boolean }) {
  await prisma.runLog.create({ data: { runId, phase, command: d.command ?? null, exitCode: d.exitCode ?? null, durationMs: d.durationMs ?? null, stdout: d.stdout ? truncate(redact(d.stdout)) : null, stderr: d.stderr ? truncate(redact(d.stderr)) : null, message: d.message ?? null, fullLogKey: d.fullLogKey ?? null, timedOut: d.timedOut ?? false } });
}

async function runCmd(run: RepairRun, ws: string, cfg: { image?: string; installNetwork?: boolean; timeoutSeconds?: number }, c: Cmd, attempt: number, isBaseline: boolean): Promise<CmdResult> {
  await checkCancel(run.id);
  const res = await sandbox.exec({
    jobId: run.id, workspace: path.basename(ws), image: cfg.image!, command: c.command,
    network: c.phase === "install" && cfg.installNetwork !== false,
    timeoutSeconds: Math.min(cfg.timeoutSeconds ?? env.SANDBOX_TIMEOUT_SECONDS, env.SANDBOX_TIMEOUT_SECONDS),
  });
  const passed = res.exitCode === 0 && !res.timedOut;
  const key = `runs/${run.id}/logs/${Date.now()}-${c.phase}.log`;
  await storage.put(key, Buffer.from(redact(`$ ${c.command}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\nexit=${res.exitCode} timedOut=${res.timedOut}`)));
  await log(run.id, isBaseline ? `baseline:${c.phase}` : `verify:${c.phase}`, { command: c.command, exitCode: res.exitCode, durationMs: res.durationMs, stdout: res.stdout, stderr: res.stderr, fullLogKey: key, timedOut: res.timedOut, message: res.resources ? JSON.stringify(res.resources) : undefined });
  if (c.phase !== "install") await prisma.verificationResult.create({ data: { runId: run.id, attempt, phase: c.phase, command: c.command, exitCode: res.exitCode, passed, baseline: isBaseline, timedOut: res.timedOut } });
  await checkCancel(run.id);
  return { ...c, ...res, passed };
}

async function gatherEvidence(ws: string, failing: CmdResult[]) {
  const allFiles = await listFiles(ws);
  const logs = failing.map((f) => `### ${f.phase}: \`${f.command}\` exit=${f.exitCode}${f.timedOut ? " (TIMED OUT)" : ""}\nSTDOUT:\n${truncate(redact(f.stdout), 12000)}\nSTDERR:\n${truncate(redact(f.stderr), 12000)}`).join("\n\n");
  const referenced = new Set<string>();
  for (const f of allFiles) {
    const base = path.basename(f);
    if (logs.includes(f) || (base.length > 4 && new RegExp(`[\\s/(]${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:\\s)]`).test(logs))) referenced.add(f);
  }
  // Always include the failing tests and the production source they import.
  // The previous implementation only included files whose names appeared in logs;
  // test output usually names the test file, not the implementation under test.
  const isTest = (f: string) => /(\.|_)(test|spec)\.[a-z0-9]+$|(^|\/)tests?\/|(^|\/)test_[^/]+\.py$/i.test(f);
  const isSource = (f: string) => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte)$/i.test(f);
  const isUsefulText = (f: string) => isSource(f) || /(^|\/)(package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+|jest\.config\.[^/]+|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod)$/.test(f);
  const byPriority: string[] = [];
  const add = (f: string) => { if (allFiles.includes(f) && isUsefulText(f) && !byPriority.includes(f)) byPriority.push(f); };
  for (const f of referenced) add(f);
  const tests = allFiles.filter(isTest);
  for (const f of tests) add(f);

  // Resolve relative imports from test files, then follow their imports up to two levels.
  // This makes implementation files available even when test output only mentions tests.
  const fileSet = new Set(allFiles);
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".vue", ".svelte"];
  const resolveLocal = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    const candidates = [base, ...extensions.map((ext) => base.endsWith(ext) ? base : base + ext), ...extensions.map((ext) => path.posix.join(base, "index" + ext))];
    return candidates.find((candidate) => fileSet.has(candidate));
  };
  const importPattern = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
  const visited = new Set<string>();
  let frontier = tests.slice(0, 80);
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      if (visited.has(file)) continue;
      visited.add(file);
      const content = await fs.readFile(path.join(ws, file), "utf8").catch(() => "");
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(content))) {
        const target = resolveLocal(file, match[1] ?? match[2] ?? "");
        if (target && !visited.has(target)) { add(target); next.push(target); }
      }
      importPattern.lastIndex = 0;
    }
    frontier = next;
  }

  // For projects with non-standard imports or aliases, include additional source files
  // within a bounded evidence budget instead of silently omitting all implementation code.
  for (const f of allFiles) if (isSource(f) && !isTest(f)) add(f);
  for (const f of allFiles) if (isUsefulText(f) && !isSource(f)) add(f);
  const chosen = byPriority.slice(0, 40);
  let budget = 80000;
  const sources: string[] = [];
  for (const f of chosen) {
    const content = await fs.readFile(path.join(ws, f), "utf8").catch(() => "");
    if (!content || content.includes("\0")) continue;
    const slice = content.slice(0, Math.min(budget, 15000));
    budget -= slice.length;
    sources.push(`=== FILE: ${f} ===\n${slice.split("\n").map((l, i) => `${i + 1}| ${l}`).join("\n")}`);
    if (budget <= 0) break;
  }
  const tree = allFiles.slice(0, 400).join("\n");
  const prompt = `## Failing commands (real sandbox output)\n${logs}\n\n## Project files (partial list)\n${tree}\n\n## Source files referenced in the logs (line-numbered; strip the "N| " prefix when quoting search strings)\n${sources.join("\n\n") || "(no files from the project were referenced in the logs)"}`;
  return { prompt, allFiles };
}

function inside(ws: string, rel: string) {
  const t = path.resolve(ws, rel);
  if (!t.startsWith(ws + path.sep) || /(^|\/)(\.git|node_modules)(\/|$)/.test(rel)) throw new Error(`Unsafe path ${rel}`);
  return t;
}

async function applyEdits(ws: string, edits: AgentOutput["edits"], fileSet: Set<string>) {
  const rejected: { path: string; reason: string }[] = [];
  const explanations: { path: string; action: string; explanation: string }[] = [];
  for (const e of edits.slice(0, 20)) {
    try {
      const p = inside(ws, e.path);
      if (e.action === "create") {
        if (fileSet.has(e.path)) throw new Error("file already exists");
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, e.content ?? "");
      } else if (e.action === "delete") {
        if (!fileSet.has(e.path)) throw new Error("file does not exist");
        await fs.rm(p);
      } else {
        if (!fileSet.has(e.path)) throw new Error("file does not exist");
        const cur = await fs.readFile(p, "utf8");
        if (!e.search || !cur.includes(e.search)) throw new Error("search text not found verbatim");
        if (cur.indexOf(e.search) !== cur.lastIndexOf(e.search)) throw new Error("search text is ambiguous");
        await fs.writeFile(p, cur.replace(e.search, () => e.replace ?? ""));
      }
      explanations.push({ path: e.path, action: e.action, explanation: e.explanation });
    } catch (err) {
      rejected.push({ path: e.path, reason: (err as Error).message });
    }
  }
  return { rejected, explanations };
}

async function snapshot(ws: string) {
  const m = new Map<string, string>();
  for (const f of await listFiles(ws)) {
    const b = await fs.readFile(path.join(ws, f));
    if (b.length < 1_000_000 && !b.includes(0)) m.set(f, b.toString("utf8"));
  }
  return m;
}

function makeDiff(a: Map<string, string>, b: Map<string, string>) {
  const changed: string[] = [], created: string[] = [], deleted: string[] = [];
  let text = "";
  for (const [f, c] of b) {
    if (!a.has(f)) { created.push(f); text += createTwoFilesPatch("/dev/null", `b/${f}`, "", c); }
    else if (a.get(f) !== c) { changed.push(f); text += createTwoFilesPatch(`a/${f}`, `b/${f}`, a.get(f)!, c); }
  }
  for (const f of a.keys()) if (!b.has(f)) { deleted.push(f); text += createTwoFilesPatch(`a/${f}`, "/dev/null", a.get(f)!, ""); }
  return { text, meta: { changed, created, deleted } };
}

async function writeReport(runId: string, ws: string, original: Map<string, string>) {
  const cur = await snapshot(ws);
  const full = makeDiff(original, cur);
  const zipKey = `runs/${runId}/repaired.zip`;
  const zip = await zipDirectory(ws);
  await storage.put(zipKey, zip);
  const diffKey = `runs/${runId}/repair.diff`;
  await storage.put(diffKey, Buffer.from(full.text));
  await prisma.artifact.createMany({ data: [
    { runId, kind: "repaired_zip", key: zipKey, sizeBytes: BigInt(zip.length) },
    { runId, kind: "diff", key: diffKey, sizeBytes: BigInt(full.text.length) },
  ] });
}
