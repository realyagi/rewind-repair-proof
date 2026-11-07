import { z } from "zod";

const num = (d: number) => z.coerce.number().int().positive().default(d);

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: num(4000),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:8080"),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  // PEM public key from Clerk Dashboard > API keys > JWKS / PEM. Escaped "\n" are normalized.
  CLERK_JWT_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().replace(/^"|"$/g, "").replace(/\\n/g, "\n") : undefined)),
  VULTR_INFERENCE_API_KEY: z.string().optional(),
  VULTR_INFERENCE_BASE_URL: z.string().default("https://api.vultrinference.com/v1"),
  VULTR_INFERENCE_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  AI_TIMEOUT_MS: num(120000),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  STORAGE_PATH: z.string().default("./storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  WORKSPACE_PATH: z.string().default("./workspaces"),
  WORKSPACE_TTL_HOURS: num(24),
  SANDBOX_URL: z.string().optional(),
  SANDBOX_TOKEN: z.string().optional(),
  SANDBOX_TIMEOUT_SECONDS: num(600),
  MAX_UPLOAD_MB: num(100),
  MAX_EXTRACTED_MB: num(500),
  MAX_FILES: num(20000),
  MAX_REPAIR_RETRIES: num(3),
  MAX_CONCURRENT_REPAIR_RUNS: num(2),
  // Live Preview. Previews are served ONLY on a separate host (never the app origin) so untrusted
  // preview JS cannot read app cookies/storage. Each session gets "<id>-<token>.<PREVIEW_BASE_DOMAIN>".
  PREVIEW_BASE_DOMAIN: z.string().optional().transform((v) => v?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") || undefined),
  PREVIEW_SCHEME: z.enum(["http", "https"]).default("https"),
  PREVIEW_TTL_MINUTES: num(20),
  PREVIEW_MAX_PER_USER: num(1),
});

export const env = schema.parse(process.env);
export type Env = typeof env;

/** Never log secret values — only whether they are configured. */
export function integrationStatus() {
  return {
    clerk: Boolean(env.CLERK_SECRET_KEY),
    clerkJwtKey: Boolean(env.CLERK_JWT_KEY),
    vultr: Boolean(env.VULTR_INFERENCE_API_KEY && env.VULTR_INFERENCE_MODEL),
    vultrModel: env.VULTR_INFERENCE_MODEL ?? null,
    vultrBaseUrl: env.VULTR_INFERENCE_BASE_URL,
    gemini: Boolean(env.GEMINI_API_KEY),
    geminiModel: env.GEMINI_MODEL,
    githubOAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.ENCRYPTION_KEY),
    storage: env.STORAGE_PROVIDER,
    sandboxConfigured: Boolean(env.SANDBOX_URL && env.SANDBOX_TOKEN),
    previewConfigured: Boolean(env.PREVIEW_BASE_DOMAIN && env.SANDBOX_URL && env.SANDBOX_TOKEN),
  };
}
