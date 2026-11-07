import type { ProofRow, CheckResult, Change } from "@/lib/run-insights";
import { cn } from "@/lib/utils";

const CHANGE: Record<Change, { label: string; cls: string }> = {
  fixed: { label: "Fixed", cls: "text-success" },
  passing: { label: "Passing", cls: "text-success" },
  still_failing: { label: "Still failing", cls: "text-destructive" },
  regressed: { label: "Regressed", cls: "text-destructive" },
  not_run: { label: "Not run", cls: "text-muted-foreground" },
};

function Check({ c, label }: { c: CheckResult; label: string }) {
  if (!c)
    return (
      <div className="p-3">
        <p className="label-mono">{label}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">not run</p>
      </div>
    );
  return (
    <div className="min-w-0 p-3">
      <p className="label-mono">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-sm font-semibold",
          c.passed ? "text-success" : "text-destructive",
        )}
      >
        {c.passed ? "PASS" : "FAIL"}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {c.timedOut ? "timed out" : `exit ${c.exitCode}`}
          {c.durationMs != null && ` · ${(c.durationMs / 1000).toFixed(1)}s`}
        </span>
      </p>
      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={c.command}>
        $ {c.command}
      </p>
      {c.log && (c.log.stdout || c.log.stderr) && (
        <details className="mt-2">
          <summary className="cursor-pointer font-mono text-[11px] text-primary">output</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded-sm border bg-terminal p-2 text-[11px] leading-relaxed">
            {c.log.stdout}
            {c.log.stderr && <span className="text-destructive">{c.log.stderr}</span>}
          </pre>
        </details>
      )}
    </div>
  );
}

export function ProofOfRepair({ rows }: { rows: ProofRow[] }) {
  if (!rows.length)
    return (
      <p className="text-sm text-muted-foreground">
        No build or test results recorded for this run.
      </p>
    );
  return (
    <div className="overflow-hidden rounded-md border">
      {rows.map((r) => (
        <div
          key={r.phase}
          className="grid border-b bg-card last:border-b-0 md:grid-cols-[120px_1fr_1fr]"
        >
          <div className="flex items-center justify-between gap-2 border-b p-3 md:block md:border-b-0 md:border-r">
            <p className="font-mono text-sm font-semibold">{r.phase}</p>
            <p
              className={cn(
                "font-mono text-[11px] uppercase tracking-wider md:mt-1",
                CHANGE[r.change].cls,
              )}
            >
              {CHANGE[r.change].label}
            </p>
          </div>
          <div className="border-b md:border-b-0 md:border-r">
            <Check c={r.before} label="Before (baseline)" />
          </div>
          <Check c={r.after} label="After (final attempt)" />
        </div>
      ))}
    </div>
  );
}
