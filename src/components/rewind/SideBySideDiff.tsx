import { useMemo, useState } from "react";
import { parseUnifiedDiff, type Cell } from "@/lib/diff";
import { DiffView } from "./DiffView";
import { cn } from "@/lib/utils";

function CellView({ c, side, modified }: { c: Cell; side: "l" | "r"; modified: boolean }) {
  const bg =
    c.type === "del"
      ? "bg-diff-del"
      : c.type === "add"
        ? "bg-diff-add"
        : c.type === "empty"
          ? "bg-muted/30"
          : "";
  const sign = c.type === "del" ? "-" : c.type === "add" ? "+" : " ";
  return (
    <>
      <span
        className={cn(
          "select-none border-r px-2 text-right text-muted-foreground",
          bg,
          side === "r" && "border-l",
        )}
      >
        {c.no ?? ""}
      </span>
      <span
        className={cn(
          "whitespace-pre px-2",
          bg,
          c.type === "del" && "text-destructive",
          c.type === "add" && "text-success",
        )}
      >
        <span className="select-none opacity-60">{c.type === "empty" ? " " : sign}</span>
        {c.text}
        {modified && c.type !== "empty" && <span className="sr-only"> (modified)</span>}
      </span>
    </>
  );
}

export function SideBySideDiff({ diff }: { diff: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [mode, setMode] = useState<"split" | "unified">("split");
  if (!diff) return <p className="text-sm text-muted-foreground">No changes.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="label-mono">
          {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
          <span className="text-success">+{files.reduce((n, f) => n + f.additions, 0)}</span>{" "}
          <span className="text-destructive">−{files.reduce((n, f) => n + f.deletions, 0)}</span>
        </p>
        <div
          className="ml-auto inline-flex rounded-sm border text-xs"
          role="group"
          aria-label="Diff layout"
        >
          {(["split", "unified"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={cn(
                "px-2.5 py-1 font-mono",
                mode === m
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode === "unified" ? (
        <DiffView diff={diff} />
      ) : (
        files.map((f) => (
          <section key={f.path} className="overflow-hidden rounded-md border">
            <header className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 font-mono text-xs">
              <span
                className={cn(
                  "rounded-sm border px-1.5 text-[10px] uppercase",
                  f.status === "added"
                    ? "border-success/40 text-success"
                    : f.status === "deleted"
                      ? "border-destructive/40 text-destructive"
                      : "text-muted-foreground",
                )}
              >
                {f.status}
              </span>
              <span className="truncate font-semibold">{f.path}</span>
              <span className="ml-auto text-success">+{f.additions}</span>
              <span className="text-destructive">−{f.deletions}</span>
            </header>
            <div className="grid grid-cols-2 border-b bg-secondary/40 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <span className="px-3 py-1">Before</span>
              <span className="border-l px-3 py-1">After</span>
            </div>
            <div className="max-h-[560px] overflow-auto bg-terminal">
              <div className="grid min-w-max grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] font-mono text-xs leading-5">
                {f.rows.map((r, i) =>
                  r.kind === "hunk" ? (
                    <div key={i} className="col-span-4 border-y bg-accent/40 px-3 text-primary">
                      {r.header}
                    </div>
                  ) : (
                    <div key={i} className="contents">
                      <CellView c={r.left} side="l" modified={r.modified} />
                      <CellView c={r.right} side="r" modified={r.modified} />
                    </div>
                  ),
                )}
              </div>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
