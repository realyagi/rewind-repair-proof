// Derives the investigation timeline and proof-of-repair from persisted run data only.
// Anything not backed by a stored record is shown as pending/skipped — never invented.
import type { RunDetail, RunLog } from "./api";
import { TERMINAL } from "./api";

export type EventStatus = "done" | "failed" | "running" | "pending" | "skipped" | "cancelled";
export interface TimelineEvent {
  key: string;
  title: string;
  status: EventStatus;
  at: string | null;
  detail: string;
  evidence?: string | undefined;
}

const last = <T>(a: T[]) => a[a.length - 1];
const step = (r: RunDetail, name: string) => r.steps.find((s) => s.name === name);
const lastStep = (r: RunDetail, name: string) =>
  [...r.steps].reverse().find((s) => s.name === name);
const fmt = (v: { phase: string; exitCode: number | null; passed: boolean; timedOut: boolean }) =>
  `${v.phase} ${v.timedOut ? "timed out" : `exit ${v.exitCode}`} (${v.passed ? "pass" : "fail"})`;

export function buildTimeline(r: RunDetail): TimelineEvent[] {
  const done = TERMINAL.includes(r.status);
  const missing = (reason?: string): Pick<TimelineEvent, "status" | "at" | "detail"> =>
    !done
      ? { status: "pending", at: null, detail: "Not reached yet." }
      : r.status === "cancelled"
        ? { status: "cancelled", at: null, detail: "Run was cancelled before this step." }
        : r.outcome === "not_reproduced"
          ? {
              status: "skipped",
              at: null,
              detail: "Skipped — baseline checks passed, so there was no failure to repair.",
            }
          : {
              status: "skipped",
              at: null,
              detail:
                reason ??
                (r.status === "failed"
                  ? `Run failed before this step${r.error ? `: ${r.error}` : "."}`
                  : "This step did not run."),
            };

  const ev: TimelineEvent[] = [];
  const imp = r.project.imports?.[0];
  ev.push(
    imp
      ? {
          key: "import",
          title: "Project imported",
          status: "done",
          at: imp.completedAt ?? imp.createdAt,
          detail: `${r.project.source === "github" ? "GitHub repository" : "ZIP archive"}${imp.fileCount != null ? ` · ${imp.fileCount} files` : ""}`,
        }
      : {
          key: "import",
          title: "Project imported",
          status: "skipped",
          at: null,
          detail: "No completed import record found.",
        },
  );

  const base = step(r, "baseline");
  ev.push(
    base
      ? {
          key: "baseline_start",
          title: "Baseline checks started",
          status: "done",
          at: base.startedAt,
          detail: "Install, build and test commands executed in the sandbox before any change.",
        }
      : { key: "baseline_start", title: "Baseline checks started", ...missing() },
  );

  const bv = r.verifications.filter((v) => v.baseline);
  ev.push(
    bv.length
      ? {
          key: "baseline_results",
          title: "Baseline results collected",
          status: bv.some((v) => !v.passed) ? "failed" : "done",
          at: last(bv)!.createdAt ?? base?.finishedAt ?? null,
          detail: bv.map(fmt).join(" · "),
          evidence: bv.map((v) => `$ ${v.command}`).join("\n"),
        }
      : {
          key: "baseline_results",
          title: "Baseline results collected",
          ...(base && !done
            ? { status: "running" as const, at: null, detail: "Commands running…" }
            : missing()),
        },
  );

  const diag0 = step(r, "diagnose");
  ev.push(
    diag0
      ? {
          key: "investigate",
          title: "Investigation started",
          status: "done",
          at: diag0.startedAt,
          detail: `Failure evidence sent to ${r.diagnoses[0]?.model ?? "Vultr Inference"} for diagnosis.`,
        }
      : { key: "investigate", title: "Investigation started", ...missing() },
  );

  const d = last(r.diagnoses);
  ev.push(
    d
      ? {
          key: "root_cause",
          title: "Root cause identified",
          status: d.rootCause ? "done" : "failed",
          at: d.createdAt ?? null,
          detail: d.rootCause
            ? `${d.rootCause.slice(0, 220)}${d.rootCause.length > 220 ? "…" : ""}`
            : "Model returned no root cause.",
          evidence: d.affectedFiles.join("\n") || undefined,
        }
      : {
          key: "root_cause",
          title: "Root cause identified",
          ...(diag0 && !done
            ? { status: "running" as const, at: null, detail: "Diagnosing…" }
            : missing()),
        },
  );

  const p = last(r.plans);
  ev.push(
    p
      ? {
          key: "plan",
          title: "Repair plan generated",
          status: p.steps.length ? "done" : "failed",
          at: p.createdAt ?? null,
          detail: p.steps.length
            ? `${p.steps.length} step plan (attempt ${p.attempt}).`
            : "Empty plan.",
        }
      : { key: "plan", title: "Repair plan generated", ...missing() },
  );

  const pa = last(r.patches);
  ev.push(
    pa
      ? {
          key: "patch",
          title: "Patch applied",
          status: pa.diff ? "done" : "failed",
          at: pa.createdAt ?? null,
          detail: pa.diff
            ? `${pa.changed.length} changed · ${pa.created.length} created · ${pa.deleted.length} deleted${pa.rejected?.length ? ` · ${pa.rejected.length} edit(s) rejected` : ""}`
            : "No change could be applied.",
        }
      : {
          key: "patch",
          title: "Patch applied",
          ...(p && done && r.outcome === "unverified"
            ? {
                status: "skipped" as const,
                at: null,
                detail: r.summary ?? "No patch was produced.",
              }
            : missing()),
        },
  );

  const vs = lastStep(r, "verify");
  ev.push(
    vs
      ? {
          key: "verify_start",
          title: "Verification started",
          status: "done",
          at: vs.startedAt,
          detail: `Attempt ${vs.attempt}: build/test re-run on the patched workspace.`,
        }
      : { key: "verify_start", title: "Verification started", ...missing() },
  );

  const vv = finalVerification(r);
  ev.push(
    vv.length
      ? {
          key: "verify_done",
          title: "Verification completed",
          status: vv.every((v) => v.passed) ? "done" : "failed",
          at: last(vv)!.createdAt ?? null,
          detail: vv.map(fmt).join(" · "),
        }
      : {
          key: "verify_done",
          title: "Verification completed",
          ...(vs && !done
            ? { status: "running" as const, at: null, detail: "Verifying…" }
            : missing()),
        },
  );
  return ev;
}

