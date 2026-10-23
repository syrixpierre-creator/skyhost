import { parse as parseYaml } from "yaml";
import type { AnalysisResult, MonorepoInfo, RepoFS } from "./types";
import { subFS } from "./fs";
import { emptyResult, readJson } from "./util";
import { detectNode, type PackageJson } from "./detectors/node";
import { detectPython } from "./detectors/python";
import { detectDocker, detectGo, detectJava, detectPhp, detectRust, detectStatic } from "./detectors/others";
import { detectCompose, detectDatabases, detectEnvironmentVariables } from "./detectors/env-db";

export interface AnalyzeOptions {
  /** Sub directory to analyze. When omitted, SKYHOST auto-detects it for monorepos. */
  rootDir?: string;
  /** Use a specific Dockerfile path relative to the root directory. */
  dockerfilePath?: string;
  /** Ignore the Dockerfile even if present. */
  ignoreDockerfile?: boolean;
  /** Internal: depth guard for monorepo recursion. */
  depth?: number;
}

const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts", "Dockerfile", "manage.py", "index.html"];

export async function hasManifest(fs: RepoFS): Promise<boolean> {
  for (const m of MANIFESTS) if (await fs.exists(m)) return true;
  return false;
}

/** Analyzes one directory of a repository. */
export async function analyzeDirectory(rootFs: RepoFS, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const rootDir = normalizeDir(opts.rootDir ?? ".");
  const fs = subFS(rootFs, rootDir);
  const r = emptyResult(rootDir);

  // Language detection: the first matching detector wins, in order of specificity.
  const detected =
    (await detectNode(fs, r)) ||
    (await detectPython(fs, r)) ||
    (await detectGo(fs, r)) ||
    (await detectRust(fs, r)) ||
    (await detectJava(fs, r)) ||
    (await detectPhp(fs, r)) ||
    false;

  const docker = !opts.ignoreDockerfile && (await detectDocker(fs, r, opts.dockerfilePath));
  if (docker) {
    // A Dockerfile is authoritative: SKYHOST uses it and does not run language specific commands.
    if (!detected) r.runtime = "docker";
    r.installCommand = null;
    r.buildCommand = null;
    r.startCommand = null;
    r.serviceType = r.docker?.expose.length || r.port ? "web" : r.serviceType;
    if (!r.port && r.serviceType === "web") r.port = 8080;
  }
  if (!detected && !docker) await detectStatic(fs, r);

  await detectEnvironmentVariables(fs, r);
  await detectDatabases(fs, r);
  await detectCompose(fs, r);

  r.confidence = scoreConfidence(r, detected || docker);
  return r;
}

function scoreConfidence(r: AnalysisResult, detected: boolean): AnalysisResult["confidence"] {
  if (!detected && r.runtime !== "static") return "low";
  if (r.dockerDetected) return r.docker?.expose.length || r.serviceType !== "web" ? "high" : "medium";
  if (r.serviceType === "static") return r.buildCommand || r.runtime === "static" ? (r.framework ? "high" : "medium") : "medium";
  if (!r.startCommand) return "low";
  if (r.framework && r.port) return r.warnings.some((w) => /does not read/.test(w)) ? "medium" : "high";
  return "medium";
}

function normalizeDir(d: string): string {
  const n = d.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (n.split("/").includes("..")) throw new Error("rootDir must stay inside the repository");
  return n || ".";
}

/** Expands simple workspace globs ("apps/*", "packages/**", "services/api"). */
async function expandGlobs(fs: RepoFS, patterns: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const pat of patterns) {
    if (pat.startsWith("!")) continue;
    const clean = pat.replace(/\/\*\*$/, "/*").replace(/\/$/, "");
    if (clean.endsWith("/*")) {
      const base = clean.slice(0, -2);
      for (const e of await fs.list(base)) if (e.endsWith("/")) out.push(`${base}/${e.slice(0, -1)}`);
    } else if (!clean.includes("*")) out.push(clean);
  }
  return [...new Set(out)];
}

