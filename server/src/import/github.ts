import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { ImportError } from "./zip.js";

const run = promisify(execFile);
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseGithubUrl(input: string) {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new ImportError("Invalid URL"); }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password || u.port)
    throw new ImportError("Only https://github.com/<owner>/<repo> URLs are allowed");
  const [owner, repoRaw] = u.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/, "");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo) || repo.startsWith(".")) throw new ImportError("Could not parse owner/repo");
  return { owner, repo };
}

const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;

export async function githubApi<T>(pathname: string, token?: string): Promise<T> {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "rewind", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 404) throw new ImportError("Repository not found or not accessible (connect GitHub for private repos)");
  if (!res.ok) throw new ImportError(`GitHub API error ${res.status}`);
  return (await res.json()) as T;
}

/** Shallow clone with hooks disabled and only https transport allowed. Does not execute repo code. */
export async function cloneRepo(owner: string, repo: string, branch: string, dest: string, token?: string) {
  if (!BRANCH.test(branch)) throw new ImportError("Invalid branch name");
  await fs.mkdir(dest, { recursive: true });
  const url = `https://github.com/${owner}/${repo}.git`;
  const auth = token ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
  try {
    await run("git", [
      ...auth, "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
      "-c", "core.symlinks=false", "clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", branch, "--", url, dest,
    ], { timeout: 180_000, env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0" } });
    const { stdout } = await run("git", ["-C", dest, "rev-parse", "HEAD"]);
    await fs.rm(`${dest}/.git`, { recursive: true, force: true });
    return stdout.trim();
  } catch (e) {
    throw new ImportError(`git clone failed: ${(e as Error).message.replace(/Authorization: Basic \S+/g, "[REDACTED]").slice(0, 300)}`);
  }
}
