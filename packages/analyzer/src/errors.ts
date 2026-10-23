/**
 * Smart Error Analyzer: rule based (no external AI). Each rule inspects build/runtime logs and returns
 * a diagnosis with an optional, reviewable Auto Fix. Fixes are never applied without user confirmation.
 */
export interface ErrorDiagnosis {
  id: string;
  problem: string;
  cause: string;
  suggestedFix: string;
  confidence: "high" | "medium" | "low";
  /** Matched log excerpt. */
  evidence: string;
  autoFix?: AutoFix;
}

export interface AutoFix {
  kind: "file_edit" | "config_change" | "variable";
  file?: string;
  description: string;
  /** For file edits: exact text replacement. For config changes: the field and new value. */
  find?: string;
  replace?: string;
  field?: string;
  value?: string | number;
  reason: string;
}

interface Rule {
  id: string;
  match: RegExp;
  diagnose(m: RegExpMatchArray, ctx: ErrorContext): Omit<ErrorDiagnosis, "id" | "evidence"> | null;
}

export interface ErrorContext {
  runtime?: string;
  port?: number | null;
  packageManager?: string | null;
  memoryMb?: number;
  files?: Record<string, string>;
}

const RULES: Rule[] = [
  {
    id: "node-missing-module",
    match: /Cannot find module '([^']+)'|Module not found: (?:Error: )?Can't resolve '([^']+)'|ERR_MODULE_NOT_FOUND[^\n]*'([^']+)'/,
    diagnose: (m, ctx) => {
      const mod = (m[1] ?? m[2] ?? m[3] ?? "").replace(/^node:/, "");
      if (mod.startsWith(".") || mod.startsWith("/")) {
        return {
          problem: `A local file could not be found: ${mod}`,
          cause: "The import path is wrong, the file is not committed, or the file name casing differs (Linux is case sensitive).",
          suggestedFix: `Check that ${mod} exists in the repository with the exact same casing.`,
          confidence: "medium",
        };
      }
      const pkg = mod.startsWith("@") ? mod.split("/").slice(0, 2).join("/") : mod.split("/")[0]!;
      const pm = ctx.packageManager ?? "npm";
      const add = pm === "npm" ? `npm install ${pkg}` : pm === "yarn" ? `yarn add ${pkg}` : `${pm} add ${pkg}`;
      return {
        problem: `Missing package: ${pkg}`,
        cause: `The code imports "${pkg}" but it is not listed in package.json dependencies (it may be in devDependencies or only installed locally).`,
        suggestedFix: `Run "${add}" locally and commit package.json and the lockfile.`,
        confidence: "high",
        autoFix: ctx.files?.["package.json"] ? addDependencyFix(ctx.files["package.json"], pkg) : undefined,
      };
    },
  },
  {
    id: "python-missing-module",
    match: /ModuleNotFoundError: No module named '([^']+)'/,
    diagnose: (m, ctx) => {
      const mod = m[1]!.split(".")[0]!;
      const known: Record<string, string> = { cv2: "opencv-python", PIL: "Pillow", yaml: "PyYAML", sklearn: "scikit-learn", dotenv: "python-dotenv", psycopg2: "psycopg2-binary", jwt: "PyJWT", bs4: "beautifulsoup4" };
      const pkg = known[mod] ?? mod;
      const req = ctx.files?.["requirements.txt"];
      return {
        problem: `Missing Python package: ${pkg}`,
        cause: `The module "${mod}" is imported but not declared in your dependencies.`,
        suggestedFix: `Add "${pkg}" to requirements.txt (or pyproject.toml).`,
        confidence: "high",
        autoFix:
          req != null
            ? { kind: "file_edit", file: "requirements.txt", description: `Add ${pkg} to requirements.txt`, find: req, replace: `${req.replace(/\n*$/, "\n")}${pkg}\n`, reason: `${mod} is imported by the application.` }
            : undefined,
      };
    },
  },
  {
    id: "node-version",
    match: /The engine "node" is incompatible with this module\. Expected version "([^"]+)"|error [^\n]*: The engine "node" is incompatible|Unsupported engine[^\n]*node[^\n]*required: \{[^}]*node: '([^']+)'|requires Node\.js (?:version )?([>=^~\d. ]+)/i,
    diagnose: (m) => {
      const wanted = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      const major = wanted.match(/(\d{2})/)?.[1] ?? "22";
      return {
        problem: "Wrong Node.js version",
        cause: `A dependency requires Node.js ${wanted || "a newer version"}, but the build used a different version.`,
        suggestedFix: `Set the Node.js version to ${major} (engines.node in package.json or .nvmrc).`,
        confidence: "high",
        autoFix: { kind: "config_change", field: "runtimeVersion", value: major, description: `Use Node.js ${major}`, reason: `Required by a dependency (${wanted}).` },
      };
    },
  },
  {
    id: "python-version",
    match: /requires a different Python: ([\d.]+) not in '([^']+)'|Requires-Python ([^\s]+)|SyntaxError: invalid syntax[\s\S]{0,200}match /,
    diagnose: (m) => {
      const req = m[2] ?? m[3] ?? ">=3.10";
      const v = req.match(/(3\.\d+)/)?.[1] ?? "3.12";
      return {
        problem: "Wrong Python version",
        cause: `A package requires Python ${req}${m[1] ? ` but the build uses ${m[1]}` : ""}.`,
        suggestedFix: `Set the Python version to ${v} (.python-version file).`,
        confidence: "medium",
        autoFix: { kind: "config_change", field: "runtimeVersion", value: v, description: `Use Python ${v}`, reason: `Package requirement ${req}.` },
      };
    },
  },
  {
    id: "port-in-use",
    match: /EADDRINUSE[^\n]*:(\d+)|address already in use[^\n]*:(\d+)/i,
    diagnose: (m) => ({
      problem: `Port ${m[1] ?? m[2]} is already in use inside the container`,
      cause: "The application starts two servers on the same port, or a start script launches the app twice.",
      suggestedFix: "Make sure only one process listens on $PORT (check the start script and remove duplicate listen calls).",
      confidence: "medium",
    }),
  },
  {
    id: "port-mismatch",
    match: /health ?check failed[^\n]*(?:connection refused|ECONNREFUSED|timeout)|no process listening on port (\d+)/i,
    diagnose: (_m, ctx) => ({
      problem: "The application is not reachable on the expected port",
      cause: `SKYHOST expects the app to listen on 0.0.0.0:${ctx.port ?? "$PORT"} but nothing answered there. The app may use a hard-coded port or listen on localhost only.`,
      suggestedFix: `Read the port from the PORT environment variable and listen on 0.0.0.0 (e.g. app.listen(process.env.PORT || ${ctx.port ?? 3000}, "0.0.0.0")).`,
      confidence: "medium",
      autoFix: ctx.port ? undefined : { kind: "config_change", field: "port", value: 3000, description: "Set the service port", reason: "No port configured." },
    }),
  },
  {
    id: "listening-localhost",
    match: /(?:listening|running|started)[^\n]{0,40}(?:on|at)[^\n]{0,20}(?:localhost|127\.0\.0\.1):(\d+)/i,
    diagnose: (m) => ({
      problem: "The app only listens on localhost",
      cause: `The server binds to 127.0.0.1:${m[1]}, which is unreachable from the SKYHOST proxy.`,
      suggestedFix: 'Bind to "0.0.0.0" instead of "localhost" or "127.0.0.1".',
      confidence: "high",
    }),
  },
  {
    id: "missing-env",
    match: /(?:environment variable|env var(?:iable)?)\s+["'`]?([A-Z_][A-Z0-9_]+)["'`]?\s+(?:is )?(?:not set|missing|required|undefined)|KeyError: '([A-Z_][A-Z0-9_]+)'|Missing required (?:environment )?variable:? ["'`]?([A-Z_][A-Z0-9_]+)/i,
    diagnose: (m) => {
      const key = m[1] ?? m[2] ?? m[3]!;
      return {
        problem: `Missing environment variable ${key}`,
        cause: `The application needs ${key} at startup but it is not defined for this environment.`,
        suggestedFix: `Add ${key} in Variables, then redeploy.`,
        confidence: "high",
        autoFix: { kind: "variable", field: key, description: `Create variable ${key}`, reason: "Required at startup; you will be asked for its value." },
      };
    },
  },
  {
    id: "db-connection",
    match: /ECONNREFUSED[^\n]*:(5432|3306|27017|6379)|could not connect to server|Connection refused[^\n]*(?:5432|3306|27017|6379)|getaddrinfo ENOTFOUND [\w.-]*(?:db|postgres|mysql|redis|mongo)|MongoServerSelectionError|password authentication failed/i,
    diagnose: (m) => {
      const port = m[1];
      const engine = port === "3306" ? "MariaDB/MySQL" : port === "27017" ? "MongoDB" : port === "6379" ? "Redis" : "PostgreSQL";
      const auth = /password authentication failed/i.test(m[0]);
      return {
        problem: auth ? "Database authentication failed" : `Cannot reach the ${engine} database`,
        cause: auth
          ? "The credentials in the connection URL do not match the database (they may have been rotated)."
          : "The connection URL points to a host that does not exist from inside SKYHOST (often localhost), or the database is not connected to this service.",
        suggestedFix: auth ? "Reconnect the database to refresh DATABASE_URL, then redeploy." : "Connect the database to this service (Databases > Connect) so SKYHOST injects the internal URL, and never use localhost.",
        confidence: "high",
      };
    },
  },
  {
    id: "migration",
    match: /(relation "[^"]+" does not exist|no such table|Table '[^']+' doesn't exist|P3009|P1001|django\.db\.utils\.ProgrammingError|Migration [^\n]* failed)/i,
    diagnose: (m) => ({
      problem: "Database schema is missing or a migration failed",
      cause: `The database does not contain the expected tables (${m[1]}).`,
      suggestedFix: "Run your migrations as a one-off job (e.g. npx prisma migrate deploy, python manage.py migrate, php artisan migrate --force) or add them to the build/start command.",
      confidence: "medium",
    }),
  },
  {
    id: "permission",
    match: /EACCES: permission denied[^\n]*'([^']+)'|PermissionError: \[Errno 13\] Permission denied: '([^']+)'|permission denied[^\n]*open ([^\s]+)/i,
    diagnose: (m) => {
      const path = m[1] ?? m[2] ?? m[3] ?? "";
      return {
        problem: `Permission denied: ${path}`,
        cause: "SKYHOST runs applications as a non-root user. The app tries to write to a directory it does not own.",
        suggestedFix: path.startsWith("/tmp") ? "Make sure the directory is created by the app before use." : `Write to /tmp or attach a volume for ${path}. Do not write into the image directory at runtime.`,
        confidence: "high",
      };
    },
  },
  {
    id: "oom",
    match: /JavaScript heap out of memory|FATAL ERROR: Reached heap limit|Killed\s*$|exit code 137|OOMKilled|MemoryError|Cannot allocate memory/im,
    diagnose: (_m, ctx) => {
      const next = Math.min((ctx.memoryMb ?? 512) * 2, 16384);
      return {
        problem: "Out of memory",
        cause: `The process used more than the ${ctx.memoryMb ?? 512} MB available and was stopped.`,
        suggestedFix: `Increase the memory to ${next} MB, or reduce memory usage (for Node.js builds: NODE_OPTIONS=--max-old-space-size).`,
        confidence: "high",
        autoFix: { kind: "config_change", field: "resources.memoryMb", value: next, description: `Increase memory to ${next} MB`, reason: "The previous run was killed for exceeding its memory limit." },
      };
    },
  },
  {
    id: "lockfile",
    match: /npm ci[^\n]*can only install packages when your package\.json and package-lock\.json[^\n]*are in sync|ERR_PNPM_OUTDATED_LOCKFILE|Your lockfile needs to be updated|lockfile[^\n]*out of date/i,
    diagnose: (_m, ctx) => ({
      problem: "The lockfile is out of sync with package.json",
      cause: "Dependencies were changed in package.json without updating the lockfile.",
      suggestedFix: `Run "${ctx.packageManager ?? "npm"} install" locally and commit the updated lockfile.`,
      confidence: "high",
    }),
  },
  {
    id: "missing-script",
    match: /npm ERR! Missing script: "([^"]+)"|ERR_PNPM_NO_SCRIPT[^\n]*"?(\w+)"?|error Command "(\w+)" not found/,
    diagnose: (m) => {
      const s = m[1] ?? m[2] ?? m[3]!;
      return {
        problem: `Script "${s}" does not exist`,
        cause: `The configured command runs "${s}" but package.json has no such script.`,
        suggestedFix: `Add a "${s}" script to package.json or change the ${s === "start" ? "start" : "build"} command in the service settings.`,
        confidence: "high",
      };
    },
  },
  {
    id: "typescript",
    match: /error TS(\d+): ([^\n]+)/,
    diagnose: (m) => ({
      problem: "TypeScript compilation failed",
      cause: `TS${m[1]}: ${m[2]}`,
      suggestedFix: "Fix the type error locally (run the build command on your machine) and push again.",
      confidence: "high",
    }),
  },
  {
    id: "command-not-found",
    match: /(?:sh|bash): (?:\d+: )?([\w.-]+): (?:command )?not found/,
    diagnose: (m) => ({
      problem: `Command not found: ${m[1]}`,
      cause: `"${m[1]}" is not installed in the build image.`,
      suggestedFix: `Add ${m[1]} to your dependencies, or use a Dockerfile that installs it.`,
      confidence: "medium",
    }),
  },
];

function addDependencyFix(pkgJson: string, pkg: string): AutoFix | undefined {
  try {
    const parsed = JSON.parse(pkgJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const version = parsed.devDependencies?.[pkg] ?? "latest";
    const next = { ...parsed, dependencies: { ...(parsed.dependencies ?? {}), [pkg]: version } };
    if (parsed.devDependencies?.[pkg]) {
      const dev = { ...parsed.devDependencies };
      delete dev[pkg];
      (next as typeof parsed).devDependencies = dev;
    }
    return {
      kind: "file_edit",
      file: "package.json",
      description: parsed.devDependencies?.[pkg] ? `Move ${pkg} from devDependencies to dependencies` : `Add ${pkg} to dependencies`,
      find: pkgJson,
      replace: JSON.stringify(next, null, 2) + "\n",
      reason: `${pkg} is required at runtime. Remember to update the lockfile afterwards.`,
    };
  } catch {
    return undefined;
  }
}

export function analyzeErrors(log: string, ctx: ErrorContext = {}): ErrorDiagnosis[] {
  const out: ErrorDiagnosis[] = [];
  const text = log.length > 200_000 ? log.slice(-200_000) : log;
  for (const rule of RULES) {
    const m = text.match(rule.match);
    if (!m) continue;
    const d = rule.diagnose(m, ctx);
    if (!d) continue;
    const idx = m.index ?? 0;
    const start = text.lastIndexOf("\n", Math.max(0, idx - 1)) + 1;
    const end = text.indexOf("\n", idx + m[0].length);
    out.push({ id: rule.id, evidence: text.slice(start, end === -1 ? undefined : end).slice(0, 500), ...d });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
}

/** Applies a file_edit fix to file content. Returns null when the file changed since the diagnosis. */
export function applyFileFix(content: string, fix: AutoFix): string | null {
  if (fix.kind !== "file_edit" || fix.find == null || fix.replace == null) return null;
  if (!content.includes(fix.find)) return null;
  return content.replace(fix.find, fix.replace);
}
