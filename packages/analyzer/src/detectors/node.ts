import type { AnalysisResult, RepoFS } from "../types";
import { findLoopbackBind, findPortInCode, readJson } from "../util";
import { walkSources } from "../fs";

interface PackageJson {
  name?: string;
  main?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
}

export type { PackageJson };

const PM_COMMANDS = {
  npm: { install: (lock: boolean) => (lock ? "npm ci" : "npm install"), run: (s: string) => `npm run ${s}`, exec: "npx" },
  pnpm: { install: (lock: boolean) => (lock ? "pnpm install --frozen-lockfile" : "pnpm install"), run: (s: string) => `pnpm run ${s}`, exec: "pnpm exec" },
  yarn: { install: (lock: boolean) => (lock ? "yarn install --frozen-lockfile" : "yarn install"), run: (s: string) => `yarn run ${s}`, exec: "yarn" },
  bun: { install: (lock: boolean) => (lock ? "bun install --frozen-lockfile" : "bun install"), run: (s: string) => `bun run ${s}`, exec: "bunx" },
} as const;
type PM = keyof typeof PM_COMMANDS;

/** Static-output frameworks: [dependency, framework name, default output dir, default dev port] */
const STATIC_FRAMEWORKS: Array<[string, string, string]> = [
  ["@angular/core", "angular", "dist"],
  ["gatsby", "gatsby", "public"],
  ["react-scripts", "create-react-app", "build"],
  ["@docusaurus/core", "docusaurus", "build"],
  ["vitepress", "vitepress", "docs/.vitepress/dist"],
  ["@vue/cli-service", "vue-cli", "dist"],
];

/** Server frameworks: [dependency, framework, default port] */
const SERVER_FRAMEWORKS: Array<[string, string, number]> = [
  ["@nestjs/core", "nestjs", 3000],
  ["fastify", "fastify", 3000],
  ["express", "express", 3000],
  ["koa", "koa", 3000],
  ["hono", "hono", 3000],
  ["@hapi/hapi", "hapi", 3000],
  ["socket.io", "socket.io", 3000],
];

