// Minimal static file server copied INTO preview containers (runs untrusted-side, no secrets).
// Usage: node /opt/rewind-static.mjs <dir> <port>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const port = Number(process.argv[3] || 3000);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".map": "application/json" };

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent((req.url || "/").split("?")[0]); } catch { return res.writeHead(400).end(); }
  let file = path.resolve(root, "." + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html"); } catch {}
  if (!fs.existsSync(file)) {
    // SPA fallback only for navigation requests (no extension)
    if (path.extname(rel)) return res.writeHead(404).end("Not found");
    file = path.join(root, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end("Not found");
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(port, "0.0.0.0", () => console.log(`[rewind-static] serving ${root} on ${port}`));
