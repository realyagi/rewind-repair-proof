import dns from "node:dns/promises";
import net from "node:net";

export class SsrfError extends Error {}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfError("Invalid URL"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new SsrfError("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new SsrfError("Credentials in URL are not allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new SsrfError("Only ports 80/443 are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|metadata(\.google\.internal)?)$/i.test(host) || /\.(local|internal|localhost|lan|home|corp)$/i.test(host) || !host.includes("."))
    throw new SsrfError("Internal hostnames are not allowed");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new SsrfError("Host resolves to a private or reserved address");
  return u;
}

/** Fetch with manual redirect handling — every hop is re-validated. */
export async function safeFetch(raw: string, maxRedirects = 3, maxBytes = 2_000_000) {
  let url = await assertPublicUrl(raw);
  const chain: string[] = [];
  for (let i = 0; i <= maxRedirects; i++) {
    chain.push(url.toString());
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    const started = Date.now();
    const res = await fetch(url, { redirect: "manual", signal: ac.signal, headers: { "user-agent": "REWIND-WebsiteInspection/1.0" } }).finally(() => clearTimeout(t));
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return { res, body: Buffer.concat(chunks).toString("utf8"), chain, ms: Date.now() - started, truncated: size > maxBytes };
  }
  throw new SsrfError("Too many redirects");
}
