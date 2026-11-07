// Pure Live Preview logic (no DB / network) so it can be unit-tested.
import crypto from "node:crypto";

export const PREVIEW_PORT = 3000; // fixed container port; never user-controlled
export const PREVIEW_IMAGE = "node:22-alpine";
export const ACTIVE_STATES = ["starting", "ready"] as const;
export const TERMINAL_STATES = ["stopped", "failed", "expired"] as const;
export type PreviewState = (typeof ACTIVE_STATES)[number] | (typeof TERMINAL_STATES)[number];

export type PreviewPlan =
  | { supported: true; framework: "static" | "vite" | "react" | "nextjs"; image: string; setup: string | null; start: string; notes: string[] }
  | { supported: false; framework: string | null; reason: string };

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown } | null;

const STATIC_SERVER = `node /opt/rewind-static.mjs`;

/** Conservative allowlist detection. Commands are built only from fixed templates — never from package.json scripts. */
export function planPreview(files: string[], pkg: Pkg): PreviewPlan {
  const has = (f: string) => files.includes(f);
  if (!pkg) {
    if (has("package.json")) return { supported: false, framework: null, reason: "package.json could not be parsed as JSON." };
    if (has("index.html")) return { supported: true, framework: "static", image: PREVIEW_IMAGE, setup: null, start: `${STATIC_SERVER} . ${PREVIEW_PORT}`, notes: ["Static site served from project root."] };
    if (has("public/index.html")) return { supported: true, framework: "static", image: PREVIEW_IMAGE, setup: null, start: `${STATIC_SERVER} public ${PREVIEW_PORT}`, notes: ["Static site served from public/."] };
    return { supported: false, framework: null, reason: "No package.json or index.html found. Live Preview supports static HTML, Vite, React (Create React App) and Next.js projects." };
  }
  if (pkg.workspaces) return { supported: false, framework: null, reason: "Monorepo/workspaces projects are not supported by Live Preview (the app entry point is ambiguous)." };
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const notes: string[] = [];
  let install = "npm install --no-audit --no-fund";
  if (has("package-lock.json")) install = "npm ci --no-audit --no-fund";
  else if (has("pnpm-lock.yaml")) install = "corepack enable && pnpm install --frozen-lockfile";
  else if (has("yarn.lock")) install = "corepack enable && yarn install --frozen-lockfile";
  else notes.push("No lockfile found; dependencies resolved with npm install.");
  const out = (dir: string) => `test -f ${dir}/index.html || { echo "[REWIND] Build output ${dir}/index.html not found (custom outDir is not supported)"; exit 1; }; ${STATIC_SERVER} ${dir} ${PREVIEW_PORT}`;

  if (deps["next"]) return { supported: true, framework: "nextjs", image: PREVIEW_IMAGE, setup: `${install} && npx --no-install next build`, start: `npx --no-install next start -H 0.0.0.0 -p ${PREVIEW_PORT}`, notes };
  if (deps["vite"]) return { supported: true, framework: deps["react"] ? "react" : "vite", image: PREVIEW_IMAGE, setup: `${install} && npx --no-install vite build`, start: out("dist"), notes: [...notes, "Production build (vite build) served statically."] };
  if (deps["react-scripts"]) return { supported: true, framework: "react", image: PREVIEW_IMAGE, setup: `${install} && npx --no-install react-scripts build`, start: out("build"), notes: [...notes, "Production build (react-scripts build) served statically."] };
  if (deps["react"]) return { supported: false, framework: "react", reason: "React project without Vite, Create React App or Next.js. Its custom bundler setup cannot be started safely from an allowlisted command." };
  if (has("index.html")) return { supported: true, framework: "static", image: PREVIEW_IMAGE, setup: null, start: `${STATIC_SERVER} . ${PREVIEW_PORT}`, notes: ["No supported framework dependency; serving index.html statically."] };
  return { supported: false, framework: null, reason: "No supported framework detected (static HTML, Vite, React or Next.js). Backend/CLI projects have no browser UI to preview." };
}

export const newSessionId = () => crypto.randomBytes(10).toString("hex"); // 20 hex chars
export const newAccessToken = () => crypto.randomBytes(16).toString("hex"); // 128-bit
export const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function tokenMatches(token: string, hash: string) {
  const a = Buffer.from(hashToken(token), "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Preview host label: "<sessionId>-<token>". The host itself is the short-lived capability. */
export function previewHost(id: string, token: string, base: string) {
  return `${id}-${token}.${base}`;
}

export function parsePreviewHost(host: string | undefined, base: string | undefined): { id: string; token: string } | null {
  if (!host || !base) return null;
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (!h.endsWith(`.${base}`)) return null;
  const m = /^([a-f0-9]{20})-([a-f0-9]{32})$/.exec(h.slice(0, -(base.length + 1)));
  return m ? { id: m[1]!, token: m[2]! } : null;
}

/** The preview host must never share a site with the app (cookies/storage isolation). */
export function previewDomainIsSafe(base: string | undefined, appUrl: string) {
  if (!base) return false;
  let appHost: string;
  try { appHost = new URL(appUrl).hostname.toLowerCase(); } catch { return false; }
  return base !== appHost && !appHost.endsWith(`.${base}`) && !base.endsWith(`.${appHost}`);
}

export function isExpired(expiresAt: Date, now = new Date()) {
  return expiresAt.getTime() <= now.getTime();
}
