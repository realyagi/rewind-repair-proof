import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type Status } from "@/lib/api";
import { ApiNotice } from "@/components/rewind/ApiNotice";

export const Route = createFileRoute("/_app/projects/new")({
  head: () => ({ meta: [{ title: "Import project — REWIND" }, { name: "description", content: "Import a ZIP archive or GitHub repository." }] }),
  component: NewProject,
});

function NewProject() {
  const nav = useNavigate();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api<Status>("/status") });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const maxMb = status.data?.limits.maxUploadMb ?? 100;

  async function submitZip(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) return setError("Choose a .zip file");
    if (!file.name.toLowerCase().endsWith(".zip")) return setError("Only .zip files are accepted");
    if (file.size > maxMb * 1024 * 1024) return setError(`File exceeds ${maxMb}MB`);
    const fd = new FormData();
    fd.append("name", name || file.name.replace(/\.zip$/i, ""));
    fd.append("file", file);
    setBusy("Uploading, extracting safely and inspecting…");
    try {
      const r = await api<{ id: string }>("/projects/zip", { method: "POST", body: fd });
      toast.success("Project imported");
      nav({ to: "/projects/$id", params: { id: r.id } });
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function loadBranches() {
    setError(null);
    setBusy("Reading repository…");
    try {
      const r = await api<{ default: string; branches: string[] }>(`/github/branches?url=${encodeURIComponent(url)}`);
      setBranches(r.branches);
      setBranch(r.default);
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function submitGithub(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("Cloning into an isolated workspace and inspecting…");
    try {
      const r = await api<{ id: string }>("/projects/github", { method: "POST", body: JSON.stringify({ url, branch, ...(name ? { name } : {}) }) });
      toast.success("Repository imported");
      nav({ to: "/projects/$id", params: { id: r.id } });
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<{ fullName: string; url: string; private: boolean }[]>("/github/repos"), enabled: Boolean(status.data?.githubConnected) });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="label-mono">New project</p>
        <h1 className="text-3xl font-bold">Import source code</h1>
        <p className="mt-2 text-sm text-muted-foreground">Imported code is never executed during import. It is only inspected statically.</p>
      </div>
      {status.error && <ApiNotice error={status.error} />}
      <div className="space-y-2">
        <Label htmlFor="name">Project name (optional)</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </div>
      <Tabs defaultValue="zip">
        <TabsList><TabsTrigger value="zip">ZIP upload</TabsTrigger><TabsTrigger value="github">GitHub</TabsTrigger></TabsList>
        <TabsContent value="zip">
          <form onSubmit={submitZip} className="space-y-4 rounded-md border bg-card p-5">
            <Label htmlFor="zip">ZIP archive (max {maxMb}MB)</Label>
            <Input id="zip" type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button type="submit" disabled={!!busy}>Import ZIP</Button>
          </form>
        </TabsContent>
        <TabsContent value="github">
          <form onSubmit={submitGithub} className="space-y-4 rounded-md border bg-card p-5">
            {repos.data && repos.data.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="repo">Your repositories</Label>
                <select id="repo" className="w-full rounded-md border bg-background p-2 text-sm" onChange={(e) => { setUrl(e.target.value); setBranches([]); }} defaultValue="">
                  <option value="" disabled>Select a repository…</option>
                  {repos.data.map((r) => <option key={r.url} value={r.url}>{r.fullName}{r.private ? " (private)" : ""}</option>)}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="url">Repository URL</Label>
              <div className="flex gap-2">
                <Input id="url" placeholder="https://github.com/owner/repo" value={url} onChange={(e) => { setUrl(e.target.value); setBranches([]); }} />
                <Button type="button" variant="outline" onClick={loadBranches} disabled={!url || !!busy}>Branches</Button>
              </div>
              {!status.data?.githubConnected && <p className="text-xs text-muted-foreground">Public repos work without login. Connect GitHub in Settings for private repos.</p>}
            </div>
            {branches.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="branch">Branch</Label>
                <select id="branch" className="w-full rounded-md border bg-background p-2 text-sm" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {branches.map((b) => <option key={b}>{b}</option>)}
                </select>
              </div>
            )}
            <Button type="submit" disabled={!branch || !!busy}>Import repository</Button>
            <p className="text-xs text-muted-foreground">REWIND never pushes to your repository. Repairs happen on a separate copy.</p>
          </form>
        </TabsContent>
      </Tabs>
      {busy && <p className="font-mono text-sm text-primary" role="status">{busy}</p>}
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
