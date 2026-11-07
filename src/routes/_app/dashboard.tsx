import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { api, type Project, type RunSummary } from "@/lib/api";
import { StatusBadge } from "@/components/rewind/StatusBadge";
import { ApiNotice } from "@/components/rewind/ApiNotice";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — REWIND" },
      { name: "description", content: "Your projects and repair runs." },
    ],
  }),
  component: Dashboard,
});

type Data = {
  projects: Project[];
  runs: RunSummary[];
  counts: { outcome: string | null; _count: number }[];
  total?: number;
};

function Dashboard() {
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Data>("/dashboard"),
    refetchInterval: 5000,
  });
  const count = (o: string | null) => q.data?.counts.find((c) => c.outcome === o)?._count ?? 0;
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-mono">Workspace</p>
          <h1 className="text-3xl font-bold">Dashboard</h1>
        </div>
        <Button asChild>
          <Link to="/projects/new">New project</Link>
        </Button>
      </div>
      {q.error && <ApiNotice error={q.error} />}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-5">
        {[
          [
            "Total runs",
            q.data?.total ?? q.data?.counts.reduce((n, c) => n + c._count, 0) ?? 0,
            "",
          ],
          ["Verified", count("verified"), "text-success"],
          ["Failed / unverified", count("failed") + count("unverified"), "text-destructive"],
          ["Not reproduced", count("not_reproduced"), ""],
          ["In progress", count(null), "text-primary"],
        ].map(([l, n, c]) => (
          <div key={l as string} className="bg-card p-4">
            <p className="label-mono">{l}</p>
            <p className={`mt-1 font-mono text-2xl ${c}`}>{q.isLoading ? "—" : n}</p>
          </div>
        ))}
      </div>
      <section>
        <h2 className="label-mono mb-3">Projects</h2>
        {q.data && q.data.projects.length === 0 && (
          <div className="rounded-md border border-dashed p-10 text-center">
            <p className="text-muted-foreground">No projects yet.</p>
            <Button asChild className="mt-4">
              <Link to="/projects/new">Import your first project</Link>
            </Button>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {q.data?.projects.map((p) => (
            <Link
              key={p.id}
              to="/projects/$id"
              params={{ id: p.id }}
              className="rounded-md border bg-card p-4 hover:border-primary/50"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{p.name}</p>
                <span className="font-mono text-[11px] uppercase text-muted-foreground">
                  {p.source} · {p.imports[0]?.status ?? "—"}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {p.inspection?.languages
                  .slice(0, 3)
                  .map((l) => l.name)
                  .join(", ") || "Not inspected"}{" "}
                · {p._count?.runs ?? 0} runs
              </p>
            </Link>
          ))}
        </div>
      </section>
      <section>
        <h2 className="label-mono mb-3">Recent runs</h2>
        <div className="divide-y rounded-md border bg-card">
          {q.data?.runs.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No repair runs yet.</p>
          )}
          {q.data?.runs.map((r) => (
            <Link
              key={r.id}
              to="/runs/$id"
              params={{ id: r.id }}
              className="flex flex-wrap items-center gap-3 p-3 hover:bg-secondary"
            >
              <StatusBadge status={r.status} outcome={r.outcome} />
              <span className="font-medium">{r.project?.name}</span>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
