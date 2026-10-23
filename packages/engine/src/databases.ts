import { createHash } from "node:crypto";
import type { DatabaseEngine } from "@skyhost/shared";
import { engineConfig } from "./config";
import { ensureImage, execInContainer, getDocker, LABEL, names, removeContainer } from "./docker";
import { createAndStart, SAFE_CAPS } from "./runtime";
import { PassThrough } from "node:stream";
import tar from "tar-stream";

export interface DatabaseSpec {
  id: string;
  teamId: string;
  projectId: string;
  engine: DatabaseEngine;
  version: string;
  dbName: string;
  username: string;
  password: string;
  storageMb: number;
  network: string;
  /** DNS name inside the team network (e.g. "db" -> reachable as db and db.internal). */
  alias: string;
  memoryMb?: number;
  cpu?: number;
}

export const DB_PORTS: Record<DatabaseEngine, number> = { postgres: 5432, mariadb: 3306, mongodb: 27017, redis: 6379 };

const IMAGES: Record<DatabaseEngine, (v: string) => string> = {
  postgres: (v) => `postgres:${v}-alpine`,
  mariadb: (v) => `mariadb:${v}`,
  mongodb: (v) => `mongo:${v}`,
  redis: (v) => `redis:${v}-alpine`,
};

const DATA_DIRS: Record<DatabaseEngine, string> = {
  postgres: "/var/lib/postgresql/data",
  mariadb: "/var/lib/mysql",
  mongodb: "/data/db",
  redis: "/data",
};

/** Generated credentials only use [A-Za-z0-9]; enforcing it keeps every command below injection-free. */
function assertSafe(...values: string[]) {
  for (const v of values) if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error("Unsafe database identifier or credential");
}

/** Root/admin password derived from the stored password, so it never needs its own storage. */
export function adminPassword(password: string) {
  return createHash("sha256").update(`${password}:skyhost-admin`).digest("hex").slice(0, 32);
}
const roPassword = (password: string) => createHash("sha256").update(`${password}:skyhost-ro`).digest("hex").slice(0, 32);

export function connectionUrl(engine: DatabaseEngine, o: { host: string; port: number; username: string; password: string; dbName: string }): string {
  const auth = `${encodeURIComponent(o.username)}:${encodeURIComponent(o.password)}`;
  switch (engine) {
    case "postgres":
      return `postgresql://${auth}@${o.host}:${o.port}/${o.dbName}`;
    case "mariadb":
      return `mysql://${auth}@${o.host}:${o.port}/${o.dbName}`;
    case "mongodb":
      return `mongodb://${auth}@${o.host}:${o.port}/${o.dbName}?authSource=admin`;
    case "redis":
      return `redis://default:${encodeURIComponent(o.password)}@${o.host}:${o.port}`;
  }
}

/** Variables exposed to services connected to a database and available as ${{name.KEY}} references. */
export function databaseVariables(engine: DatabaseEngine, o: { host: string; port: number; username: string; password: string; dbName: string }, varName?: string): Record<string, string> {
  const url = connectionUrl(engine, o);
  const main = varName ?? (engine === "mongodb" ? "MONGODB_URI" : engine === "redis" ? "REDIS_URL" : "DATABASE_URL");
  const base: Record<string, string> = {
    [main]: url,
    DB_HOST: o.host,
    DB_PORT: String(o.port),
    DB_USER: o.username,
    DB_PASSWORD: o.password,
    DB_NAME: o.dbName,
  };
  if (engine === "postgres") Object.assign(base, { PGHOST: o.host, PGPORT: String(o.port), PGUSER: o.username, PGPASSWORD: o.password, PGDATABASE: o.dbName });
  if (main !== "DATABASE_URL" && engine !== "redis" && engine !== "mongodb") base.DATABASE_URL = url;
  return base;
}

