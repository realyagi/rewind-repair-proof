import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, type PreviewSession, type RunPreviewInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

const urlKey = (id: string) => `rewind-preview-url:${id}`;
const ACTIVE = ["starting", "ready"];
const STATE_TEXT: Record<string, string> = {
  starting:
    "Starting — installing, building and booting the repaired project in an isolated container.",
  ready: "Running in an isolated container with no access to REWIND's network or secrets.",
  stopped: "Preview stopped. The container was removed.",
  failed: "Preview failed. The container was removed — see the startup logs below.",
  expired: "Preview expired after its maximum lifetime. The container was removed.",
};

export function PreviewPanel({ runId, hasArtifact }: { runId: string; hasArtifact: boolean }) {
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ["preview-info", runId],
    queryFn: () => api<RunPreviewInfo>(`/runs/${runId}/preview`),
    enabled: hasArtifact,
  });
  const sessionId = info.data?.session?.id ?? null;
  const status = useQuery({
    queryKey: ["preview", sessionId],
    queryFn: () => api<PreviewSession>(`/previews/${sessionId}`),
    enabled: Boolean(sessionId),
    initialData: info.data?.session ?? undefined,
    refetchInterval: (q) =>
      q.state.data?.status === "starting" ? 2000 : q.state.data?.status === "ready" ? 10000 : false,
  });
  const s = status.data;
  const [url, setUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [frameKey, setFrameKey] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUrl(sessionId ? sessionStorage.getItem(urlKey(sessionId)) : null);
  }, [sessionId]);
  // Session is ready but this tab has no access URL (e.g. after reload): issue a fresh short-lived one.
  useEffect(() => {
    if (s?.status !== "ready" || url || !sessionId) return;
    api<{ url: string }>(`/previews/${sessionId}/access`, { method: "POST" })
      .then((r) => {
        sessionStorage.setItem(urlKey(sessionId), r.url);
        setUrl(r.url);
      })
      .catch((e) => toast.error((e as Error).message));
  }, [s?.status, url, sessionId]);

  async function start() {
    setBusy(true);
    try {
      const r = await api<{ id: string; url: string }>(`/runs/${runId}/preview`, {
        method: "POST",
      });
      sessionStorage.setItem(urlKey(r.id), r.url);
      await qc.invalidateQueries({ queryKey: ["preview-info", runId] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await api(`/previews/${sessionId}/stop`, { method: "POST" });
      sessionStorage.removeItem(urlKey(sessionId));
      setUrl(null);
      await qc.invalidateQueries({ queryKey: ["preview", sessionId] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!hasArtifact)
    return (
      <Notice title="No repaired artifact">
        Live Preview becomes available once this run produces a repaired project ZIP.
      </Notice>
    );
  if (info.error)
    return (
      <Notice title="Preview unavailable" tone="error">
        {(info.error as Error).message}
      </Notice>
    );
  if (!info.data) return <p className="label-mono">Checking preview support…</p>;
  const { plan, available, unavailableReason } = info.data;
  if (!plan.supported)
    return (
      <Notice title={`Unsupported project${plan.framework ? ` (${plan.framework})` : ""}`}>
        {plan.reason}
      </Notice>
    );
  if (!available)
    return (
      <Notice title="Live Preview is not configured on this server" tone="warn">
        {unavailableReason}
      </Notice>
    );

  const active = s && ACTIVE.includes(s.status);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3">
        <div className="min-w-0">
          <p className="font-mono text-xs">
            <span className="text-muted-foreground">framework</span> {plan.framework}{" "}
            <span className="ml-2 text-muted-foreground">state</span>{" "}
            <span
              className={cn(
                s?.status === "ready"
                  ? "text-success"
                  : s?.status === "failed"
                    ? "text-destructive"
                    : s?.status === "starting"
                      ? "text-primary"
                      : "text-muted-foreground",
              )}
            >
              {s?.status ?? "not started"}
              {s?.status === "starting" && <span className="animate-blink">_</span>}
            </span>
          </p>
          {s && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {STATE_TEXT[s.status]}
              {active && ` Expires ${new Date(s.expiresAt).toLocaleTimeString()}.`}
            </p>
          )}
          {s?.error && <p className="mt-0.5 font-mono text-xs text-destructive">{s.error}</p>}
          {s?.warning && <p className="mt-0.5 font-mono text-xs text-warning">{s.warning}</p>}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {s?.status === "ready" && (
            <>
              <div
                className="inline-flex rounded-sm border text-xs"
                role="group"
                aria-label="Viewport"
              >
                {(["desktop", "mobile"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={viewport === v}
                    onClick={() => setViewport(v)}
                    className={cn(
                      "px-2.5 py-1 font-mono",
                      viewport === v
                        ? "bg-secondary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFrameKey((k) => k + 1)}
                disabled={!url}
              >
                Refresh
              </Button>
              {url && (
                <Button size="sm" variant="outline" asChild>
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    Open in new tab
                  </a>
                </Button>
              )}
            </>
          )}
          {active ? (
            <Button size="sm" variant="destructive" onClick={stop} disabled={busy}>
              Stop preview
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={busy}>
              {busy ? "Starting…" : s ? "Start new preview" : "Start preview"}
            </Button>
          )}
        </div>
      </div>

      {plan.notes.length > 0 && !s && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {s?.status === "ready" && url && (
        <div
          className={cn(
            "mx-auto overflow-hidden rounded-md border bg-background",
            viewport === "mobile" ? "w-[390px] max-w-full" : "w-full",
          )}
        >
          <div className="flex items-center gap-2 border-b bg-card px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" aria-hidden /> isolated preview ·{" "}
            {viewport}
          </div>
          <iframe
            key={frameKey}
            src={url}
            title="Live preview of the repaired application"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
            referrerPolicy="no-referrer"
            className={cn(
              "block w-full bg-background",
              viewport === "mobile" ? "h-[780px]" : "h-[720px]",
            )}
          />
        </div>
      )}

      {s && (s.logs?.length ?? 0) > 0 && (
        <details open={s.status !== "ready"} className="rounded-md border bg-terminal">
          <summary className="cursor-pointer px-4 py-2 font-mono text-xs">
            startup logs ({s.logs!.length} lines)
          </summary>
          <pre className="max-h-80 overflow-auto border-t px-4 py-3 text-[11px] leading-relaxed">
            {s.logs!.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

function Notice({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "warn" | "error";
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-4 text-sm",
        tone === "error"
          ? "border-destructive/40 bg-destructive/10"
          : tone === "warn"
            ? "border-warning/40 bg-warning/10"
            : "bg-card",
      )}
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-muted-foreground">{children}</p>
    </div>
  );
}
