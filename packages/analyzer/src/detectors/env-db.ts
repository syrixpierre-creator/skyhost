import { parse as parseYaml } from "yaml";
import type { AnalysisResult, ComposeService, DetectedDatabase, DetectedVariable, RepoFS } from "../types";
import { walkSources } from "../fs";
import { readJson } from "../util";
import { readPythonDeps } from "./python";

/** Variables managed by SKYHOST or the runtime: never ask the user for them. */
const BUILTIN_VARS = new Set([
  "PORT", "NODE_ENV", "HOST", "HOSTNAME", "PATH", "HOME", "PWD", "CI", "TZ", "LANG", "SHELL", "USER", "TERM",
  "PYTHONUNBUFFERED", "PYTHONPATH", "VERCEL", "NEXT_RUNTIME", "SKYHOST", "SKYHOST_SERVICE", "SKYHOST_ENVIRONMENT",
  "SKYHOST_DEPLOYMENT_ID", "SKYHOST_GIT_COMMIT", "SKYHOST_PUBLIC_URL", "npm_package_version", "BASE_URL", "MODE", "DEV", "PROD", "SSR",
]);

const ENV_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist", "example.env", ".env.local.example"];

export async function detectEnvironmentVariables(fs: RepoFS, r: AnalysisResult): Promise<void> {
  const found = new Map<string, DetectedVariable>();
  const add = (v: DetectedVariable) => {
    if (BUILTIN_VARS.has(v.key) || !/^[A-Z_][A-Z0-9_]*$/.test(v.key)) return;
    const prev = found.get(v.key);
    if (!prev) found.set(v.key, v);
    else if (prev.defaultValue === undefined && v.defaultValue !== undefined) prev.defaultValue = v.defaultValue;
  };

  for (const file of ENV_FILES) {
    const content = await fs.readFile(file);
    if (content == null) continue;
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2]!.replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
      // Placeholder values are never pre-filled: the user must supply the real one.
      const placeholder = !value || /^(your|change|xxx|<|\.\.\.|replace|todo|secret$|password$|changeme)/i.test(value);
      add({ key: m[1]!, defaultValue: placeholder ? undefined : value, required: placeholder, source: file });
    }
    r.reasons.push(`Read variable names from ${file}.`);
  }

  // README: KEY=value lines inside code blocks
  const readme = (await fs.readFile("README.md")) ?? (await fs.readFile("readme.md"));
  if (readme) {
    for (const block of readme.matchAll(/```(?:env|bash|sh|dotenv|shell)?\n([\s\S]*?)```/g)) {
      for (const line of block[1]!.split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(\S*)\s*$/.exec(line);
        if (m) add({ key: m[1]!, required: true, source: "README.md" });
      }
    }
  }

  // Source code references
  const files = await walkSources(fs, [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".py", ".go", ".rs", ".php", ".java", ".rb", ".vue", ".svelte"], 300, 8);
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g,
    /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
    /os\.environ(?:\.get)?\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /os\.environ\[["']([A-Z_][A-Z0-9_]*)["']\]/g,
    /os\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g,
    /env::var\("([A-Z_][A-Z0-9_]*)"\)/g,
    /\benv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /System\.getenv\("([A-Z_][A-Z0-9_]*)"\)/g,
    /ENV\[["']([A-Z_][A-Z0-9_]*)["']\]/g,
  ];
  for (const f of files) {
    if (/\.(test|spec)\./.test(f)) continue;
    const code = await fs.readFile(f);
    if (!code) continue;
    for (const re of patterns) {
      for (const m of code.matchAll(re)) {
        const key = m[1]!;
        // A default in code (`|| "x"`, `or "x"`, getenv("X", "y")) means the variable is optional.
        const after = code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30);
        const optional = /^\s*(\)|\])?\s*(\|\||\?\?|or\b|,\s*["'])/.test(after);
        add({ key, required: !optional, source: f });
      }
    }
  }
  r.environmentVariables = [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const NODE_DB: Array<[string, DetectedDatabase["engine"], string?]> = [
  ["pg", "postgres", "DATABASE_URL"],
  ["postgres", "postgres", "DATABASE_URL"],
  ["pg-promise", "postgres", "DATABASE_URL"],
  ["@neondatabase/serverless", "postgres", "DATABASE_URL"],
  ["mysql2", "mariadb", "DATABASE_URL"],
  ["mysql", "mariadb", "DATABASE_URL"],
  ["mariadb", "mariadb", "DATABASE_URL"],
  ["mongoose", "mongodb", "MONGODB_URI"],
  ["mongodb", "mongodb", "MONGODB_URI"],
  ["redis", "redis", "REDIS_URL"],
  ["ioredis", "redis", "REDIS_URL"],
  ["bullmq", "redis", "REDIS_URL"],
  ["bull", "redis", "REDIS_URL"],
];

const PY_DB: Array<[string, DetectedDatabase["engine"], string?]> = [
  ["psycopg2", "postgres", "DATABASE_URL"],
  ["psycopg2-binary", "postgres", "DATABASE_URL"],
  ["psycopg", "postgres", "DATABASE_URL"],
  ["asyncpg", "postgres", "DATABASE_URL"],
  ["dj-database-url", "postgres", "DATABASE_URL"],
  ["mysqlclient", "mariadb", "DATABASE_URL"],
  ["pymysql", "mariadb", "DATABASE_URL"],
  ["pymongo", "mongodb", "MONGODB_URI"],
  ["motor", "mongodb", "MONGODB_URI"],
  ["mongoengine", "mongodb", "MONGODB_URI"],
  ["redis", "redis", "REDIS_URL"],
  ["celery", "redis", "REDIS_URL"],
  ["rq", "redis", "REDIS_URL"],
];

const TEXT_DB: Array<[RegExp, DetectedDatabase["engine"], string]> = [
  [/github\.com\/lib\/pq|github\.com\/jackc\/pgx/, "postgres", "go.mod"],
  [/github\.com\/go-sql-driver\/mysql/, "mariadb", "go.mod"],
  [/go\.mongodb\.org\/mongo-driver/, "mongodb", "go.mod"],
  [/github\.com\/(go-redis|redis)\/(redis|go-redis)/, "redis", "go.mod"],
];

export async function detectDatabases(fs: RepoFS, r: AnalysisResult): Promise<void> {
  const out = new Map<string, DetectedDatabase>();
  const add = (d: DetectedDatabase) => {
    if (!out.has(d.engine)) out.set(d.engine, d);
  };
  const pkg = await readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(fs, "package.json");
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}) };
    for (const [dep, engine, variable] of NODE_DB) if (dep in deps) add({ engine, reason: `package.json depends on ${dep}`, variable });
    if ("@prisma/client" in deps || "prisma" in (pkg.devDependencies ?? {})) {
      const schema = (await fs.readFile("prisma/schema.prisma")) ?? (await fs.readFile("schema.prisma")) ?? "";
      const provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/.exec(schema)?.[1];
      const urlVar = /url\s*=\s*env\("([A-Z_]+)"\)/.exec(schema)?.[1] ?? "DATABASE_URL";
      const map: Record<string, DetectedDatabase["engine"]> = { postgresql: "postgres", postgres: "postgres", mysql: "mariadb", mongodb: "mongodb" };
      if (provider && map[provider]) add({ engine: map[provider], reason: `Prisma datasource provider is ${provider}`, variable: urlVar });
    }
    for (const orm of ["typeorm", "sequelize", "knex", "drizzle-orm"]) {
      if (orm in deps && !out.size) r.warnings.push(`${orm} is used but no database driver was found in dependencies.`);
    }
  }
  const py = await readPythonDeps(fs);
  if (py) {
    for (const [dep, engine, variable] of PY_DB) if (py.names.has(dep)) add({ engine, reason: `Python dependency ${dep}`, variable });
    if (py.names.has("sqlalchemy") || py.names.has("django")) {
      const files = await walkSources(fs, [".py"], 150, 4);
      for (const f of files) {
        const code = (await fs.readFile(f)) ?? "";
        if (/postgresql(\+\w+)?:\/\/|django\.db\.backends\.postgresql/.test(code)) add({ engine: "postgres", reason: `${f} configures PostgreSQL`, variable: "DATABASE_URL" });
        if (/mysql(\+\w+)?:\/\/|django\.db\.backends\.mysql/.test(code)) add({ engine: "mariadb", reason: `${f} configures MySQL`, variable: "DATABASE_URL" });
      }
    }
  }
  const gomod = await fs.readFile("go.mod");
  if (gomod) for (const [re, engine, src] of TEXT_DB) if (re.test(gomod)) add({ engine, reason: `${src} requires a ${engine} driver` });
  const cargo = await fs.readFile("Cargo.toml");
  if (cargo) {
    if (/sqlx[\s\S]{0,200}postgres|tokio-postgres|diesel[\s\S]{0,100}postgres/.test(cargo)) add({ engine: "postgres", reason: "Cargo.toml uses a PostgreSQL driver", variable: "DATABASE_URL" });
    if (/\bredis\s*=/.test(cargo)) add({ engine: "redis", reason: "Cargo.toml depends on redis", variable: "REDIS_URL" });
    if (/\bmongodb\s*=/.test(cargo)) add({ engine: "mongodb", reason: "Cargo.toml depends on mongodb", variable: "MONGODB_URI" });
  }
  const composer = await fs.readFile("composer.json");
  if (composer) {
    const env = (await fs.readFile(".env.example")) ?? "";
    const conn = /DB_CONNECTION=(\w+)/.exec(env)?.[1];
    if (conn === "pgsql") add({ engine: "postgres", reason: ".env.example sets DB_CONNECTION=pgsql", variable: "DATABASE_URL" });
    if (conn === "mysql" || conn === "mariadb") add({ engine: "mariadb", reason: `.env.example sets DB_CONNECTION=${conn}`, variable: "DATABASE_URL" });
    if (/predis|phpredis|REDIS_HOST/.test(composer + env)) add({ engine: "redis", reason: "Redis configuration found", variable: "REDIS_URL" });
  }
  const pom = (await fs.readFile("pom.xml")) ?? (await fs.readFile("build.gradle")) ?? (await fs.readFile("build.gradle.kts"));
  if (pom) {
    if (/org\.postgresql|postgresql<\/artifactId>|org\.postgresql:postgresql/.test(pom)) add({ engine: "postgres", reason: "PostgreSQL JDBC driver", variable: "DATABASE_URL" });
    if (/mariadb-java-client|mysql-connector/.test(pom)) add({ engine: "mariadb", reason: "MySQL/MariaDB JDBC driver", variable: "DATABASE_URL" });
    if (/spring-boot-starter-data-mongodb/.test(pom)) add({ engine: "mongodb", reason: "Spring Data MongoDB", variable: "MONGODB_URI" });
    if (/spring-boot-starter-data-redis/.test(pom)) add({ engine: "redis", reason: "Spring Data Redis", variable: "REDIS_URL" });
  }
  // Variables in .env.example are a strong signal too
  for (const v of r.environmentVariables) {
    if (/^(DATABASE_URL|POSTGRES_URL|PG_URL)$/.test(v.key) && !out.size) add({ engine: "postgres", reason: `${v.source} expects ${v.key}`, variable: v.key });
    if (/^(MONGO_URL|MONGODB_URI|MONGO_URI)$/.test(v.key)) add({ engine: "mongodb", reason: `${v.source} expects ${v.key}`, variable: v.key });
    if (/^REDIS_URL$/.test(v.key)) add({ engine: "redis", reason: `${v.source} expects ${v.key}`, variable: v.key });
  }
  r.databaseDetected = [...out.values()];
  for (const d of r.databaseDetected) r.reasons.push(`Needs a ${d.engine} database (${d.reason}).`);
}