function containerEnv(spec: DatabaseSpec): { env: Record<string, string>; args?: string[] } {
  const admin = adminPassword(spec.password);
  switch (spec.engine) {
    case "postgres":
      return { env: { POSTGRES_USER: spec.username, POSTGRES_PASSWORD: spec.password, POSTGRES_DB: spec.dbName, PGDATA: "/var/lib/postgresql/data/pgdata" } };
    case "mariadb":
      return { env: { MARIADB_USER: spec.username, MARIADB_PASSWORD: spec.password, MARIADB_DATABASE: spec.dbName, MARIADB_ROOT_PASSWORD: admin, MARIADB_AUTO_UPGRADE: "1" } };
    case "mongodb":
      return { env: { MONGO_INITDB_ROOT_USERNAME: spec.username, MONGO_INITDB_ROOT_PASSWORD: spec.password, MONGO_INITDB_DATABASE: spec.dbName } };
    case "redis":
      // RDB snapshots make backup/restore a simple file copy.
      return { env: {}, args: ["redis-server", "--requirepass", spec.password, "--save", "60", "1", "--appendonly", "no", "--dir", "/data"] };
  }
}

export async function provisionDatabase(spec: DatabaseSpec, onLine: (l: string) => void = () => {}): Promise<{ container: string; volume: string; host: string; port: number }> {
  assertSafe(spec.dbName, spec.username, spec.password);
  const d = getDocker();
  const image = IMAGES[spec.engine](spec.version);
  onLine(`Pulling ${image}`);
  await ensureImage(image, onLine);
  const volume = names.dbVolume(spec.id);
  const container = names.dbContainer(spec.id);
  await d.createVolume({ Name: volume, Labels: { [LABEL.managed]: "true", [LABEL.database]: spec.id, [LABEL.team]: spec.teamId } }).catch((e: Error) => {
    if (!/already exists/.test(e.message)) throw e;
  });
  const { env, args } = containerEnv(spec);
  await createAndStart({
    name: container,
    image,
    env,
    args,
    network: spec.network,
    networkLabels: { [LABEL.team]: spec.teamId },
    aliases: [spec.alias, `${spec.alias}.internal`, container],
    labels: { [LABEL.kind]: "database", [LABEL.database]: spec.id, [LABEL.team]: spec.teamId, [LABEL.project]: spec.projectId },
    cpu: spec.cpu ?? 1,
    memoryMb: spec.memoryMb ?? 512,
    pidsLimit: 1024,
    volumes: [{ dockerVolume: volume, mountPath: DATA_DIRS[spec.engine] }],
    restart: "always",
    capAdd: SAFE_CAPS,
    // Official database images need a standard runtime unless gVisor is configured to support them.
    runtime: process.env.SKYHOST_DATABASE_RUNTIME ?? engineConfig().runtime,
  });
  onLine("Waiting for the database to accept connections");
  await waitDatabaseReady(spec, container);
  await createReadOnlyUser(spec, container).catch((e) => onLine(`Read-only browser user not created: ${(e as Error).message}`));
  onLine("Database is ready");
  return { container, volume, host: spec.alias, port: DB_PORTS[spec.engine] };
}

function probeCommand(spec: Pick<DatabaseSpec, "engine" | "username" | "password" | "dbName">): string[] {
  switch (spec.engine) {
    case "postgres":
      // Uses TCP (not the socket) so it only succeeds once init scripts are done and the real server is up.
      return ["psql", "-h", "127.0.0.1", "-U", spec.username, "-d", spec.dbName, "-tAc", "select 1"];
    case "mariadb":
      return ["mariadb", "-h", "127.0.0.1", "-u", spec.username, `-p${spec.password}`, "-e", "select 1", spec.dbName];
    case "mongodb":
      return ["mongosh", "--quiet", "--host", "127.0.0.1", "-u", spec.username, "-p", spec.password, "--authenticationDatabase", "admin", "--eval", "db.runCommand({ping:1}).ok"];
    case "redis":
      return ["redis-cli", "-a", spec.password, "--no-auth-warning", "ping"];
  }
}

