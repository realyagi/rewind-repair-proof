import { createFileRoute, Link } from "@tanstack/react-router";
import { SignedIn, SignedOut, SignUpButton } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "REWIND — Find the cause. Fix the code. Prove it works." },
      { name: "description", content: "REWIND reproduces failures in an isolated sandbox, diagnoses root causes, patches code, and verifies the fix with real test runs." },
      { property: "og:title", content: "REWIND — AI software repair agent" },
      { property: "og:description", content: "Evidence-backed repairs: reproduce, diagnose, patch, verify." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const steps = [
  ["01", "Import", "Upload a ZIP or pick a GitHub repo. Nothing runs during import — we inspect statically."],
  ["02", "Reproduce", "Your build and tests run in a disposable, network-isolated sandbox. Real exit codes, real logs."],
  ["03", "Diagnose", "The agent reads the actual failure output and source, then writes a root-cause analysis with evidence."],
  ["04", "Patch", "Minimal edits applied to a separate copy. Every change is a reviewable unified diff."],
  ["05", "Verify", "Commands re-run. Only a passing run is marked Verified. Everything else says exactly what it is."],
];

function Landing() {
  return (
    <main>
      <section className="relative overflow-hidden border-b bg-grid">
        <div className="mx-auto max-w-6xl px-4 py-24 md:py-32">
          <p className="label-mono mb-6">AI software investigator · repair agent</p>
          <h1 className="max-w-4xl text-5xl font-bold leading-[1.02] tracking-tight md:text-7xl">
            Find the cause.<br />Fix the code.<br /><span className="text-primary">Prove it works.</span>
          </h1>
          <p className="mt-8 max-w-xl text-lg text-muted-foreground">
            REWIND reproduces your failure, traces it to the root, patches it, and re-runs your tests. No pretend green checks.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <SignedOut>
              <SignUpButton mode="modal"><Button size="lg" className="shadow-glow">Start a repair</Button></SignUpButton>
            </SignedOut>
            <SignedIn>
              <Button size="lg" asChild className="shadow-glow"><Link to="/dashboard">Open dashboard</Link></Button>
            </SignedIn>
            <Button size="lg" variant="outline" asChild><a href="#how">How it works</a></Button>
          </div>
          <div className="mt-16 overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/40">
            <img
              src="/rewind-console.svg"
              alt="REWIND repair workspace showing a code patch, root-cause evidence, and passing verification checks"
              className="block h-auto w-full"
              loading="eager"
              decoding="async"
            />
          </div>
          <pre className="mt-16 max-w-2xl overflow-x-auto rounded-md border bg-terminal p-4 text-xs leading-relaxed text-muted-foreground">
{`$ npm test                      `}<span className="text-destructive">exit 1</span>{`
  ✗ cart.total applies discount   expected 90, received 100
> diagnosing… src/cart.ts:42 discount applied after rounding
> patch: 1 file changed, +2 −1
$ npm test                      `}<span className="text-success">exit 0</span>{`
  status: `}<span className="text-success">VERIFIED</span>
          </pre>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">Illustrative example of a report format.</p>
        </div>
      </section>
      <section id="how" className="mx-auto max-w-6xl px-4 py-20">
        <div className="grid gap-px overflow-hidden rounded-md border bg-border md:grid-cols-5">
          {steps.map(([n, t, d]) => (
            <div key={n} className="bg-card p-6">
              <p className="font-mono text-xs text-primary">{n}</p>
              <h2 className="mt-3 text-lg font-semibold">{t}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
        <div className="mt-12 grid gap-6 md:grid-cols-4">
          {[["Verified", "text-success", "Verification commands passed."], ["Unverified", "text-warning", "Patch produced, checks still failing."], ["Failed", "text-destructive", "The run could not complete."], ["Could not reproduce", "text-muted-foreground", "Baseline already passes."]].map(([l, c, d]) => (
            <div key={l} className="border-l-2 pl-4">
              <p className={`font-mono text-sm uppercase tracking-wider ${c}`}>{l}</p>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="border-t py-8 text-center label-mono">REWIND · self-hosted on your own infrastructure</footer>
    </main>
  );
}