/** Verification results from the latest attempt only. */
export function finalVerification(r: RunDetail) {
  const v = r.verifications.filter((x) => !x.baseline);
  const max = Math.max(0, ...v.map((x) => x.attempt));
  return v.filter((x) => x.attempt === max);
}

export type CheckResult = {
  command: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number | null;
  log?: RunLog | undefined;
} | null;
export type Change = "fixed" | "still_failing" | "regressed" | "passing" | "not_run";
export interface ProofRow {
  phase: string;
  before: CheckResult;
  after: CheckResult;
  change: Change;
}

export function buildProof(r: RunDetail, logs: RunLog[]): ProofRow[] {
  const phases = [...new Set(r.verifications.map((v) => v.phase))];
  const logFor = (prefix: string, phase: string, nth: number) =>
    logs.filter((l) => l.phase === `${prefix}:${phase}`)[nth];
  return phases.map((phase) => {
    const b = r.verifications.find((v) => v.baseline && v.phase === phase);
    const all = r.verifications.filter((v) => !v.baseline && v.phase === phase);
    const fv = finalVerification(r).find((v) => v.phase === phase);
    const bl = b ? logFor("baseline", phase, 0) : undefined;
    const al = fv ? logFor("verify", phase, all.indexOf(fv)) : undefined;
    const before: CheckResult = b
      ? {
          command: b.command,
          exitCode: b.exitCode,
          passed: b.passed,
          timedOut: b.timedOut,
          durationMs: bl?.durationMs ?? null,
          log: bl,
        }
      : null;
    const after: CheckResult = fv
      ? {
          command: fv.command,
          exitCode: fv.exitCode,
          passed: fv.passed,
          timedOut: fv.timedOut,
          durationMs: al?.durationMs ?? null,
          log: al,
        }
      : null;
    const change: Change = !after
      ? "not_run"
      : before && !before.passed && after.passed
        ? "fixed"
        : !after.passed && before?.passed
          ? "regressed"
          : !after.passed
            ? "still_failing"
            : "passing";
    return { phase, before, after, change };
  });
}

/** Facts-only list of remaining risks for the report. */
export function remainingRisks(r: RunDetail): string[] {
  const out: string[] = [];
  const phases = new Set(r.verifications.map((v) => v.phase));
  if (!phases.has("test"))
    out.push("No test command was run — behaviour is not covered by an automated test suite.");
  if (!phases.has("build")) out.push("No build command was run.");
  for (const v of finalVerification(r))
    if (!v.passed)
      out.push(
        `${v.phase} still fails after the last attempt (${v.timedOut ? "timed out" : `exit ${v.exitCode}`}).`,
      );
  const rej = r.patches.flatMap((p) => p.rejected ?? []);
  if (rej.length) out.push(`${rej.length} proposed edit(s) were rejected and not applied.`);
  const d = r.diagnoses[r.diagnoses.length - 1];
  if (d?.confidence && /low/i.test(d.confidence))
    out.push("The diagnosis was reported with low confidence.");
  if (r.outcome === "not_reproduced")
    out.push("The reported failure could not be reproduced; no repair was attempted.");
  if (r.error) out.push(`Run error: ${r.error}`);
  return out;
}