export async function waitDatabaseReady(spec: Pick<DatabaseSpec, "engine" | "username" | "password" | "dbName">, container: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const res = await execInContainer(container, probeCommand(spec), { env: [`PGPASSWORD=${spec.password}`], timeoutMs: 10_000 }).catch((e) => ({ exitCode: -1, stdout: Buffer.from(""), stderr: Buffer.from((e as Error).message) }));
    if (res.exitCode === 0) return;
    last = res.stderr.toString().trim().split("\n").at(-1) ?? "";
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Database did not become ready: ${last}`);
}

async function createReadOnlyUser(spec: DatabaseSpec, container: string) {
  const ro = roPassword(spec.password);
  switch (spec.engine) {
    case "postgres":
      await psql(container, spec, `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'skyhost_ro') THEN CREATE ROLE skyhost_ro LOGIN PASSWORD '${ro}'; END IF; END $$; GRANT pg_read_all_data TO skyhost_ro;`);
      break;
    case "mariadb":
      await mariadbExec(container, spec, `CREATE USER IF NOT EXISTS 'skyhost_ro'@'localhost' IDENTIFIED BY '${ro}'; GRANT SELECT, SHOW VIEW ON \`${spec.dbName}\`.* TO 'skyhost_ro'@'localhost'; FLUSH PRIVILEGES;`, true);
      break;
    case "mongodb":
      await execInContainer(container, ["mongosh", "--quiet", "-u", spec.username, "-p", spec.password, "--authenticationDatabase", "admin", "--eval",
        `const a = db.getSiblingDB('admin'); if (!a.getUser('skyhost_ro')) a.createUser({user:'skyhost_ro', pwd:'${ro}', roles:[{role:'read', db:'${spec.dbName}'}]});`], { timeoutMs: 20_000 });
      break;
    case "redis":
      break;
  }
}

async function psql(container: string, spec: Pick<DatabaseSpec, "username" | "password" | "dbName">, sql: string, extra: string[] = []) {
  const res = await execInContainer(container, ["psql", "-v", "ON_ERROR_STOP=1", "-U", spec.username, "-d", spec.dbName, ...extra, "-c", sql], { env: [`PGPASSWORD=${spec.password}`], timeoutMs: 30_000 });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "psql failed");
  return res.stdout.toString();
}

async function mariadbExec(container: string, spec: Pick<DatabaseSpec, "username" | "password" | "dbName">, sql: string, asRoot = false) {
  const user = asRoot ? "root" : spec.username;
  const pass = asRoot ? adminPassword(spec.password) : spec.password;
  const res = await execInContainer(container, ["mariadb", "-u", user, `-p${pass}`, "-e", sql], { timeoutMs: 30_000 });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "mariadb failed");
  return res.stdout.toString();
}

// ---------------------------------------------------------------------------------------------------------------
// Backup & restore
// ---------------------------------------------------------------------------------------------------------------

export interface DbRef {
  engine: DatabaseEngine;
  container: string;
  username: string;
  password: string;
  dbName: string;
}

/** Produces a logical dump of the database. The caller encrypts and stores it. */
export async function backupDatabase(db: DbRef): Promise<Buffer> {
  assertSafe(db.username, db.password, db.dbName);
  const timeoutMs = 60 * 60 * 1000;
  let res;
  switch (db.engine) {
    case "postgres":
      res = await execInContainer(db.container, ["pg_dump", "-U", db.username, "-d", db.dbName, "-Fc", "--no-owner"], { env: [`PGPASSWORD=${db.password}`], timeoutMs });
      break;
    case "mariadb":
      res = await execInContainer(db.container, ["mariadb-dump", "-u", db.username, `-p${db.password}`, "--single-transaction", "--routines", "--triggers", db.dbName], { timeoutMs });
      break;
    case "mongodb":
      res = await execInContainer(db.container, ["mongodump", "--quiet", "--archive", "--gzip", "-u", db.username, "-p", db.password, "--authenticationDatabase", "admin", "--db", db.dbName], { timeoutMs });
      break;
    case "redis": {
      const save = await execInContainer(db.container, ["redis-cli", "-a", db.password, "--no-auth-warning", "--rdb", "/tmp/skyhost-backup.rdb"], { timeoutMs });
      if (save.exitCode !== 0) throw new Error(save.stderr.toString() || "redis dump failed");
      res = await execInContainer(db.container, ["cat", "/tmp/skyhost-backup.rdb"], { timeoutMs });
      await execInContainer(db.container, ["rm", "-f", "/tmp/skyhost-backup.rdb"]).catch(() => {});
      break;
    }
  }
  if (res.exitCode !== 0) throw new Error(`Backup failed: ${res.stderr.toString().trim().slice(0, 500)}`);
  if (res.stdout.length === 0) throw new Error("Backup produced no data");
  return res.stdout;
}

