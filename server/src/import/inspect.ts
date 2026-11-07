import fs from "node:fs/promises";
import path from "node:path";

export type Inspection = {
  languages: { name: string; files: number }[];
  frameworks: string[];
  packageManagers: string[];
  manifests: string[];
  buildConfig: string[];
  testConfig: string[];
  scripts: Record<string, string>;
  entryPoints: string[];
  testFiles: string[];
  suggested: { install?: string; build?: string; test?: string; image?: string };
  uncertainties: string[];
  fileCount: number;
};

const EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby", ".php": "PHP",
  ".cs": "C#", ".c": "C", ".cpp": "C++", ".h": "C/C++", ".swift": "Swift", ".vue": "Vue", ".svelte": "Svelte",
};

export async function listFiles(root: string, max = 20000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    if (out.length >= max) return;
    for (const d of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      if (/^(node_modules|\.git|dist|build|target|\.venv|venv|__pycache__)$/.test(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(r);
      else if (d.isFile()) out.push(r);
    }
  };
  await walk("");
  return out;
}

const exists = (files: Set<string>, f: string) => files.has(f);

/** Static inspection only — reads files, never executes project code. */
export async function inspectProject(root: string): Promise<Inspection> {
  const files = await listFiles(root);
  const set = new Set(files);
  const langs = new Map<string, number>();
  for (const f of files) { const l = EXT[path.extname(f)]; if (l) langs.set(l, (langs.get(l) ?? 0) + 1); }
  const r: Inspection = {
    languages: [...langs].map(([name, n]) => ({ name, files: n })).sort((a, b) => b.files - a.files),
    frameworks: [], packageManagers: [], manifests: [], buildConfig: [], testConfig: [], scripts: {},
    entryPoints: [], testFiles: files.filter((f) => /(\.|_)(test|spec)\.[a-z]+$|(^|\/)tests?\/|(^|\/)test_[^/]+\.py$/.test(f)).slice(0, 200),
    suggested: {}, uncertainties: [], fileCount: files.length,
  };

  if (exists(set, "package.json")) {
    r.manifests.push("package.json");
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      r.scripts = pkg.scripts ?? {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [dep, fw] of [["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["@angular/core", "Angular"], ["express", "Express"], ["@nestjs/core", "NestJS"], ["vite", "Vite"], ["vitest", "Vitest"], ["jest", "Jest"], ["mocha", "Mocha"]] as const)
        if (deps[dep]) r.frameworks.push(fw);
      const pm = exists(set, "pnpm-lock.yaml") ? "pnpm" : exists(set, "yarn.lock") ? "yarn" : exists(set, "bun.lockb") || exists(set, "bun.lock") ? "bun" : "npm";
      r.packageManagers.push(pm);
      r.suggested.install = pm === "npm" ? (exists(set, "package-lock.json") ? "npm ci" : "npm install") : pm === "yarn" ? "yarn install --frozen-lockfile" : `${pm} install`;
      if (r.scripts["build"]) r.suggested.build = `${pm} run build`;
      if (r.scripts["test"] && !/no test specified/.test(r.scripts["test"])) r.suggested.test = pm === "npm" ? "npm test" : `${pm} test`;
      r.suggested.image = pm === "bun" ? "oven/bun:1" : "node:22-bookworm";
      if (pkg.main) r.entryPoints.push(pkg.main);
    } catch { r.uncertainties.push("package.json could not be parsed"); }
  }
  for (const f of ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"]) if (exists(set, f)) r.manifests.push(f);
  if (r.manifests.some((m) => /requirements|pyproject|setup\.py|Pipfile/.test(m))) {
    r.packageManagers.push(exists(set, "poetry.lock") ? "poetry" : "pip");
    r.suggested.image ??= "python:3.12-bookworm";
    r.suggested.install ??= exists(set, "requirements.txt") ? "pip install -r requirements.txt" : "pip install -e .";
    if (r.testFiles.some((f) => f.endsWith(".py")) || exists(set, "pytest.ini")) r.suggested.test ??= "python -m pytest -q";
    for (const e of ["main.py", "app.py", "manage.py"]) if (exists(set, e)) r.entryPoints.push(e);
  }
  if (exists(set, "go.mod")) { r.manifests.push("go.mod"); r.packageManagers.push("go modules"); r.suggested.image ??= "golang:1.23"; r.suggested.build ??= "go build ./..."; r.suggested.test ??= "go test ./..."; }
  if (exists(set, "Cargo.toml")) { r.manifests.push("Cargo.toml"); r.packageManagers.push("cargo"); r.suggested.image ??= "rust:1"; r.suggested.build ??= "cargo build"; r.suggested.test ??= "cargo test"; }
  if (exists(set, "pom.xml")) { r.manifests.push("pom.xml"); r.packageManagers.push("maven"); r.suggested.image ??= "maven:3-eclipse-temurin-21"; r.suggested.test ??= "mvn -q test"; }
  if (exists(set, "build.gradle") || exists(set, "build.gradle.kts")) { r.manifests.push("build.gradle"); r.packageManagers.push("gradle"); r.uncertainties.push("Gradle projects may need a custom image/command"); }
  if (exists(set, "Gemfile")) { r.manifests.push("Gemfile"); r.packageManagers.push("bundler"); r.suggested.image ??= "ruby:3.3"; r.suggested.install ??= "bundle install"; }

  for (const f of files) {
    if (/^(tsconfig.*\.json|vite\.config\.[jt]s|webpack\.config\.[jt]s|next\.config\.[mjt]s|Makefile|Dockerfile|babel\.config\.[jt]s)$/.test(path.basename(f)) && !f.includes("/")) r.buildConfig.push(f);
    if (/^(jest\.config\.[jt]s|vitest\.config\.[jt]s|pytest\.ini|tox\.ini|\.mocharc.*|karma\.conf\.js|phpunit\.xml)$/.test(path.basename(f))) r.testConfig.push(f);
  }
  for (const e of ["src/index.ts", "src/main.ts", "src/main.tsx", "index.js", "src/index.js", "main.go", "src/main.rs", "cmd/main.go"]) if (exists(set, e)) r.entryPoints.push(e);

  if (!r.manifests.length) r.uncertainties.push("No recognized dependency manifest found — configure commands manually");
  if (!r.suggested.test && !r.suggested.build) r.uncertainties.push("No test or build command could be detected");
  if (!r.testFiles.length) r.uncertainties.push("No existing test files detected");
  return r;
}
