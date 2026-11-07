import { cn } from "@/lib/utils";
import type { Outcome, RunStatus } from "@/lib/api";

const OUTCOME: Record<NonNullable<Outcome>, { label: string; cls: string }> = {
  verified: { label: "Verified", cls: "bg-success/15 text-success border-success/40" },
  unverified: { label: "Unverified", cls: "bg-warning/15 text-warning border-warning/40" },
  failed: { label: "Failed", cls: "bg-destructive/15 text-destructive border-destructive/40" },
  not_reproduced: {
    label: "Could not reproduce",
    cls: "bg-secondary text-muted-foreground border-border",
  },
  cancelled: { label: "Cancelled", cls: "bg-secondary text-muted-foreground border-border" },
};

export function StatusBadge({
  status,
  outcome,
  className,
}: {
  status: RunStatus;
  outcome?: Outcome;
  className?: string;
}) {
  const o = outcome ? OUTCOME[outcome] : null;
  const running = !o && !["failed", "cancelled"].includes(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider",
        o?.cls ??
          (status === "failed"
            ? OUTCOME.failed.cls
            : running
              ? "bg-accent text-accent-foreground border-primary/40"
              : OUTCOME.cancelled.cls),
        className,
      )}
    >
      {running && <span className="size-1.5 rounded-full bg-primary animate-blink" aria-hidden />}
      {o?.label ?? status.replace(/_/g, " ")}
    </span>
  );
}