const IMAGE_DB: Array<[RegExp, DetectedDatabase["engine"]]> = [
  [/^(postgres|postgis\/postgis|bitnami\/postgresql)(:|$)/, "postgres"],
  [/^(mysql|mariadb|bitnami\/mariadb)(:|$)/, "mariadb"],
  [/^(mongo|bitnami\/mongodb)(:|$)/, "mongodb"],
  [/^(redis|valkey\/valkey|bitnami\/redis)(:|$)/, "redis"],
];

export async function detectCompose(fs: RepoFS, r: AnalysisResult): Promise<void> {
  const file = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  let content: string | null = null;
  let name = "";
  for (const f of file) {
    content = await fs.readFile(f);
    if (content != null) {
      name = f;
      break;
    }
  }
  if (content == null) return;
  let doc: { services?: Record<string, Record<string, unknown>> };
  try {
    doc = parseYaml(content, { maxAliasCount: 50 }) ?? {};
  } catch {
    r.warnings.push(`${name} could not be parsed.`);
    return;
  }
  const services: ComposeService[] = [];
  for (const [svcName, svc] of Object.entries(doc.services ?? {})) {
    const image = typeof svc.image === "string" ? svc.image : undefined;
    let build: ComposeService["build"];
    if (typeof svc.build === "string") build = { context: svc.build };
    else if (svc.build && typeof svc.build === "object") {
      const b = svc.build as { context?: string; dockerfile?: string };
      build = { context: b.context ?? ".", dockerfile: b.dockerfile };
    }
    const ports: number[] = [];
    for (const p of (svc.ports as unknown[]) ?? []) {
      const s = typeof p === "object" && p ? String((p as { target?: number }).target ?? "") : String(p);
      const container = Number(s.split(":").at(-1)?.split("/")[0]);
      if (container) ports.push(container);
    }
    for (const p of (svc.expose as unknown[]) ?? []) if (Number(p)) ports.push(Number(p));
    const environment: Record<string, string> = {};
    if (Array.isArray(svc.environment)) {
      for (const e of svc.environment as string[]) {
        const [k, ...v] = String(e).split("=");
        if (k) environment[k] = v.join("=");
      }
    } else if (svc.environment && typeof svc.environment === "object") {
      for (const [k, v] of Object.entries(svc.environment)) environment[k] = v == null ? "" : String(v);
    }
    const dependsOn = Array.isArray(svc.depends_on) ? (svc.depends_on as string[]) : svc.depends_on ? Object.keys(svc.depends_on) : [];
    const managed = image ? IMAGE_DB.find(([re]) => re.test(image))?.[1] : undefined;
    // Host level options are deliberately ignored: privileged, volumes with host paths, network_mode, pid, devices.
    if (svc.privileged || svc.network_mode === "host" || svc.pid === "host") r.warnings.push(`Service ${svcName} requests host-level access (privileged/host network), which SKYHOST never grants.`);
    for (const v of (svc.volumes as unknown[]) ?? []) {
      const s = typeof v === "string" ? v : "";
      if (s.includes("docker.sock") || s.startsWith("/")) r.warnings.push(`Service ${svcName} mounts a host path (${s.split(":")[0]}); host mounts are not supported, use a SKYHOST volume.`);
    }
    services.push({
      name: svcName,
      image,
      build,
      ports,
      environment,
      dependsOn,
      managedDatabase: managed,
      command: typeof svc.command === "string" ? svc.command : Array.isArray(svc.command) ? (svc.command as string[]).join(" ") : undefined,
    });
  }
  if (services.length) {
    r.compose = services;
    r.reasons.push(`Found ${name} with ${services.length} services (${services.map((s) => s.name).join(", ")}).`);
    for (const s of services) {
      if (s.managedDatabase && !r.databaseDetected.some((d) => d.engine === s.managedDatabase)) {
        r.databaseDetected.push({ engine: s.managedDatabase, reason: `${name} service "${s.name}" uses ${s.image}` });
      }
    }
  }
}