export async function restoreDatabase(db: DbRef, dump: Buffer): Promise<void> {
  assertSafe(db.username, db.password, db.dbName);
  const timeoutMs = 60 * 60 * 1000;
  let res;
  switch (db.engine) {
    case "postgres":
      res = await execInContainer(db.container, ["pg_restore", "-U", db.username, "-d", db.dbName, "--clean", "--if-exists", "--no-owner", "--single-transaction"], { env: [`PGPASSWORD=${db.password}`], stdin: dump, timeoutMs });
      break;
    case "mariadb":
      res = await execInContainer(db.container, ["mariadb", "-u", db.username, `-p${db.password}`, db.dbName], { stdin: dump, timeoutMs });
      break;
    case "mongodb":
      res = await execInContainer(db.container, ["mongorestore", "--quiet", "--archive", "--gzip", "--drop", "-u", db.username, "-p", db.password, "--authenticationDatabase", "admin", `--nsInclude=${db.dbName}.*`], { stdin: dump, timeoutMs });
      break;
    case "redis": {
      // Replace the RDB file while the server is stopped, then start it again.
      const c = getDocker().getContainer(db.container);
      await c.stop({ t: 10 }).catch(() => {});
      const pack = tar.pack();
      pack.entry({ name: "dump.rdb", mode: 0o644, uid: 999, gid: 1000 }, dump);
      pack.finalize();
      const pt = new PassThrough();
      pack.pipe(pt);
      await c.putArchive(pt, { path: "/data" });
      await c.start();
      await waitDatabaseReady({ engine: "redis", username: db.username, password: db.password, dbName: db.dbName }, db.container);
      return;
    }
  }
  if (res.exitCode !== 0) throw new Error(`Restore failed: ${res.stderr.toString().trim().slice(0, 1000)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Data browser (read-only)
// ---------------------------------------------------------------------------------------------------------------

export interface QueryResult {
  columns: string[];
  rows: Array<Array<string | null>>;
  truncated: boolean;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MAX_ROWS = 500;

/** Runs a read-only SQL query as the dedicated read-only role. Writes are rejected by the database itself. */
export async function querySql(db: DbRef, sql: string): Promise<QueryResult> {
  if (sql.length > 20_000) throw new Error("Query is too long");
  const ro = roPassword(db.password);
  if (db.engine === "postgres") {
    const res = await execInContainer(db.container, ["psql", "-h", "127.0.0.1", "-U", "skyhost_ro", "-d", db.dbName, "--csv", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      env: [`PGPASSWORD=${ro}`, "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000"],
      timeoutMs: 20_000,
      maxOutput: 10 * 1024 * 1024,
    });
    if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim().replace(/^psql:[^:]*:\d+: /, ""));
    const [head = [], ...rows] = parseCsv(res.stdout.toString());
    return { columns: head, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
  }
  if (db.engine === "mariadb") {
    const res = await execInContainer(db.container, ["mariadb", "-u", "skyhost_ro", `-p${ro}`, "--batch", "--raw", "-e", `SET SESSION TRANSACTION READ ONLY; SET SESSION max_statement_time=15; ${sql}`, db.dbName], { timeoutMs: 20_000, maxOutput: 10 * 1024 * 1024 });
    if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim());
    const lines = res.stdout.toString().split("\n").filter(Boolean);
    const [head = "", ...rows] = lines;
    return { columns: head.split("\t"), rows: rows.slice(0, MAX_ROWS).map((r) => r.split("\t").map((v) => (v === "NULL" ? null : v))), truncated: rows.length > MAX_ROWS };
  }
  throw new Error("SQL queries are only available for PostgreSQL and MariaDB");
}

export async function listTables(db: DbRef): Promise<string[]> {
  switch (db.engine) {
    case "postgres": {
      const r = await querySql(db, "select table_schema || '.' || table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1 limit 500");
      return r.rows.map((x) => x[0]!).filter(Boolean);
    }
    case "mariadb": {
      const r = await querySql(db, "SHOW TABLES");
      return r.rows.map((x) => x[0]!);
    }
    case "mongodb": {
      const out = await mongoEval(db, "EJSON.stringify(db.getCollectionNames().sort())");
      return JSON.parse(out) as string[];
    }
    case "redis": {
      const r = await redisCommand(db, ["SCAN", "0", "COUNT", "200"]);
      return r.split("\n").slice(1).filter(Boolean);
    }
  }
}

async function mongoEval(db: DbRef, script: string, env: string[] = []): Promise<string> {
  const ro = roPassword(db.password);
  const res = await execInContainer(db.container, ["mongosh", "--quiet", "-u", "skyhost_ro", "-p", ro, "--authenticationDatabase", "admin", db.dbName, "--eval", script], { env, timeoutMs: 20_000, maxOutput: 10 * 1024 * 1024 });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || res.stdout.toString().trim());
  return res.stdout.toString().trim();
}

/** Mongo find with user input passed through environment variables (never interpolated into the script). */
export async function queryMongo(db: DbRef, collection: string, filter: string, limit = 50): Promise<unknown[]> {
  JSON.parse(filter || "{}");
  if (!/^[\w.-]{1,120}$/.test(collection)) throw new Error("Invalid collection name");
  const script = "const f = EJSON.parse(process.env.SKY_FILTER || '{}'); print(EJSON.stringify(db.getCollection(process.env.SKY_COLL).find(f).limit(Number(process.env.SKY_LIMIT)).toArray()))";
  const out = await mongoEval(db, script, [`SKY_FILTER=${filter || "{}"}`, `SKY_COLL=${collection}`, `SKY_LIMIT=${Math.min(limit, MAX_ROWS)}`]);
  return JSON.parse(out || "[]") as unknown[];
}

const REDIS_READ_COMMANDS = new Set(["GET", "MGET", "HGETALL", "HGET", "LRANGE", "SMEMBERS", "ZRANGE", "TYPE", "TTL", "SCAN", "EXISTS", "STRLEN", "LLEN", "SCARD", "ZCARD", "HLEN", "DBSIZE", "INFO", "KEYS"]);

export async function redisCommand(db: DbRef, argv: string[]): Promise<string> {
  const cmd = argv[0]?.toUpperCase();
  if (!cmd || !REDIS_READ_COMMANDS.has(cmd)) throw new Error(`Only read commands are allowed (${[...REDIS_READ_COMMANDS].join(", ")})`);
  if (cmd === "KEYS" && argv[1] === "*") argv = ["SCAN", "0", "COUNT", "200"];
  const res = await execInContainer(db.container, ["redis-cli", "-a", db.password, "--no-auth-warning", ...argv], { timeoutMs: 15_000, maxOutput: 5 * 1024 * 1024 });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim());
  return res.stdout.toString();
}

// ---------------------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------------------

export async function databaseStats(db: DbRef): Promise<{ sizeBytes: number; connections: number }> {
  try {
    switch (db.engine) {
      case "postgres": {
        const out = await psql(db.container, db, "select pg_database_size(current_database()), (select count(*) from pg_stat_activity where datname = current_database())", ["-tA", "-F", ","]);
        const [size, conns] = out.trim().split(",");
        return { sizeBytes: Number(size), connections: Number(conns) };
      }
      case "mariadb": {
        const out = await mariadbExec(db.container, db, `SELECT COALESCE(SUM(data_length+index_length),0) FROM information_schema.tables WHERE table_schema='${db.dbName}'; SHOW STATUS LIKE 'Threads_connected';`);
        const lines = out.trim().split("\n");
        return { sizeBytes: Number(lines[1] ?? 0), connections: Number(lines.at(-1)?.split("\t")[1] ?? 0) };
      }
      case "mongodb": {
        const res = await execInContainer(db.container, ["mongosh", "--quiet", "-u", db.username, "-p", db.password, "--authenticationDatabase", "admin", db.dbName, "--eval", "print(JSON.stringify({s: db.stats().totalSize ?? db.stats().storageSize, c: db.serverStatus().connections.current}))"], { timeoutMs: 15_000 });
        const j = JSON.parse(res.stdout.toString().trim() || "{}") as { s?: number; c?: number };
        return { sizeBytes: j.s ?? 0, connections: j.c ?? 0 };
      }
      case "redis": {
        const out = await execInContainer(db.container, ["redis-cli", "-a", db.password, "--no-auth-warning", "INFO"], { timeoutMs: 10_000 });
        const t = out.stdout.toString();
        return { sizeBytes: Number(/used_memory:(\d+)/.exec(t)?.[1] ?? 0), connections: Number(/connected_clients:(\d+)/.exec(t)?.[1] ?? 0) };
      }
    }
  } catch {
    return { sizeBytes: 0, connections: 0 };
  }
}

/** Rotates the application password. Redis is recreated because the password is part of its command line. */
export async function rotatePassword(spec: DatabaseSpec, container: string, newPassword: string): Promise<void> {
  assertSafe(newPassword);
  switch (spec.engine) {
    case "postgres":
      await psql(container, spec, `ALTER USER "${spec.username}" WITH PASSWORD '${newPassword}'`);
      await psql(container, spec, `ALTER ROLE skyhost_ro WITH PASSWORD '${roPassword(newPassword)}'`).catch(() => {});
      break;
    case "mariadb":
      await mariadbExec(container, spec, `ALTER USER '${spec.username}'@'%' IDENTIFIED BY '${newPassword}'; ALTER USER 'skyhost_ro'@'localhost' IDENTIFIED BY '${roPassword(newPassword)}'; ALTER USER 'root'@'%' IDENTIFIED BY '${adminPassword(newPassword)}'; ALTER USER 'root'@'localhost' IDENTIFIED BY '${adminPassword(newPassword)}'; FLUSH PRIVILEGES;`, true);
      break;
    case "mongodb":
      await execInContainer(container, ["mongosh", "--quiet", "-u", spec.username, "-p", spec.password, "--authenticationDatabase", "admin", "admin", "--eval",
        `db.changeUserPassword('${spec.username}', '${newPassword}'); if (db.getUser('skyhost_ro')) db.changeUserPassword('skyhost_ro', '${roPassword(newPassword)}');`], { timeoutMs: 20_000 });
      break;
    case "redis":
      await removeContainer(container, { graceSeconds: 10 });
      await provisionDatabase({ ...spec, password: newPassword });
      return;
  }
}

export async function deleteDatabase(dbId: string, opts: { keepVolume?: boolean } = {}) {
  await removeContainer(names.dbProxy(dbId), { graceSeconds: 1 });
  await removeContainer(names.dbContainer(dbId), { graceSeconds: 10 });
  if (!opts.keepVolume) await getDocker().getVolume(names.dbVolume(dbId)).remove().catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------
// Public access: a tiny TCP proxy sidecar with an IP allowlist, published on a host port.
// ---------------------------------------------------------------------------------------------------------------

const TCP_PROXY = `
const net = require("net");
const allow = (process.env.ALLOW || "").split(",").map(s => s.trim()).filter(Boolean);
const toInt = ip => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const allowed = ip => {
  ip = ip.replace(/^::ffff:/, "");
  if (!allow.length) return false;
  return allow.some(r => {
    if (r === "0.0.0.0/0") return true;
    const [base, bits = "32"] = r.split("/");
    const m = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return ip.includes(".") && (toInt(ip) & m) === (toInt(base) & m);
  });
};
net.createServer(c => {
  if (!allowed(c.remoteAddress || "")) { c.destroy(); return; }
  const u = net.connect(Number(process.env.TARGET_PORT), process.env.TARGET_HOST);
  c.pipe(u).pipe(c);
  c.on("error", () => u.destroy()); u.on("error", () => c.destroy());
}).listen(Number(process.env.LISTEN_PORT), "0.0.0.0");
`;

export async function enablePublicAccess(o: { dbId: string; teamId: string; network: string; targetHost: string; targetPort: number; hostPort: number; allowlist: string[] }) {
  await ensureImage("node:22-alpine");
  await createAndStart({
    name: names.dbProxy(o.dbId),
    image: "node:22-alpine",
    env: { ALLOW: o.allowlist.join(","), TARGET_HOST: o.targetHost, TARGET_PORT: String(o.targetPort), LISTEN_PORT: String(o.targetPort), SCRIPT: TCP_PROXY },
    command: 'exec node -e "$SCRIPT"',
    network: o.network,
    networkLabels: { [LABEL.team]: o.teamId },
    aliases: [],
    labels: { [LABEL.kind]: "db-proxy", [LABEL.database]: o.dbId, [LABEL.team]: o.teamId },
    cpu: 0.25,
    memoryMb: 64,
    user: "1000",
    capAdd: [],
    restart: "always",
    publish: { containerPort: o.targetPort, hostPort: o.hostPort },
  });
}

export async function disablePublicAccess(dbId: string) {
  await removeContainer(names.dbProxy(dbId), { graceSeconds: 1 });
}
