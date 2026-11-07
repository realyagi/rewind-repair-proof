import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

/** Optional Gemini assistant. Answers only from the project's/run's real data. */
export function AssistPanel({ projectId, runId }: { projectId?: string; runId?: string }) {
  const [q, setQ] = useState("");
  const [a, setA] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setA(null);
    try {
      const r = await api<{ answer: string; model: string }>("/assist", {
        method: "POST",
        body: JSON.stringify({
          question: q,
          ...(projectId ? { projectId } : {}),
          ...(runId ? { runId } : {}),
        }),
      });
      setA(`${r.answer}\n\n— ${r.model}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-md border bg-card p-5">
      <h2 className="label-mono mb-1">
        Ask about this {runId ? "run" : "project"} · Gemini (optional)
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Explanations only. Repairs always use Vultr Serverless Inference.
      </p>
      <form onSubmit={ask} className="space-y-2">
        <Textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={runId ? "Explain this diff in plain language" : "What does this project do?"}
          maxLength={4000}
        />
        <Button type="submit" variant="outline" disabled={!q || busy}>
          {busy ? "Thinking…" : "Ask"}
        </Button>
      </form>
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
      {a && <p className="mt-3 whitespace-pre-wrap text-sm">{a}</p>}
    </section>
  );
}
