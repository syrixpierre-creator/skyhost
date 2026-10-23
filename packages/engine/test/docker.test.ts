import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeRepository, localFS } from "@skyhost/analyzer";
import { generateMasterKey, parseKeyring, randomPassword, setKeyring } from "@skyhost/shared/node";
import {
  backupDatabase, buildImage, cloneRepository, containerIp, createAndStart, deleteDatabase, ensureNetwork, getDocker, HealthcheckError,
  listTables, names, provisionDatabase, provisionBucket, setBucketVisibility, bucketUsageBytes, presignUrl, deleteBucket, querySql, queryMongo, removeContainer, restoreDatabase, runJob, runShellCommand, setEngineConfig, waitHealthy, redisCommand,
} from "../src";

const hasDocker = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const d = describe.skipIf(!hasDocker);
const TEAM = "00000000-0000-4000-8000-0000000000e1";
const net = names.teamNetwork(TEAM);
const cleanup: string[] = [];

function get(host: string, port: number, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host, port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });
}

beforeAll(async () => {
  if (!hasDocker) return;
  setKeyring(parseKeyring(`k1:${generateMasterKey()}`));
  setEngineConfig({ runtime: "runc", nofileLimit: Number(process.env.SKYHOST_NOFILE_LIMIT ?? 0), workDir: await mkdtemp(join(tmpdir(), "sh-eng-")), allowLocalGit: true, edgeContainers: [] });
  await ensureNetwork(net, { "skyhost.team": TEAM });
}, 60_000);

afterAll(async () => {
  for (const c of cleanup) await removeContainer(c, { graceSeconds: 1 });
});

