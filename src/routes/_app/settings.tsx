import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserProfile } from "@clerk/clerk-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type Status } from "@/lib/api";
import { ApiNotice } from "@/components/rewind/ApiNotice";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings — REWIND" }, { name: "description", content: "Account, AI providers, integrations and limits." }] }),
  component: Settings,
});

function Dot({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-3 border-t py-3 first:border-t-0">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${ok ? "bg-success" : "bg-destructive"}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label} <span className={`font-mono text-[11px] ${ok ? "text-success" : "text-destructive"}`}>{ok ? "CONFIGURED" : "NOT CONFIGURED"}</span></p>
        <p className="break-words text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function Settings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["status"], queryFn: () => api<Status>("/status") });
  const [s, setS] = useState({ maxRetries: 2, timeoutSeconds: 600, vultrModel: "", geminiModel: "", allowInstallNet: true });
  useEffect(() => {
    if (q.data?.settings) setS({ ...q.data.settings, vultrModel: q.data.settings.vultrModel ?? "", geminiModel: q.data.settings.geminiModel ?? "" });
  }, [q.data]);

  async function save() {
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ ...s, vultrModel: s.vultrModel || null, geminiModel: s.geminiModel || null }) });
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["status"] });
    } catch (e) { toast.error((e as Error).message); }
  }
  async function connectGithub() {
    try { const r = await api<{ url: string }>("/github/connect"); window.location.href = r.url; } catch (e) { toast.error((e as Error).message); }
  }
  async function disconnectGithub() {
    await api("/github", { method: "DELETE" }); qc.invalidateQueries({ queryKey: ["status"] });
  }
  const i = q.data?.integrations;

  return (
    <div className="space-y-8">
      <div><p className="label-mono">Configuration</p><h1 className="text-3xl font-bold">Settings</h1></div>
      {q.error && <ApiNotice error={q.error} />}
      {q.data && i && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-md border bg-card p-5">
            <h2 className="label-mono mb-2">Integrations</h2>
            <Dot ok={i.vultr} label="Vultr Serverless Inference (repair agent)" hint={i.vultr ? `${i.vultrBaseUrl} · model ${i.vultrModel}` : "Set VULTR_INFERENCE_API_KEY and VULTR_INFERENCE_MODEL on the server. Required for repair runs."} />
            <Dot ok={i.gemini} label="Google Gemini (optional assistant)" hint={i.gemini ? `model ${i.geminiModel}` : "Set GEMINI_API_KEY to enable explanations."} />
            <Dot ok={q.data.sandbox.ok} label="Isolated sandbox" hint={q.data.sandbox.ok ? `Docker ${JSON.stringify(q.data.sandbox.detail)}` : `Unavailable: ${JSON.stringify(q.data.sandbox.detail)}. Repair runs cannot execute code.`} />
            <Dot ok={i.githubOAuth} label="GitHub OAuth (private repos)" hint={i.githubOAuth ? (q.data.githubConnected ? `Connected as ${q.data.githubLogin}` : "Available — connect below") : "Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ENCRYPTION_KEY."} />
            <Dot ok={i.clerk} label="Clerk backend verification" hint="CLERK_SECRET_KEY on the API server." />
            <Dot ok label={`Storage: ${i.storage}`} hint="local volume or S3-compatible bucket." />
            {i.githubOAuth && (
              <div className="pt-3">
                {q.data.githubConnected ? <Button variant="outline" onClick={disconnectGithub}>Disconnect GitHub</Button> : <Button onClick={connectGithub}>Connect GitHub</Button>}
              </div>
            )}
          </section>

          <section className="space-y-4 rounded-md border bg-card p-5">
            <h2 className="label-mono">Project defaults & limits</h2>
            <div className="space-y-1">
              <Label htmlFor="retries">Max repair retries (server cap {q.data.limits.maxRetries})</Label>
              <Input id="retries" type="number" min={0} max={q.data.limits.maxRetries} value={s.maxRetries} onChange={(e) => setS({ ...s, maxRetries: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="timeout">Command timeout seconds (server cap {q.data.limits.sandboxTimeout})</Label>
              <Input id="timeout" type="number" min={30} max={3600} value={s.timeoutSeconds} onChange={(e) => setS({ ...s, timeoutSeconds: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gm">Gemini model override</Label>
              <Input id="gm" placeholder={i.geminiModel} value={s.geminiModel} onChange={(e) => setS({ ...s, geminiModel: e.target.value })} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="net">Allow network during dependency install</Label>
              <Switch id="net" checked={s.allowInstallNet} onCheckedChange={(v) => setS({ ...s, allowInstallNet: v })} />
            </div>
            <p className="text-xs text-muted-foreground">Build and test commands always run with networking disabled. Max upload {q.data.limits.maxUploadMb}MB · {q.data.limits.concurrency} concurrent runs.</p>
            <Button onClick={save}>Save</Button>
          </section>
        </div>
      )}
      <section>
        <h2 className="label-mono mb-3">Account</h2>
        <UserProfile routing="hash" />
      </section>
    </div>
  );
}