async function detectMonorepo(fs: RepoFS): Promise<{ tool: string; dirs: string[] } | null> {
  const pkg = await readJson<PackageJson>(fs, "package.json");
  const pnpmWs = await fs.readFile("pnpm-workspace.yaml");
  let patterns: string[] = [];
  let tool = "";
  if (pnpmWs) {
    try {
      patterns = (parseYaml(pnpmWs) as { packages?: string[] })?.packages ?? [];
      tool = "pnpm-workspaces";
    } catch {
      /* ignore */
    }
  }
  if (!patterns.length && pkg?.workspaces) {
    patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
    tool = (await fs.exists("yarn.lock")) ? "yarn-workspaces" : "npm-workspaces";
  }
  const lerna = await readJson<{ packages?: string[] }>(fs, "lerna.json");
  if (!patterns.length && lerna?.packages) {
    patterns = lerna.packages;
    tool = "lerna";
  }
  if (patterns.length) {
    if (await fs.exists("turbo.json")) tool = "turborepo";
    else if (await fs.exists("nx.json")) tool = "nx";
    return { tool, dirs: await expandGlobs(fs, patterns) };
  }
  // Polyglot layout: no root manifest but several sub directories with their own manifest.
  if (!(await hasManifest(fs))) {
    const dirs: string[] = [];
    for (const top of await fs.list(".")) {
      if (!top.endsWith("/") || top.startsWith(".") || top === "node_modules/") continue;
      const name = top.slice(0, -1);
      if (await hasManifest(subFS(fs, name))) dirs.push(name);
      else if (["apps", "services", "packages"].includes(name)) {
        for (const e of await fs.list(name)) if (e.endsWith("/") && (await hasManifest(subFS(fs, `${name}/${e.slice(0, -1)}`)))) dirs.push(`${name}/${e.slice(0, -1)}`);
      }
    }
    if (dirs.length) return { tool: "directories", dirs };
  }
  return null;
}

/** A package is deployable when it is an app (has a start command or builds a static site), not a library. */
function isDeployable(a: AnalysisResult, path: string, pkg: PackageJson | null): boolean {
  if (/(^|\/)(packages|libs?)\//.test(path) && !a.dockerDetected && !pkg?.scripts?.start && !a.framework) return false;
  if (a.dockerDetected) return true;
  if (a.serviceType === "static") return !!a.buildCommand || a.runtime === "static";
  return !!a.startCommand;
}

/**
 * Entry point: analyzes a repository, detecting monorepos and auto-selecting the root directory.
 * When a monorepo is detected, the result describes the best candidate and `monorepo.packages` lists every app.
 */
export async function analyzeRepository(fs: RepoFS, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  if (opts.rootDir && normalizeDir(opts.rootDir) !== ".") return analyzeDirectory(fs, opts);
  const mono = await detectMonorepo(fs);
  if (!mono) return analyzeDirectory(fs, opts);

  const info: MonorepoInfo = { tool: mono.tool, packages: [] };
  for (const dir of mono.dirs.slice(0, 30)) {
    const sub = subFS(fs, dir);
    const pkg = await readJson<PackageJson>(sub, "package.json");
    const a = await analyzeDirectory(fs, { ...opts, rootDir: dir });
    if (a.runtime === "node" && mono.tool !== "directories" && !a.dockerDetected) {
      // Workspace packages share the root lockfile: install at the root, run scripts in the package directory.
      const rootPkg = await analyzeDirectory(fs, { ...opts, rootDir: ".", ignoreDockerfile: true });
      a.workspaceRoot = ".";
      a.packageManager = rootPkg.packageManager ?? a.packageManager;
      a.installCommand = rootPkg.installCommand ?? a.installCommand;
      a.reasons.push(`Dependencies are installed once at the repository root with ${a.packageManager} (${mono.tool}).`);
    }
    info.packages.push({ path: dir, name: pkg?.name ?? dir.split("/").at(-1)!, deployable: isDeployable(a, dir, pkg), analysis: a });
  }
  const deployable = info.packages.filter((p) => p.deployable);
  // Root compose file still describes the whole system.
  const root = await analyzeDirectory(fs, opts);
  let primary: AnalysisResult;
  if (deployable.length === 1) {
    primary = deployable[0]!.analysis!;
    primary.reasons.unshift(`Monorepo (${mono.tool}) with one deployable app: using root directory ${primary.rootDir}.`);
  } else if (deployable.length > 1) {
    const preferred = /^(web|app|frontend|site|www|client)$/;
    const web =
      deployable.find((p) => preferred.test(p.path.split("/").at(-1)!)) ??
      deployable.find((p) => p.analysis!.serviceType === "web" && p.analysis!.framework) ??
      deployable[0]!;
    primary = web.analysis!;
    primary.reasons.unshift(`Monorepo (${mono.tool}) with ${deployable.length} deployable apps; SKYHOST can create one service per app.`);
    // A multi-app repo always needs the user to confirm which services to create.
    if (primary.confidence === "high") primary.confidence = "medium";
  } else {
    primary = root;
    primary.warnings.push("Monorepo detected but no deployable app was found.");
    primary.confidence = "low";
  }
  primary.monorepo = info;
  // Strip nested analyses from the copy embedded in the primary to keep the payload flat.
  primary.monorepo.packages = info.packages.map((p) => ({ ...p, analysis: p.analysis === primary ? undefined : p.analysis }));
  if (root.compose && primary !== root) {
    primary.compose = primary.compose ?? root.compose;
    for (const d of root.databaseDetected) if (!primary.databaseDetected.some((x) => x.engine === d.engine)) primary.databaseDetected.push(d);
    for (const w of root.warnings) if (!primary.warnings.includes(w)) primary.warnings.push(w);
  }
  return primary;
}
