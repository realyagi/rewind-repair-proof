const SECRET_ENV = [
  "CLERK_SECRET_KEY", "VULTR_INFERENCE_API_KEY", "GEMINI_API_KEY", "GITHUB_CLIENT_SECRET",
  "DATABASE_URL", "ENCRYPTION_KEY", "S3_SECRET_ACCESS_KEY", "SANDBOX_TOKEN",
];

/** Strip any configured secret values and token-shaped strings from text before logging/storing. */
export function redact(text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v && v.length >= 8) out = out.split(v).join(`[REDACTED:${name}]`);
  }
  return out
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github_token]")
    .replace(/sk_(live|test)_[A-Za-z0-9]{10,}/g, "[REDACTED:clerk_key]");
}

export function truncate(s: string, max = 64_000) {
  return s.length > max ? s.slice(0, max / 2) + `\n…[truncated ${s.length - max} chars]…\n` + s.slice(-max / 2) : s;
}
