export function DiffView({ diff }: { diff: string }) {
  if (!diff) return <p className="text-sm text-muted-foreground">No changes.</p>;
  return (
    <pre className="max-h-[600px] overflow-auto rounded-md border bg-terminal text-xs leading-5">
      {diff.split("\n").map((l, i) => {
        const cls =
          l.startsWith("+++") ||
          l.startsWith("---") ||
          l.startsWith("Index:") ||
          l.startsWith("====")
            ? "text-muted-foreground font-semibold"
            : l.startsWith("@@")
              ? "text-primary"
              : l.startsWith("+")
                ? "bg-diff-add text-success"
                : l.startsWith("-")
                  ? "bg-diff-del text-destructive"
                  : "";
        return (
          <div key={i} className={`px-4 ${cls}`}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
