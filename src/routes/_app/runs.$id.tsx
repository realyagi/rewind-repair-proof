import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, download, TERMINAL, type RunDetail, type RunLog } from "@/lib/api";
import { buildTimeline, buildProof } from "@/lib/run-insights";
import { StatusBadge } from "@/components/rewind/StatusBadge";
import { ApiNotice } from "@/components/rewind/ApiNotice";
import { SideBySideDiff } from "@/components/rewind/SideBySideDiff";
import { Timeline } from "@/components/rewind/Timeline";
import { ProofOfRepair } from "@/components/rewind/ProofOfRepair";
import { PreviewPanel } from "@/components/rewind/PreviewPanel";
import { RepairReport } from "@/components/rewind/RepairReport";
import { AssistPanel } from "@/components/rewind/AssistPanel";

export const Route = createFileRoute("/_app/runs/$id")({
  head: () => ({
    meta: [
      { title: "Repair run — REWIND" },
      {
        name: "description",
        content:
          "Investigation timeline, diagnosis, patch comparison, verification evidence and live preview for a repair run.",
      },
    ],
  }),
  component: RunPage,
});

const VERDICT: Record<string, { title: string; cls: string }> = {
  verified: {
    title: "Verified — all verification commands exited 0 after the patch.",
    cls: "border-success/40 bg-success/10",
  },
  unverified: {
    title: "Unverified — the patch did not pass verification.",
    cls: "border-warning/40 bg-warning/10",
  },
  not_reproduced: {
    title: "Could not reproduce — baseline checks already passed.",
    cls: "bg-card",
  },
  failed: {
    title: "Failed — the run stopped with an error.",
    cls: "border-destructive/40 bg-destructive/10",
  },
  cancelled: { title: "Cancelled.", cls: "bg-card" },
};

function RunPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const logsRef = useRef<RunLog[]>([]);
  const [logs, setLogs] = useState<RunLog[]>([]);
  const q = useQuery({
    queryKey: ["run", id],
    queryFn: async () => {
      const after = logsRef.current.at(-1)?.seq ?? 0;
      const r = await api<RunDetail>(`/runs/${id}?afterSeq=${after}`);
      if (r.logs.length) {
        logsRef.current = [...logsRef.current, ...r.logs];
        setLogs(logsRef.current);
      }
      return r;
    },
    refetchInterval: (query) =>
      query.state.data && TERMINAL.includes(query.state.data.status) ? false : 2000,
  });
  useEffect(() => {
    logsRef.current = [];
    setLogs([]);
  }, [id]);
  const r = q.data;
  const timeline = useMemo(() => (r ? buildTimeline(r) : []), [r]);
  const proof = useMemo(() => (r ? buildProof(r, logs) : []), [r, logs]);

  if (q.error) return <ApiNotice error={q.error} />;
  if (!r) return <p className="label-mono">Loading run…</p>;
  const done = TERMINAL.includes(r.status);
  const zip = r.artifacts.find((a) => a.kind === "repaired_zip");
  const diffA = r.artifacts.find((a) => a.kind === "diff");
  const lastDiag = r.diagnoses.at(-1);
  const lastPlan = r.plans.at(-1);
  const verdict = r.outcome ? VERDICT[r.outcome] : null;

  async function cancel() {
    try {
      await api(`/runs/${id}/cancel`, { method: "POST" });
      toast("Cancellation requested");
      qc.invalidateQueries({ queryKey: ["run", id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/projects/$id"
            params={{ id: r.project.id }}
            className="label-mono hover:text-foreground"
          >
            ← {r.project.name}
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-bold sm:text-3xl">
            Repair run <StatusBadge status={r.status} outcome={r.outcome} />
          </h1>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {r.id} · attempt {r.attempt}/{r.maxRetries + 1} · started{" "}
            {new Date(r.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!done && (
            <Button variant="destructive" onClick={cancel} disabled={r.cancelRequested}>
              {r.cancelRequested ? "Cancelling…" : "Cancel run"}
            </Button>
          )}
          {zip && (
            <Button onClick={() => download(`/runs/${id}/artifacts/${zip.id}`, `rewind-${id}.zip`)}>
              Download repaired ZIP
            </Button>
          )}
          {diffA && (
            <Button
              variant="outline"
              onClick={() => download(`/runs/${id}/artifacts/${diffA.id}`, `rewind-${id}.diff`)}
            >
              Download .diff
            </Button>
          )}
          {done && (
            <Button
              variant="outline"
              onClick={() => download(`/runs/${id}/report`, `rewind-report-${id}.json`)}
            >
              Report JSON
            </Button>
          )}
        </div>
      </div>

      {(verdict || r.summary) && (
        <div className={`rounded-md border p-4 text-sm ${verdict?.cls ?? "bg-card"}`}>
          {verdict && <p className="font-semibold">{verdict.title}</p>}
          {r.summary && <p className="mt-1 text-muted-foreground">{r.summary}</p>}
        </div>
      )}
      {r.status === "retrying" || r.attempt > 1 ? (
        <p className="font-mono text-xs text-warning">
          Retry {Math.max(r.attempt - 1, 1)} of {r.maxRetries} — re-diagnosing with new verification
          evidence.
        </p>
      ) : null}

      <Tabs defaultValue="timeline">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="diagnosis">Diagnosis</TabsTrigger>
          <TabsTrigger value="patch">
            Patch{r.patches.length ? ` (${r.patches.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="verify">Verification</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
          <TabsTrigger value="logs">Logs ({logs.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="rounded-md border bg-card p-5">
          <Timeline events={timeline} />
        </TabsContent>

        <TabsContent value="diagnosis" className="space-y-4">
          {r.diagnoses.length === 0 && (
            <p className="text-sm text-muted-foreground">No diagnosis yet.</p>
          )}
          {r.diagnoses.map((d) => {
            const plan = r.plans.find((p) => p.attempt === d.attempt);
            return (
              <article key={d.id} className="space-y-4 rounded-md border bg-card p-5">
                <p className="label-mono">
                  Attempt {d.attempt} · {d.model} · confidence {d.confidence ?? "n/a"}
                </p>
                <div>
                  <h3 className="font-semibold">Root cause</h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{d.rootCause}</p>
                </div>
                {d.affectedFiles.length > 0 && (
                  <div>
                    <h3 className="font-semibold">Affected files</h3>
                    <ul className="mt-1 font-mono text-xs">
                      {d.affectedFiles.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <h3 className="font-semibold">Evidence</h3>
                  <ul className="mt-2 space-y-2">
                    {d.evidence.map((e, i) => (
                      <li key={i} className="border-l-2 border-primary/50 pl-3 text-sm">
                        {e.file && (
                          <p className="font-mono text-xs text-primary">
                            {e.file}
                            {e.line ? `:${e.line}` : ""}
                          </p>
                        )}
                        {e.logExcerpt && (
                          <pre className="my-1 overflow-x-auto rounded-sm bg-terminal p-2 text-[11px]">
                            {e.logExcerpt}
                          </pre>
                        )}
                        <p>{e.reasoning}</p>
                      </li>
                    ))}
                  </ul>
                </div>
                {plan && (
                  <div>
                    <h3 className="font-semibold">Repair plan</h3>
                    <ol className="mt-1 list-decimal pl-5 text-sm">
                      {plan.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                )}
              </article>
            );
          })}
        </TabsContent>

        <TabsContent value="patch" className="space-y-6">
          {r.patches.length === 0 && (
            <p className="text-sm text-muted-foreground">No patch generated.</p>
          )}
          {r.patches.length > 0 && lastDiag && (
            <div className="rounded-md border bg-card p-4 text-sm">
              <p className="label-mono">Why this change</p>
              <p className="mt-1">{lastDiag.rootCause}</p>
              {lastPlan && lastPlan.steps.length > 0 && (
                <ol className="mt-2 list-decimal pl-5 text-muted-foreground">
                  {lastPlan.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {r.patches.map((p) => (
            <article key={p.id} className="space-y-3">
              <p className="label-mono">
                Attempt {p.attempt} · {p.changed.length} changed · {p.created.length} created ·{" "}
                {p.deleted.length} deleted
              </p>
              {p.explanations.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {p.explanations.map((e, i) => (
                    <li key={i}>
                      <span className="font-mono text-xs text-primary">
                        {e.action} {e.path}
                      </span>{" "}
                      — {e.explanation}
                    </li>
                  ))}
                </ul>
              )}
              {p.rejected && p.rejected.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
                  <p className="font-semibold text-warning">Rejected edits (not applied)</p>
                  {p.rejected.map((x, i) => (
                    <p key={i} className="font-mono">
                      {x.path}: {x.reason}
                    </p>
                  ))}
                </div>
              )}
              <SideBySideDiff diff={p.diff} />
            </article>
          ))}
        </TabsContent>

        <TabsContent value="verify" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Real sandbox results. A check that did not run is shown as “not run”, never as passing.
          </p>
          <ProofOfRepair rows={proof} />
        </TabsContent>

        <TabsContent value="preview">
          <PreviewPanel runId={id} hasArtifact={Boolean(zip)} />
        </TabsContent>

        <TabsContent value="report">
          <RepairReport r={r} proof={proof} />
        </TabsContent>

        <TabsContent value="logs" className="space-y-3">
          {logs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {done ? "No logs recorded." : "Waiting for the worker to pick up this run…"}
            </p>
          )}
          {logs.map((l) => (
            <details
              key={l.id}
              className="rounded-md border bg-terminal"
              open={l.exitCode !== null && l.exitCode !== 0}
            >
              <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-2 font-mono text-xs">
                <span className="text-primary">{l.phase}</span>
                {l.command && <span className="break-all">$ {l.command}</span>}
                {l.exitCode !== null && (
                  <span className={l.exitCode === 0 ? "text-success" : "text-destructive"}>
                    exit {l.exitCode}
                  </span>
                )}
                {l.timedOut && <span className="text-destructive">TIMED OUT</span>}
                {l.durationMs !== null && (
                  <span className="text-muted-foreground">{(l.durationMs / 1000).toFixed(1)}s</span>
                )}
                {l.message && !l.command && (
                  <span className="text-muted-foreground">{l.message}</span>
                )}
              </summary>
              {(l.stdout || l.stderr) && (
                <pre className="max-h-96 overflow-auto border-t px-4 py-3 text-[11px] leading-relaxed">
                  {l.stdout}
                  {l.stderr && <span className="text-destructive">{l.stderr}</span>}
                </pre>
              )}
            </details>
          ))}
        </TabsContent>
      </Tabs>

      {done && <AssistPanel runId={id} />}
    </div>
  );
}