export async function detectNode(fs: RepoFS, r: AnalysisResult): Promise<boolean> {
  const pkg = await readJson<PackageJson>(fs, "package.json");
  if (!pkg) return false;
  r.runtime = "node";
  r.reasons.push("Found package.json, so this is a Node.js project.");
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};

  // Package manager
  let pm: PM = "npm";
  let hasLock = false;
  const pmField = pkg.packageManager?.split("@")[0];
  if (pmField && pmField in PM_COMMANDS) pm = pmField as PM;
  for (const [file, name] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ] as const) {
    if (await fs.exists(file)) {
      if (!pmField) pm = name;
      hasLock = hasLock || name === pm;
      if (!pmField) r.reasons.push(`Found ${file}, so dependencies are installed with ${name}.`);
      break;
    }
  }
  r.packageManager = pm;
  const cmd = PM_COMMANDS[pm];
  r.installCommand = cmd.install(hasLock);

  // Runtime version
  const nvmrc = (await fs.readFile(".nvmrc")) ?? (await fs.readFile(".node-version"));
  const fromEngines = pkg.engines?.node?.match(/(\d{2})/)?.[1];
  const fromNvm = nvmrc?.trim().replace(/^v/, "").match(/^(\d{2})/)?.[1];
  r.version = fromNvm ?? fromEngines ?? "22";
  if (fromNvm || fromEngines) r.reasons.push(`Node.js ${r.version} requested by ${fromNvm ? ".nvmrc" : "engines.node"}.`);

  if (scripts.build) r.buildCommand = cmd.run("build");
  if (scripts.test && !/no test specified/.test(scripts.test)) r.testCommand = cmd.run("test");

  // Framework detection, most specific first
  const has = (d: string) => d in deps;
  if (has("next")) {
    r.framework = "nextjs";
    const conf = (await fs.readFile("next.config.js")) ?? (await fs.readFile("next.config.mjs")) ?? (await fs.readFile("next.config.ts")) ?? "";
    if (/output\s*:\s*["']export["']/.test(conf)) {
      r.serviceType = "static";
      r.outputDirectory = "out";
      r.buildCommand = r.buildCommand ?? `${cmd.exec} next build`;
      r.reasons.push("Next.js is configured with output: 'export', so it is deployed as a static site from out/.");
    } else {
      r.port = 3000;
      r.buildCommand = r.buildCommand ?? `${cmd.exec} next build`;
      r.startCommand = scripts.start ? cmd.run("start") : `${cmd.exec} next start`;
      if (/output\s*:\s*["']standalone["']/.test(conf)) r.reasons.push("Next.js standalone output detected.");
      r.reasons.push("Detected Next.js: built with next build and served with next start on $PORT.");
    }
  } else if (has("nuxt") || has("nuxt3")) {
    r.framework = "nuxt";
    if (scripts.generate && !scripts.start) {
      r.serviceType = "static";
      r.buildCommand = cmd.run("generate");
      r.outputDirectory = ".output/public";
    } else {
      r.port = 3000;
      r.buildCommand = r.buildCommand ?? `${cmd.exec} nuxt build`;
      r.startCommand = "node .output/server/index.mjs";
    }
    r.reasons.push("Detected Nuxt.");
  } else if (has("@remix-run/node") || has("@remix-run/serve") || has("@react-router/serve")) {
    r.framework = has("@react-router/serve") ? "react-router" : "remix";
    r.port = 3000;
    r.startCommand = scripts.start ? cmd.run("start") : null;
    r.reasons.push(`Detected ${r.framework === "remix" ? "Remix" : "React Router"} (server rendering).`);
  } else if (has("@sveltejs/kit")) {
    r.framework = "sveltekit";
    const conf = (await fs.readFile("svelte.config.js")) ?? "";
    if (/adapter-static/.test(conf) || has("@sveltejs/adapter-static")) {
      r.serviceType = "static";
      r.outputDirectory = "build";
      r.reasons.push("SvelteKit with adapter-static: deployed as a static site from build/.");
    } else {
      r.port = 3000;
      r.startCommand = "node build";
      r.reasons.push("SvelteKit with a Node adapter: served with node build.");
      if (!has("@sveltejs/adapter-node")) r.warnings.push("Install @sveltejs/adapter-node so the build produces a Node server.");
    }
  } else if (has("astro")) {
    r.framework = "astro";
    const conf = (await fs.readFile("astro.config.mjs")) ?? (await fs.readFile("astro.config.ts")) ?? "";
    if (/output\s*:\s*["'](server|hybrid)["']/.test(conf) && /@astrojs\/node/.test(conf)) {
      r.port = 4321;
      r.startCommand = "node ./dist/server/entry.mjs";
      r.reasons.push("Astro in server mode with the Node adapter.");
    } else {
      r.serviceType = "static";
      r.outputDirectory = "dist";
      r.reasons.push("Detected Astro (static output in dist/).");
    }
  } else {
    const st = STATIC_FRAMEWORKS.find(([d]) => has(d));
    const server = SERVER_FRAMEWORKS.find(([d]) => has(d));
    if (server) {
      r.framework = server[1];
      r.port = server[2];
      r.reasons.push(`Detected ${server[1]} in dependencies: this is a web server.`);
    } else if (st) {
      r.framework = st[1];
      r.serviceType = "static";
      r.outputDirectory = st[2];
      if (st[0] === "@angular/core") {
        const angular = await readJson<{ projects?: Record<string, { architect?: { build?: { options?: { outputPath?: string | { base?: string } } } } }> }>(fs, "angular.json");
        const first = angular?.projects ? Object.values(angular.projects)[0] : undefined;
        const out = first?.architect?.build?.options?.outputPath;
        const base = typeof out === "string" ? out : out?.base;
        if (base) r.outputDirectory = `${base}/browser`;
      }
      r.reasons.push(`Detected ${st[1]}: it builds static files into ${r.outputDirectory}/.`);
    } else if (has("vite")) {
      r.framework = has("react") ? "vite-react" : has("vue") ? "vite-vue" : has("svelte") ? "vite-svelte" : "vite";
      r.serviceType = "static";
      const viteConf = (await fs.readFile("vite.config.ts")) ?? (await fs.readFile("vite.config.js")) ?? (await fs.readFile("vite.config.mjs")) ?? "";
      r.outputDirectory = /outDir\s*:\s*["']([^"']+)["']/.exec(viteConf)?.[1] ?? "dist";
      r.reasons.push(`Detected Vite: the build outputs static files into ${r.outputDirectory}/.`);
    }
  }

  if (r.serviceType === "static") {
    r.startCommand = null;
    r.port = null;
    if (!r.buildCommand) r.warnings.push("No build script found in package.json for this static site.");
  } else if (!r.startCommand) {
    if (scripts.start) {
      r.startCommand = cmd.run("start");
      r.reasons.push('Using the "start" script from package.json.');
    } else if (scripts.serve && !r.framework?.startsWith("vite")) {
      r.startCommand = cmd.run("serve");
    } else {
      const entry = pkg.main && (await fs.exists(pkg.main)) ? pkg.main : await firstFile(fs, ["server.js", "index.js", "app.js", "main.js", "src/index.js", "src/server.js", "server.mjs", "index.mjs"]);
      if (entry) {
        r.startCommand = `node ${entry}`;
        r.reasons.push(`No start script; starting the entry file ${entry}.`);
      }
    }
  }

  // Background worker heuristic: no web framework and a worker script.
  if (!r.framework && r.serviceType === "web" && (scripts.worker || has("bullmq") || has("discord.js") || has("whatsapp-web.js") || has("@whiskeysockets/baileys") || has("telegraf"))) {
    if (!SERVER_FRAMEWORKS.some(([d]) => has(d))) {
      r.serviceType = "worker";
      if (scripts.worker) r.startCommand = cmd.run("worker");
      r.reasons.push("No HTTP framework found but a bot/queue library is used: deployed as a background worker.");
    }
  }

  // Port + loopback detection from source code
  if (r.serviceType === "web") {
    const files = await walkSources(fs, [".js", ".mjs", ".cjs", ".ts"], 120, 3);
    for (const f of files) {
      if (f.includes(".config.") || f.includes(".test.") || f.includes(".spec.")) continue;
      const code = await fs.readFile(f);
      if (!code) continue;
      if (/\.listen\(/.test(code) || /process\.env\.PORT/.test(code)) {
        const p = findPortInCode(code);
        if (p && !r.port) r.port = p;
        else if (p && r.framework && SERVER_FRAMEWORKS.some(([, n]) => n === r.framework)) r.port = p;
        if (/process\.env\.PORT/.test(code)) r.reasons.push(`${f} reads process.env.PORT; SKYHOST injects PORT automatically.`);
        else r.warnings.push(`${f} does not read process.env.PORT. SKYHOST sets PORT=${r.port ?? 3000}; make sure the app listens on it.`);
        const loop = findLoopbackBind(code);
        if (loop) {
          r.suggestions.push({
            file: f,
            message: `The server listens on ${loop}, which is not reachable from outside the container. Listen on 0.0.0.0 instead.`,
            find: loop,
            replace: "0.0.0.0",
          });
        }
        break;
      }
    }
    if (!r.port) r.port = 3000;
  }

  if (!r.version) r.version = "22";
  return true;
}

async function firstFile(fs: RepoFS, candidates: string[]): Promise<string | null> {
  for (const c of candidates) if (await fs.exists(c)) return c;
  return null;
}