d("build and run", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "sh-app-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "hello", scripts: { start: "node server.js", build: "node build.js" }, dependencies: {} }));
    await writeFile(join(repo, "package-lock.json"), JSON.stringify({ name: "hello", lockfileVersion: 3, requires: true, packages: { "": { name: "hello" } } }));
    await writeFile(join(repo, "build.js"), `require("fs").writeFileSync("built.txt", "built with " + (process.env.BUILD_FLAVOR || "none"));`);
    await writeFile(
      join(repo, "server.js"),
      `const http = require("http"); const fs = require("fs");
http.createServer((req, res) => res.end(JSON.stringify({ built: fs.readFileSync("built.txt", "utf8"), greeting: process.env.GREETING, user: process.getuid() }))).listen(process.env.PORT || 3000, "0.0.0.0");`,
    );
  });

  it("analyzes, builds with BuildKit secrets, runs hardened and passes the health check", async () => {
    const a = await analyzeRepository(localFS(repo));
    expect(a).toMatchObject({ runtime: "node", startCommand: "npm run start", port: 3000 });
    const lines: string[] = [];
    const image = "skyhost-test/hello:1";
    const res = await buildImage({
      repoDir: repo,
      image,
      cacheKey: "test-hello",
      labels: {},
      config: { runtime: a.runtime, runtimeVersion: "22", packageManager: a.packageManager, installCommand: a.installCommand, buildCommand: a.buildCommand, startCommand: a.startCommand, port: a.port },
      serviceType: "web",
      useDockerfile: false,
      buildEnv: { BUILD_FLAVOR: "secret-flavor-value" },
      onLine: (l) => lines.push(l),
    });
    expect(res.port).toBe(3000);
    // The build variable is never visible in the logs or image history.
    expect(lines.join("\n")).not.toContain("secret-flavor-value");
    const history = execFileSync("docker", ["history", "--no-trunc", image]).toString();
    expect(history).not.toContain("secret-flavor-value");

    const name = "sh-test-hello";
    cleanup.push(name);
    await createAndStart({ name, image, env: { PORT: "3000", GREETING: "hi" }, network: net, networkLabels: {}, aliases: ["hello", "hello.internal"], labels: {}, cpu: 0.5, memoryMb: 256 });
    await waitHealthy({ container: name, network: net, port: 3000, path: "/", intervalSeconds: 1, timeoutSeconds: 2, retries: 30 });
    const ip = (await containerIp(name, net))!;
    const body = JSON.parse((await get(ip, 3000)).body);
    expect(body).toEqual({ built: "built with secret-flavor-value", greeting: "hi", user: 1000 });

    const info = await getDocker().getContainer(name).inspect();
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.Mounts.some((m) => m.Source?.includes("docker.sock"))).toBe(false);

    // Secure shell runs inside the container, rejects disallowed commands.
    const out = await runShellCommand(name, "node --version", "node");
    expect(out.stdout.toString()).toMatch(/^v22\./);
    await expect(runShellCommand(name, "sh -c id", "node")).rejects.toThrow();

    // One-off job from the same image
    const job = await runJob({ id: "00000000-0000-4000-8000-00000000j0b1", image, command: "node -e \"console.log('job ok', process.env.X)\"", env: { X: "42" }, network: net, teamId: TEAM, serviceId: "s", cpu: 0.5, memoryMb: 128, timeoutSeconds: 60 });
    expect(job.exitCode).toBe(0);
    expect(job.output).toContain("job ok 42");
  }, 300_000);

  it("fails the health check when the app crashes", async () => {
    const name = "sh-test-crash";
    cleanup.push(name);
    await createAndStart({ name, image: "node:22-alpine", command: "echo boom >&2; exit 3", env: {}, network: net, networkLabels: {}, aliases: [], labels: {}, cpu: 0.2, memoryMb: 64, restart: "no" });
    const err = await waitHealthy({ container: name, network: net, port: 3000, path: "/", intervalSeconds: 1, timeoutSeconds: 1, retries: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(HealthcheckError);
    expect((err as HealthcheckError).message).toMatch(/exit code 3/);
    expect((err as HealthcheckError).logs).toContain("boom");
  }, 60_000);

  it("clones a git repository and reports the commit", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Ada", "-c", "user.email=a@x", "commit", "-qm", "first commit"]);
    const r = await cloneRepository({ url: repo, branch: "main" });
    expect(r.commit).toMatchObject({ author: "Ada", message: "first commit" });
    expect(r.commit.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

d("managed databases", () => {
  it("PostgreSQL: provision, connect, backup, restore, read-only browser", async () => {
    const id = "00000000-0000-4000-8000-0000000000d1";
    const password = randomPassword(24);
    await deleteDatabase(id);
    const spec = { id, teamId: TEAM, projectId: "p", engine: "postgres" as const, version: "16", dbName: "app", username: "app", password, storageMb: 512, network: net, alias: "maindb" };
    await provisionDatabase(spec);
    const container = names.dbContainer(id);
    cleanup.push(container);
    const ref = { engine: "postgres" as const, container, username: "app", password, dbName: "app" };
    const exec = (sql: string) => execFileSync("docker", ["exec", "-e", `PGPASSWORD=${password}`, container, "psql", "-U", "app", "-d", "app", "-tAc", sql]).toString().trim();
    exec("create table notes (id serial primary key, body text); insert into notes (body) values ('one'), ('two')");
    expect(await listTables(ref)).toContain("public.notes");
    const q = await querySql(ref, "select body from notes order by id");
    expect(q).toEqual({ columns: ["body"], rows: [["one"], ["two"]], truncated: false });
    // Writes are rejected by the database itself, even if the user tries to turn read-only off.
    await expect(querySql(ref, "delete from notes")).rejects.toThrow(/read-only|permission denied/);
    await expect(querySql(ref, "set default_transaction_read_only = off; delete from notes")).rejects.toThrow(/permission denied|read-only/);

    const dump = await backupDatabase(ref);
    expect(dump.subarray(0, 5).toString()).toBe("PGDMP");
    exec("delete from notes; insert into notes (body) values ('after-backup')");
    await restoreDatabase(ref, dump);
    expect(exec("select string_agg(body, ',' order by id) from notes")).toBe("one,two");
    await deleteDatabase(id);
  }, 240_000);

  it("Redis: provision, backup and restore", async () => {
    const id = "00000000-0000-4000-8000-0000000000d2";
    const password = randomPassword(24);
    await deleteDatabase(id);
    await provisionDatabase({ id, teamId: TEAM, projectId: "p", engine: "redis", version: "7.4", dbName: "0", username: "default", password, storageMb: 256, network: net, alias: "cache" });
    const container = names.dbContainer(id);
    cleanup.push(container);
    const ref = { engine: "redis" as const, container, username: "default", password, dbName: "0" };
    const cli = (...a: string[]) => execFileSync("docker", ["exec", container, "redis-cli", "-a", password, "--no-auth-warning", ...a]).toString().trim();
    cli("SET", "greeting", "hello");
    const dump = await backupDatabase(ref);
    expect(dump.subarray(0, 5).toString()).toBe("REDIS");
    cli("SET", "greeting", "changed");
    await restoreDatabase(ref, dump);
    expect(cli("GET", "greeting")).toBe("hello");
    expect((await redisCommand(ref, ["GET", "greeting"])).trim()).toBe("hello");
    await expect(redisCommand(ref, ["FLUSHALL"])).rejects.toThrow(/read commands/);
    await deleteDatabase(id);
  }, 120_000);
  it("MariaDB: provision, read-only browser, backup and restore", async () => {
    const id = "00000000-0000-4000-8000-0000000000d3";
    const password = randomPassword(24);
    await deleteDatabase(id);
    await provisionDatabase({ id, teamId: TEAM, projectId: "p", engine: "mariadb", version: "11.4", dbName: "app", username: "app", password, storageMb: 512, network: net, alias: "mdb" });
    const container = names.dbContainer(id);
    cleanup.push(container);
    const ref = { engine: "mariadb" as const, container, username: "app", password, dbName: "app" };
    const sql = (q: string) => execFileSync("docker", ["exec", container, "mariadb", "-u", "app", `-p${password}`, "-N", "-e", q, "app"]).toString().trim();
    sql("create table t (id int primary key, v varchar(20)); insert into t values (1,'a'),(2,'b')");
    expect((await querySql(ref, "select v from t order by id")).rows).toEqual([["a"], ["b"]]);
    await expect(querySql(ref, "delete from t")).rejects.toThrow();
    const dump = await backupDatabase(ref);
    sql("delete from t");
    await restoreDatabase(ref, dump);
    expect(sql("select group_concat(v order by id) from t")).toBe("a,b");
    await deleteDatabase(id);
  }, 240_000);

  it("MongoDB: provision, query, backup and restore", async () => {
    const id = "00000000-0000-4000-8000-0000000000d4";
    const password = randomPassword(24);
    await deleteDatabase(id);
    await provisionDatabase({ id, teamId: TEAM, projectId: "p", engine: "mongodb", version: "8.0", dbName: "app", username: "app", password, storageMb: 512, network: net, alias: "mongo" });
    const container = names.dbContainer(id);
    cleanup.push(container);
    const ref = { engine: "mongodb" as const, container, username: "app", password, dbName: "app" };
    const sh = (js: string) => execFileSync("docker", ["exec", container, "mongosh", "--quiet", "-u", "app", "-p", password, "--authenticationDatabase", "admin", "app", "--eval", js]).toString().trim();
    sh("db.items.insertMany([{n:1},{n:2}])");
    expect(await listTables(ref)).toEqual(["items"]);
    const docs = (await queryMongo(ref, "items", JSON.stringify({ n: { $gt: 1 } }))) as Array<{ n: number }>;
    expect(docs.map((x) => x.n)).toEqual([2]);
    const dump = await backupDatabase(ref);
    sh("db.items.deleteMany({})");
    await restoreDatabase(ref, dump);
    expect(sh("db.items.countDocuments()")).toBe("2");
    await deleteDatabase(id);
  }, 300_000);
  it("Object storage bucket: provision, private by default, public toggle, usage, delete", async () => {
    const spec = { id: "00000000-0000-4000-8000-0000000000b1", teamId: TEAM, network: net, bucketName: "assets", accessKey: "skyhosttestaccess", secretKey: randomPassword(32), isPublic: false };
    await provisionBucket(spec);
    const ip = (await containerIp(names.bucketContainer(spec.id), net))!;
    const { Client } = await import("minio");
    const c = new Client({ endPoint: ip, port: 9000, useSSL: false, accessKey: spec.accessKey, secretKey: spec.secretKey, region: "us-east-1" });
    await c.putObject("assets", "hello.txt", Buffer.from("hello bucket"));
    expect((await get(ip, 9000, "/assets/hello.txt")).status).toBe(403);
    await setBucketVisibility(spec, true);
    expect(await get(ip, 9000, "/assets/hello.txt")).toMatchObject({ status: 200, body: "hello bucket" });
    await setBucketVisibility(spec, false);
    expect((await get(ip, 9000, "/assets/hello.txt")).status).toBe(403);
    expect(await bucketUsageBytes(spec)).toBe(12);
    // A wrong secret is rejected.
    const bad = new Client({ endPoint: ip, port: 9000, useSSL: false, accessKey: spec.accessKey, secretKey: "wrong-secret-value", region: "us-east-1" });
    await expect(bad.statObject("assets", "hello.txt")).rejects.toThrow();
    expect(await presignUrl(spec, "hello.txt", "GET", 60)).toMatch(/X-Amz-Signature=/);
    await deleteBucket(spec.id);
    await expect(getDocker().getContainer(names.bucketContainer(spec.id)).inspect()).rejects.toThrow();
  }, 120_000);
});
