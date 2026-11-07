import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export const Route = createFileRoute("/_app/inspect")({
  head: () => ({ meta: [{ title: "Website Inspection — REWIND" }, { name: "description", content: "Inspect publicly delivered HTML and headers of a website." }] }),
  component: Inspect,
});

type Result = Record<string, unknown> & { headers: Record<string, string | null>; scripts: string[]; stylesheets: string[]; mixedContent: string[]; redirects: string[] };

function Inspect() {
  const [url, setUrl] = useState("");
  const [r, setR] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setR(null);
    try { setR(await api<Result>("/website-inspect", { method: "POST", body: JSON.stringify({ url }) })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-6">
      <div>
        <p className="label-mono">Optional</p>
        <h1 className="text-3xl font-bold">Website Inspection</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Inspects only what a browser publicly receives: HTML, headers and referenced assets. It does <strong>not</strong> recover private or original source code, and REWIND cannot repair a site's source unless you import the actual project.</p>
      </div>
      <form onSubmit={go} className="flex max-w-2xl gap-2">
        <Input type="url" required placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button type="submit" disabled={busy}>{busy ? "Inspecting…" : "Inspect"}</Button>
      </form>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      {r && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-md border bg-card p-4 text-sm">
            <h2 className="label-mono mb-2">Page</h2>
            {(["finalUrl", "status", "responseMs", "title", "metaDescription", "lang", "hasViewport", "sizeBytes", "images", "imagesMissingAlt", "inlineScripts"] as const).map((k) => (
              <p key={k} className="grid grid-cols-[140px_1fr] gap-2 py-0.5"><span className="font-mono text-xs text-muted-foreground">{k}</span><span className="break-all">{String(r[k] ?? "—")}</span></p>
            ))}
          </section>
          <section className="rounded-md border bg-card p-4 text-sm">
            <h2 className="label-mono mb-2">Security headers</h2>
            {Object.entries(r.headers).map(([k, v]) => (
              <p key={k} className="grid grid-cols-[180px_1fr] gap-2 py-0.5"><span className="font-mono text-xs text-muted-foreground">{k}</span><span className={`break-all ${v ? "" : "text-warning"}`}>{v ?? "missing"}</span></p>
            ))}
          </section>
          <section className="rounded-md border bg-card p-4 text-sm md:col-span-2">
            <h2 className="label-mono mb-2">Assets</h2>
            <p className="font-mono text-xs text-muted-foreground">Redirect chain: {r.redirects.join(" → ")}</p>
            {r.mixedContent.length > 0 && <p className="mt-2 text-warning">Mixed content: {r.mixedContent.join(", ")}</p>}
            <ul className="mt-2 max-h-64 overflow-auto font-mono text-xs">{[...r.scripts, ...r.stylesheets].map((s) => <li key={s} className="break-all">{s}</li>)}</ul>
            <p className="mt-3 text-xs text-muted-foreground">{String(r["note"])}</p>
          </section>
        </div>
      )}
    </div>
  );
}
