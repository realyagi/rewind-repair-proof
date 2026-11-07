import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Project } from "@/lib/api";
import { StatusBadge } from "@/components/rewind/StatusBadge";
import { ApiNotice } from "@/components/rewind/ApiNotice";
import { AssistPanel } from "@/components/rewind/AssistPanel";

export const Route = createFileRoute("/_app/projects/$id")({
  head: () => ({ meta: [{ title: "Project — REWIND" }, { name: "description", content: "Project inspection, configuration and repair runs." }] }),
  component: ProjectPage,
});

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 text-sm">
      <span className="label-mono pt-0.5">{k}</span>
      <span className="min-w-0 break-words">{v || <span className="text-muted-foreground">none detected</span>}</span>
    </div>
  );
}

function ProjectPage() {
  const { id } = Route.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["project", id], queryFn: () => api<Project>(`/projects/${id}`) });
  const files = useQuery({ queryKey: ["files", id], queryFn: () => api<{ files: { path: string; size: number }[] }>(`/projects/${id}/files`) });
  const [open, setOpen] = useState<string | null>(null);
  const file = useQuery({ queryKey: ["file", id, open], queryFn: () => api<{ content: string | null; binary: boolean }>(`/projects/${id}/files?path=${encodeURIComponent(open!)}`), enabled: !!open });
  const [cfg, setCfg] = useState({ installCommand: "", buildCommand: "", testCommand: "", sandboxImage: "" });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (q.data) setCfg({ installCommand: q.data.installCommand ?? "", buildCommand: q.data.buildCommand ?? "", testCommand: q.data.testCommand ?? "", sandboxImage: q.data.sandboxImage ?? "" });
  }, [q.data]);

  if (q.error) return <ApiNotice error={q.error} />;
  if (!q.data) return <p className="label-mono">Loading…</p>;
  const p = q.data;
  const ins = p.inspection;
  const ready = p.imports[0]?.status === "ready";

  async function save() {
    try {
      const n = (s: string) => s.trim() || null;
      await api(`/projects/${id}`, { method: "PUT", body: JSON.stringify({ installCommand: n(cfg.installCommand), buildCommand: n(cfg.buildCommand), testCommand: n(cfg.testCommand), sandboxImage: n(cfg.sandboxImage) }) });
      toast.success("Configuration saved");
      qc.invalidateQueries({ queryKey: ["project", id] });
    } catch (e) { toast.error((e as Error).message); }
  }
  async function start() {
    setStarting(true);
    try {
      await save();
      const r = await api<{ id: string }>(`/projects/${id}/runs`, { method: "POST" });
      nav({ to: "/runs/$id", params: { id: r.id } });
    } catch (e) { toast.error((e as Error).message); } finally { setStarting(false); }
  }
  async function remove() {
    if (!confirm("Delete this project and all its runs?")) return;
    await api(`/projects/${id}`, { method: "DELETE" });
    nav({ to: "/dashboard" });
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-mono">{p.source === "github" && p.repository ? `github · ${p.repository.owner}/${p.repository.repo}@${p.repository.branch} · ${p.repository.commitSha?.slice(0, 7)}` : "zip upload"}</p>
          <h1 className="text-3xl font-bold">{p.name}</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={remove}>Delete</Button>
          <Button onClick={start} disabled={!ready || starting} className="shadow-glow">{starting ? "Starting…" : "Start repair run"}</Button>
        </div>
      </div>
      {p.imports[0]?.status === "failed" && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">Import failed: {p.imports[0].error}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-md border bg-card p-5">
          <h2 className="label-mono mb-3">Inspection report</h2>
          {ins ? (
            <div className="divide-y">
              <Row k="Languages" v={ins.languages.map((l) => `${l.name} (${l.files})`).join(", ")} />
              <Row k="Frameworks" v={ins.frameworks.join(", ")} />
              <Row k="Pkg managers" v={ins.packageManagers.join(", ")} />
              <Row k="Manifests" v={ins.manifests.join(", ")} />
              <Row k="Build config" v={ins.buildConfig.join(", ")} />
              <Row k="Test config" v={ins.testConfig.join(", ")} />
              <Row k="Entry points" v={ins.entryPoints.join(", ")} />
              <Row k="Test files" v={ins.testFiles.length ? `${ins.testFiles.length} found` : ""} />
              <Row k="Scripts" v={Object.keys(ins.scripts).length ? <code className="text-xs">{Object.entries(ins.scripts).map(([k, v]) => `${k}: ${v}`).join("\n")}</code> : ""} />
              <Row k="Files" v={String(ins.fileCount)} />
              {ins.uncertainties.length > 0 && <Row k="Uncertain" v={<ul className="list-disc pl-4 text-warning">{ins.uncertainties.map((u) => <li key={u}>{u}</li>)}</ul>} />}
            </div>
          ) : <p className="text-sm text-muted-foreground">No inspection available.</p>}
        </section>

        <section className="space-y-4 rounded-md border bg-card p-5">
          <h2 className="label-mono">Build & test configuration</h2>
          <p className="text-xs text-muted-foreground">Auto-detected values are pre-filled. Edit if detection is wrong. Commands run only inside the sandbox.</p>
          {([["sandboxImage", "Sandbox image", "node:22-bookworm"], ["installCommand", "Install", "npm ci"], ["buildCommand", "Build", "npm run build"], ["testCommand", "Test", "npm test"]] as const).map(([k, l, ph]) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={k}>{l}</Label>
              <Input id={k} className="font-mono text-xs" placeholder={ph} value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} maxLength={500} />
            </div>
          ))}
          <Button variant="outline" onClick={save}>Save configuration</Button>
        </section>
      </div>

      <section>
        <h2 className="label-mono mb-3">Repair runs</h2>
        <div className="divide-y rounded-md border bg-card">
          {!p.runs?.length && <p className="p-4 text-sm text-muted-foreground">No runs yet.</p>}
          {p.runs?.map((r) => (
            <Link key={r.id} to="/runs/$id" params={{ id: r.id }} className="flex flex-wrap items-center gap-3 p-3 hover:bg-secondary">
              <StatusBadge status={r.status} outcome={r.outcome} />
              <span className="truncate text-sm text-muted-foreground">{r.summary ?? "—"}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="max-h-[420px] overflow-auto rounded-md border bg-card p-2">
          <h2 className="label-mono p-2">Source files</h2>
          {files.data?.files.map((f) => (
            <button key={f.path} onClick={() => setOpen(f.path)} className={`block w-full truncate rounded-sm px-2 py-1 text-left font-mono text-xs hover:bg-secondary ${open === f.path ? "bg-secondary text-primary" : ""}`}>{f.path}</button>
          ))}
        </div>
        <pre className="max-h-[420px] overflow-auto rounded-md border bg-terminal p-4 text-xs">
          {!open ? "Select a file to view its contents." : file.isLoading ? "Loading…" : file.data?.binary ? "(binary file)" : file.data?.content ?? (file.error as Error)?.message}
        </pre>
      </section>

      <AssistPanel projectId={id} />
    </div>
  );
}
