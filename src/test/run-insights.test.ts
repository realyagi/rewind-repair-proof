import { describe, it, expect } from "vitest";
import { buildTimeline, buildProof, remainingRisks } from "@/lib/run-insights";
import { parseUnifiedDiff } from "@/lib/diff";
import type { RunDetail, RunLog } from "@/lib/api";

const base = (over: Partial<RunDetail> = {}): RunDetail => ({
  id: "r1",
  status: "completed_verified",
  outcome: "verified",
  createdAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:05:00Z",
  summary: "Verified",
  attempt: 1,
  maxRetries: 2,
  projectId: "p1",
  error: null,
  cancelRequested: false,
  config: {},
  project: {
    id: "p1",
    name: "calculator",
    source: "zip",
    imports: [
      { createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z", fileCount: 4 },
    ],
  },
  steps: [
    {
      id: "s1",
      name: "prepare_workspace",
      status: "done",
      attempt: 0,
      startedAt: "2026-01-01T00:00:02Z",
      finishedAt: null,
    },
    {
      id: "s2",
      name: "baseline",
      status: "done",
      attempt: 0,
      startedAt: "2026-01-01T00:00:03Z",
      finishedAt: null,
    },
    {
      id: "s3",
      name: "diagnose",
      status: "done",
      attempt: 1,
      startedAt: "2026-01-01T00:01:00Z",
      finishedAt: null,
    },
    {
      id: "s4",
      name: "verify",
      status: "done",
      attempt: 1,
      startedAt: "2026-01-01T00:03:00Z",
      finishedAt: null,
    },
  ],
  logs: [],
  diagnoses: [
    {
      id: "d",
      attempt: 1,
      rootCause: "add() subtracts",
      confidence: "high",
      model: "m",
      evidence: [],
      affectedFiles: ["calc.js"],
    },
  ],
  plans: [{ id: "pl", attempt: 1, steps: ["fix add"] }],
  patches: [
    {
      id: "pa",
      attempt: 1,
      changed: ["calc.js"],
      created: [],
      deleted: [],
      explanations: [],
      diff: "--- a/calc.js\n+++ b/calc.js\n@@ -1,1 +1,1 @@\n-a-b\n+a+b\n",
      rejected: null,
    },
  ],
  verifications: [
    {
      id: "v1",
      attempt: 0,
      phase: "test",
      command: "npm test",
      exitCode: 1,
      passed: false,
      baseline: true,
      timedOut: false,
    },
    {
      id: "v2",
      attempt: 1,
      phase: "test",
      command: "npm test",
      exitCode: 0,
      passed: true,
      baseline: false,
      timedOut: false,
    },
  ],
  artifacts: [],
  ...over,
});

describe("investigation timeline", () => {
  it("shows all nine events for a verified run", () => {
    const t = buildTimeline(base());
    expect(t.map((e) => e.key)).toEqual([
      "import",
      "baseline_start",
      "baseline_results",
      "investigate",
      "root_cause",
      "plan",
      "patch",
      "verify_start",
      "verify_done",
    ]);
    expect(t.find((e) => e.key === "baseline_results")?.status).toBe("failed");
    expect(t.find((e) => e.key === "verify_done")?.status).toBe("done");
  });
  it("does not fabricate later events for a not-reproduced run", () => {
    const t = buildTimeline(
      base({
        outcome: "not_reproduced",
        status: "completed_unverified",
        diagnoses: [],
        plans: [],
        patches: [],
        verifications: [
          {
            id: "v",
            attempt: 0,
            phase: "test",
            command: "npm test",
            exitCode: 0,
            passed: true,
            baseline: true,
            timedOut: false,
          },
        ],
        steps: base().steps.slice(0, 2),
      }),
    );
    expect(t.find((e) => e.key === "root_cause")).toMatchObject({ status: "skipped", at: null });
    expect(t.find((e) => e.key === "verify_done")).toMatchObject({ status: "skipped", at: null });
  });
  it("marks unreached steps of a running run as pending", () => {
    const t = buildTimeline(
      base({
        status: "diagnosing",
        outcome: null,
        diagnoses: [],
        plans: [],
        patches: [],
        verifications: [],
        steps: base().steps.slice(0, 3),
      }),
    );
    expect(t.find((e) => e.key === "patch")?.status).toBe("pending");
  });
  it("marks remaining steps cancelled for a cancelled run", () => {
    const t = buildTimeline(
      base({
        status: "cancelled",
        outcome: "cancelled",
        patches: [],
        verifications: [],
        steps: base().steps.slice(0, 2),
      }),
    );
    expect(t.find((e) => e.key === "verify_done")?.status).toBe("cancelled");
  });
});

describe("proof of repair", () => {
  it("compares baseline failure with final passing result and durations from logs", () => {
    const logs = [
      { phase: "baseline:test", durationMs: 1200 },
      { phase: "verify:test", durationMs: 900 },
    ] as RunLog[];
    const [row] = buildProof(base(), logs);
    expect(row).toMatchObject({ phase: "test", change: "fixed" });
    expect(row!.before?.durationMs).toBe(1200);
    expect(row!.after?.durationMs).toBe(900);
  });
  it("never turns a missing post-repair check into a pass", () => {
    const [row] = buildProof(base({ verifications: [base().verifications[0]!] }), []);
    expect(row!.after).toBeNull();
    expect(row!.change).toBe("not_run");
  });
  it("reports missing build/test commands as risks", () => {
    expect(remainingRisks(base())).toContain("No build command was run.");
  });
});

describe("side-by-side diff parser", () => {
  it("pairs removed and added lines as a modification", () => {
    const [f] = parseUnifiedDiff(base().patches[0]!.diff);
    expect(f).toMatchObject({ path: "calc.js", status: "modified", additions: 1, deletions: 1 });
    const line = f!.rows.find((r) => r.kind === "line");
    expect(line).toMatchObject({
      modified: true,
      left: { text: "a-b", type: "del", no: 1 },
      right: { text: "a+b", type: "add", no: 1 },
    });
  });
  it("detects created files", () => {
    const [f] = parseUnifiedDiff("--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,1 @@\n+x\n");
    expect(f).toMatchObject({ path: "new.js", status: "added", additions: 1 });
  });
});
