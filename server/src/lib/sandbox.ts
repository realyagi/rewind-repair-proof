import { env } from "../config.js";

export type SandboxResult = {
  exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean;
  resources?: { memoryPeakBytes?: number; cpuSeconds?: number };
};

export class SandboxUnavailableError extends Error {}

/** Controlled interface to the isolated sandbox service. The worker never runs project code itself. */
export const sandbox = {
  configured: () => Boolean(env.SANDBOX_URL && env.SANDBOX_TOKEN),
  async health(): Promise<{ ok: boolean; detail?: unknown }> {
    if (!this.configured()) return { ok: false, detail: "SANDBOX_URL/SANDBOX_TOKEN not set" };
    try {
      const r = await fetch(`${env.SANDBOX_URL}/health`, { headers: { authorization: `Bearer ${env.SANDBOX_TOKEN}` }, signal: AbortSignal.timeout(5000) });
      return { ok: r.ok, detail: await r.json().catch(() => null) };
    } catch (e) { return { ok: false, detail: (e as Error).message }; }
  },
  async exec(job: { jobId: string; workspace: string; image: string; command: string; network: boolean; timeoutSeconds: number }): Promise<SandboxResult> {
    if (!this.configured()) throw new SandboxUnavailableError("Sandbox service is not configured (SANDBOX_URL, SANDBOX_TOKEN)");
    const r = await fetch(`${env.SANDBOX_URL}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.SANDBOX_TOKEN}` },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout((job.timeoutSeconds + 120) * 1000),
    }).catch((e) => { throw new SandboxUnavailableError(`Sandbox unreachable: ${(e as Error).message}`); });
    if (!r.ok) throw new SandboxUnavailableError(`Sandbox error ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as SandboxResult;
  },
  async cancel(jobId: string) {
    if (!this.configured()) return;
    await fetch(`${env.SANDBOX_URL}/cancel/${encodeURIComponent(jobId)}`, { method: "POST", headers: { authorization: `Bearer ${env.SANDBOX_TOKEN}` } }).catch(() => {});
  },
};
