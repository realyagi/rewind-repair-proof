import type { TimelineEvent, EventStatus } from "@/lib/run-insights";
import { cn } from "@/lib/utils";

const DOT: Record<EventStatus, string> = {
  done: "bg-success border-success",
  failed: "bg-destructive border-destructive",
  running: "bg-primary border-primary animate-blink",
  pending: "bg-background border-border",
  skipped: "bg-background border-muted-foreground",
  cancelled: "bg-muted-foreground border-muted-foreground",
};
const LABEL: Record<EventStatus, string> = {
  done: "done",
  failed: "failed",
  running: "running",
  pending: "pending",
  skipped: "skipped",
  cancelled: "cancelled",
};
const TXT: Record<EventStatus, string> = {
  done: "text-success",
  failed: "text-destructive",
  running: "text-primary",
  pending: "text-muted-foreground",
  skipped: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="relative space-y-0" aria-label="Investigation timeline">
      {events.map((e, i) => (
        <li key={e.key} className="relative grid grid-cols-[20px_1fr] gap-3 pb-5 last:pb-0">
          {i < events.length - 1 && (
            <span className="absolute left-[9px] top-4 h-full w-px bg-border" aria-hidden />
          )}
          <span
            className={cn(
              "relative mt-1 size-[11px] justify-self-center rounded-full border-2",
              DOT[e.status],
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <p
                className={cn(
                  "text-sm font-semibold",
                  e.status === "pending" || e.status === "skipped" ? "text-muted-foreground" : "",
                )}
              >
                {e.title}
              </p>
              <span className={cn("font-mono text-[10px] uppercase tracking-wider", TXT[e.status])}>
                {LABEL[e.status]}
              </span>
              {e.at && (
                <time
                  className="ml-auto font-mono text-[11px] text-muted-foreground"
                  dateTime={e.at}
                >
                  {new Date(e.at).toLocaleString()}
                </time>
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{e.detail}</p>
            {e.evidence && (
              <pre className="mt-1.5 overflow-x-auto rounded-sm border bg-terminal px-3 py-1.5 font-mono text-[11px]">
                {e.evidence}
              </pre>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
