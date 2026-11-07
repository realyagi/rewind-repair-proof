import type { RunDetail } from "@/lib/api";
import type { ProofRow } from "@/lib/run-insights";
import { remainingRisks } from "@/lib/run-insights";
import { parseUnifiedDiff } from "@/lib/diff";
import { StatusBadge } from "./StatusBadge";

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2 border-t py-4 md:grid-cols-[180px_1fr]">
      <h3 className="label-mono">
        {n} · {title}
      </h3>
      <div className="min-w-0 text-sm">{children}</div>
    </section>
  );
}

export function RepairReport({ r, proof }: { r: RunDetail; proof: ProofRow[] }) {
  const d = r.diagnoses[r.diagnoses.length - 1];
  const plan = r.plans[r.plans.length - 1];
  const files = new Map<string, { additions: number; deletions: number; status: string }>();
  for (const p of r.patches)
    for (const f of parseUnifiedDiff(p.diff)) {
      const cur = files.get(f.path);
      files.set(f.path, {
        additions: (cur?.additions ?? 0) + f.additions,
        deletions: (cur?.deletions ?? 0) + f.deletions,
        status: cur?.status ?? f.status,
      });
    }
  const risks = remainingRisks(r);
  return (
    <article className="rounded-md border bg-card px-5 pb-2 pt-5" aria-label="Repair report">
      <header className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div>
          <p className="label-mono">Repair report</p>
          <h2 className="mt-1 text-xl font-bold">{r.project.name}</h2>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            run {r.id} · {r.attempt} attempt(s) of {r.maxRetries + 1} ·{" "}
            {new Date(r.createdAt).toLocaleString()}
            {r.finishedAt && ` → ${new Date(r.finishedAt).toLocaleString()}`}
          </p>
        </div>
        <StatusBadge status={r.status} outcome={r.outcome} />
      </header>
      <Section n="01" title="Final status">
        <p>{r.summary ?? "Run has not finished."}</p>
      </Section>
      <Section n="02" title="Root cause">
        {d ? (
          <>
            <p className="whitespace-pre-wrap">{d.rootCause}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {d.model} · confidence {d.confidence ?? "n/a"}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">No diagnosis recorded.</p>
        )}
      </Section>
      <Section n="03" title="Evidence">
        {d?.evidence.length ? (
          <ul className="space-y-2">
            {d.evidence.map((e, i) => (
              <li key={i} className="border-l-2 border-primary/50 pl-3">
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
        ) : (
          <p className="text-muted-foreground">No evidence recorded.</p>
        )}
      </Section>
      <Section n="04" title="Repair plan">
        {plan?.steps.length ? (
          <ol className="list-decimal pl-5">
            {plan.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">No plan recorded.</p>
        )}
      </Section>
      <Section n="05" title="Files changed">
        {files.size ? (
          <ul className="font-mono text-xs">
            {[...files].map(([p, f]) => (
              <li key={p} className="flex gap-3 py-0.5">
                <span className="w-16 text-muted-foreground">{f.status}</span>
                <span className="min-w-0 flex-1 truncate">{p}</span>
                <span className="text-success">+{f.additions}</span>
                <span className="text-destructive">−{f.deletions}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No files changed.</p>
        )}
        {r.patches.flatMap((p) => p.explanations).length > 0 && (
          <ul className="mt-3 space-y-1">
            {r.patches.flatMap((p) =>
              p.explanations.map((e, i) => (
                <li key={`${p.id}-${i}`}>
                  <span className="font-mono text-xs text-primary">{e.path}</span> — {e.explanation}
                </li>
              )),
            )}
          </ul>
        )}
      </Section>
      <Section n="06" title="Verification">
        {proof.length ? (
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-normal">check</th>
                <th className="font-normal">before</th>
                <th className="font-normal">after</th>
              </tr>
            </thead>
            <tbody>
              {proof.map((p) => (
                <tr key={p.phase} className="border-t">
                  <td className="py-1">{p.phase}</td>
                  <td
                    className={
                      p.before
                        ? p.before.passed
                          ? "text-success"
                          : "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {p.before
                      ? `${p.before.passed ? "PASS" : "FAIL"} (${p.before.timedOut ? "timeout" : `exit ${p.before.exitCode}`})`
                      : "not run"}
                  </td>
                  <td
                    className={
                      p.after
                        ? p.after.passed
                          ? "text-success"
                          : "text-destructive"
                        : "text-muted-foreground"
                    }
                  >
                    {p.after
                      ? `${p.after.passed ? "PASS" : "FAIL"} (${p.after.timedOut ? "timeout" : `exit ${p.after.exitCode}`})`
                      : "not run"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground">No verification results.</p>
        )}
      </Section>
      <Section n="07" title="Remaining risks">
        {risks.length ? (
          <ul className="list-disc pl-5">
            {risks.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">None detected from the recorded results.</p>
        )}
      </Section>
    </article>
  );
}
