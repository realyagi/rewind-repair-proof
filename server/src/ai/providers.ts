import { env } from "../config.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type AIResult = { text: string; model: string; usage?: unknown };

export class ProviderUnavailableError extends Error {}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const transient = e instanceof TransientError || (e as Error).name === "AbortError";
      if (!transient || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}
class TransientError extends Error {}

/** Vultr Serverless Inference — OpenAI-compatible. Required for repair-agent calls. */
export const vultr = {
  name: "vultr" as const,
  configured: () => Boolean(env.VULTR_INFERENCE_API_KEY && env.VULTR_INFERENCE_MODEL),
  async chat(messages: ChatMessage[], opts: { json?: boolean; model?: string } = {}): Promise<AIResult> {
    if (!env.VULTR_INFERENCE_API_KEY) throw new ProviderUnavailableError("VULTR_INFERENCE_API_KEY is not configured");
    const model = opts.model || env.VULTR_INFERENCE_MODEL;
    if (!model) throw new ProviderUnavailableError("VULTR_INFERENCE_MODEL is not configured");
    return withRetry(async () => {
      const res = await fetchWithTimeout(
        `${env.VULTR_INFERENCE_BASE_URL.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env.VULTR_INFERENCE_API_KEY}` },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.1,
            ...(opts.json ? { response_format: { type: "json_object" } } : {}),
          }),
        },
        env.AI_TIMEOUT_MS,
      );
      if (res.status === 429 || res.status >= 500) throw new TransientError(`Vultr Inference ${res.status}`);
      if (!res.ok) throw new Error(`Vultr Inference error ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: unknown; model?: string };
      return { text: j.choices?.[0]?.message?.content ?? "", model: j.model ?? model, usage: j.usage };
    });
  },
};

/** Google Gemini — optional assistant features only (never repair-agent calls). */
export const gemini = {
  name: "gemini" as const,
  configured: () => Boolean(env.GEMINI_API_KEY),
  async chat(messages: ChatMessage[], opts: { model?: string } = {}): Promise<AIResult> {
    if (!env.GEMINI_API_KEY) throw new ProviderUnavailableError("GEMINI_API_KEY is not configured");
    const model = opts.model || env.GEMINI_MODEL;
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    return withRetry(async () => {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
          body: JSON.stringify({ contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) }),
        },
        env.AI_TIMEOUT_MS,
      );
      if (res.status === 429 || res.status >= 500) throw new TransientError(`Gemini ${res.status}`);
      if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: unknown };
      const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return { text, model, usage: j.usageMetadata };
    });
  },
};

export function parseJson<T>(text: string): T {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (m ? m[1] : text)!.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw) as T;
}
