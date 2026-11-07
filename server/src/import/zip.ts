import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config.js";

export class ImportError extends Error {}

const SKIP = /(^|\/)(node_modules|\.git|__MACOSX|\.venv|venv|target|dist|build|\.next)(\/|$)/;

/** Safely extract a ZIP: rejects traversal, absolute paths, symlinks, bombs. Never executes anything. */
export async function safeExtractZip(buf: Buffer, dest: string) {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new ImportError("File is not a valid ZIP archive");
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch { throw new ImportError("ZIP archive is corrupt"); }
  const entries = zip.getEntries();
  if (entries.length > env.MAX_FILES) throw new ImportError(`Archive has too many entries (${entries.length} > ${env.MAX_FILES})`);
  const root = path.resolve(dest);
  await fs.mkdir(root, { recursive: true });

  // Strip a single common top-level folder (typical GitHub/OS zips)
  const names = entries.map((e) => e.entryName.replace(/\\/g, "/"));
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes("/")) ? `${[...tops][0]}/` : "";

  let total = 0, files = 0;
  for (const e of entries) {
    let name = e.entryName.replace(/\\/g, "/");
    if (strip && name.startsWith(strip)) name = name.slice(strip.length);
    if (!name || SKIP.test(name)) continue;
    if (name.includes("\0") || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw new ImportError(`Unsafe entry path: ${e.entryName}`);
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new ImportError(`Path traversal blocked: ${e.entryName}`);
    const mode = (e.header.attr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new ImportError(`Symlink entries are not allowed: ${e.entryName}`);
    if (e.isDirectory) { await fs.mkdir(target, { recursive: true }); continue; }
    total += e.header.size;
    if (total > env.MAX_EXTRACTED_MB * 1024 * 1024) throw new ImportError(`Extracted size exceeds ${env.MAX_EXTRACTED_MB}MB`);
    const data = e.getData();
    if (data.length !== e.header.size) throw new ImportError(`Size mismatch on ${e.entryName}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { mode: 0o644 });
    files++;
  }
  if (files === 0) throw new ImportError("Archive contains no files");
  return { files, totalBytes: total };
}

export async function zipDirectory(dir: string): Promise<Buffer> {
  const zip = new AdmZip();
  const walk = async (rel: string) => {
    for (const d of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, d.name);
      if (SKIP.test(r)) continue;
      if (d.isDirectory()) await walk(r);
      else if (d.isFile()) zip.addFile(r, await fs.readFile(path.join(dir, r)));
    }
  };
  await walk("");
  return zip.toBuffer();
}
