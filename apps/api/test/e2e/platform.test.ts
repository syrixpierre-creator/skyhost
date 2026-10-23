/**
 * End-to-end tests against real infrastructure: Docker (BuildKit, containers, networks), Traefik as the edge
 * proxy, PostgreSQL databases, Playwright screenshots. Workers run in-process with the same code as production.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { deployments, getDb, screenshots, serviceInstances, services } from "@skyhost/db";
import { getDocker, removeContainer, setEngineConfig } from "@skyhost/engine";
import { getApp, newUser, setPlan, Client } from "../helpers";
import { TEST_ENV } from "../env";

const API_PORT = 4999;
const GATEWAY = "172.17.0.1";
const TRAEFIK = "sh-e2e-traefik";
let traefikIp = "";
let stopWorkers: (() => Promise<void>) | null = null;

process.env.SKYHOST_API_INTERNAL_URL = `http://${GATEWAY}:${API_PORT}`;
process.env.SKYHOST_PROXY_SWITCH_DELAY_MS = "2500";
process.env.SKYHOST_VERIFY_BACKUPS = "1";

function viaProxy(host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: traefikIp, port: 80, path, headers: { Host: host }, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${(last as Error).message}` : ""}`);
}

/** After go-live the previous container drains for SKYHOST_PROXY_SWITCH_DELAY_MS, so wait for the new version only. */
async function servedVersion(host: string, match: (body: { version?: string; greeting?: string | null }) => boolean) {
  return until(async () => {
    const r = await viaProxy(host);
    const body = r.status === 200 ? JSON.parse(r.body) : null;
    return body && match(body) ? body : null;
  }, 20_000, "the new version behind the proxy");
}

async function waitDeployment(id: string, statuses = ["live", "failed", "cancelled"]) {
  return until(async () => {
    const [d] = await getDb().select().from(deployments).where(eq(deployments.id, id));
    return d && statuses.includes(d.status) ? d : null;
  }, 300_000, `deployment ${id}`);
}

const APP = (version: string, opts: { crash?: boolean } = {}) => `
const http = require("http");
const net = require("net");
${opts.crash ? 'console.error("Error: Missing required environment variable: FEATURE_TOKEN"); process.exit(1);' : ""}
function probeDb() {
  return new Promise((resolve) => {
    if (!process.env.DATABASE_URL) return resolve("not-configured");
    const u = new URL(process.env.DATABASE_URL);
    const s = net.connect(Number(u.port), u.hostname, () => {
      const req = Buffer.alloc(8); req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4); s.write(req); // PostgreSQL SSLRequest
    });
    s.once("data", (d) => { s.destroy(); resolve("postgres-" + d.toString()); });
    s.on("error", (e) => resolve("error:" + e.message));
    setTimeout(() => { s.destroy(); resolve("timeout"); }, 3000);
  });
}
http.createServer(async (req, res) => {
  if (req.url === "/health") return res.end("ok");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ version: "${version}", greeting: process.env.GREETING || null, db: await probeDb(), host: process.env.SKYHOST_PRIVATE_DOMAIN }));
}).listen(process.env.PORT || 3000, "0.0.0.0");
`;

let repo: string;
function commit(version: string, crash = false) {
  execFileSync("bash", ["-c", `cat > ${repo}/server.js`], { input: APP(version, { crash }) });
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-qm", `Release ${version}`]);
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
}

beforeAll(async () => {
  setEngineConfig({ runtime: "runc", nofileLimit: 0, edgeContainers: [TRAEFIK], allowLocalGit: true, workDir: await mkdtemp(join(tmpdir(), "sh-e2e-")) });
  const app = await getApp();
  await app.listen({ host: "0.0.0.0", port: API_PORT });
  await removeContainer(TRAEFIK, { graceSeconds: 0 });
  execFileSync("docker", [
    "run", "-d", "--name", TRAEFIK, "traefik:v3.4",
    `--providers.http.endpoint=http://${GATEWAY}:${API_PORT}/internal/proxy/traefik?token=${TEST_ENV.SKYHOST_INTERNAL_TOKEN}`,
    "--providers.http.pollInterval=1s",
    "--entrypoints.web.address=:80",
    "--log.level=ERROR",
  ]);
  traefikIp = (await getDocker().getContainer(TRAEFIK).inspect()).NetworkSettings.Networks.bridge!.IPAddress;
  process.env.SKYHOST_SCREENSHOT_PROXY_HOST = traefikIp;
  const { startWorkers } = await import("@skyhost/worker");
  stopWorkers = startWorkers(["build", "deploy", "screenshot", "notify"]);

  repo = await mkdtemp(join(tmpdir(), "sh-e2e-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "e2e-app", version: "1.0.0", scripts: { start: "node server.js" }, dependencies: {} }, null, 2));
  await writeFile(join(repo, "package-lock.json"), JSON.stringify({ name: "e2e-app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "e2e-app", version: "1.0.0" } } }));
  await writeFile(join(repo, ".env.example"), "GREETING=\n");
  commit("v1");
}, 300_000);

afterAll(async () => {
  await stopWorkers?.();
  for (const c of await getDocker().listContainers({ all: true, filters: { label: ["skyhost.managed=true"] } })) await getDocker().getContainer(c.Id).remove({ force: true }).catch(() => {});
  await removeContainer(TRAEFIK, { graceSeconds: 0 });
  await (await getApp()).close();
});

describe("SmartDeploy end to end", () => {
  let u: Awaited<ReturnType<typeof newUser>>;
  let projectId: string;
  let serviceId: string;
  let envId: string;
  let host: string;
  let firstDeploymentId: string;

  it("1. repository -> branch -> analyzer -> build -> container -> health check -> URL live", async () => {
    u = await newUser({ name: "E2E" });
    await setPlan(u.teamId, "pro");
    const url = `file://${repo}`;
    const branches = await u.client.post("/api/v1/git/public/branches", { url });
    expect(branches.body).toMatchObject({ defaultBranch: "main", branches: ["main"] });
    // Local repositories (file://) are only accepted with SKYHOST_ALLOW_LOCAL_GIT in tests.
    const a = await u.client.post("/api/v1/projects/analyze", { teamId: u.teamId, source: { kind: "git", url } });
    expect(a.status, a.raw).toBe(200);
    // A plain node:http server (no framework) is detected with medium confidence: the user confirms the values.
    expect(a.body.analysis).toMatchObject({ runtime: "node", startCommand: "npm run start", port: 3000, confidence: "medium" });
    expect(a.body.analysis.environmentVariables.map((v: { key: string }) => v.key)).toContain("GREETING");
    expect(a.body.explanation.join(" ")).toMatch(/double check/);

    const launch = await u.client.post("/api/v1/projects/launch", {
      teamId: u.teamId,
      projectName: "Shop",
      source: { kind: "git", url: `file://${repo}`, branch: "main" },
      services: [{ name: "web", type: "web", config: { healthcheck: { path: "/health", intervalSeconds: 1, timeoutSeconds: 2, retries: 30, enabled: true }, screenshotPaths: ["/"] }, variables: [{ key: "GREETING", value: "hello", secret: false }], analysis: a.body.analysis }],
      databases: [{ name: "db", engine: "postgres", connectTo: ["web"] }],
    });
    expect(launch.status, launch.raw).toBe(201);
    projectId = launch.body.projectId;
    serviceId = launch.body.services[0].id;
    firstDeploymentId = launch.body.deployments[0].id;
    const dep = await waitDeployment(firstDeploymentId);
    if (dep.status !== "live") {
      const logs = await u.client.get(`/api/v1/deployments/${dep.id}/logs`);
      throw new Error(`Deployment ${dep.status}: ${dep.error}\n${logs.body.lines.map((l: { line: string }) => l.line).slice(-40).join("\n")}`);
    }
    expect(dep.commitMessage).toBe("Release v1");
    const detail = await u.client.get(`/api/v1/projects/${projectId}`);
    const inst = detail.body.services[0].instances[0];
    envId = inst.environmentId;
    expect(inst.status).toBe("running");
    host = new URL(inst.url).host;
    const res = await until(async () => {
      const r = await viaProxy(host);
      return r.status === 200 ? r : null;
    }, 30_000, "proxy route");
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ version: "v1", greeting: "hello", host: "web.internal" });

    // Build logs are stored and redacted
    const logs = await u.client.get(`/api/v1/deployments/${firstDeploymentId}/logs`);
    expect(logs.body.lines.length).toBeGreaterThan(5);
  });

  it("2. database -> credentials -> connect service -> variable -> app connected to the database", async () => {
    const dbs = await u.client.get(`/api/v1/projects/${projectId}/databases`);
    const dbId = dbs.body.databases[0].id;
    await until(async () => (await u.client.get(`/api/v1/databases/${dbId}`)).body.database.status === "available", 120_000, "database available");
    const creds = await u.client.get(`/api/v1/databases/${dbId}/credentials`);
    expect(creds.body.credentials.connectionUrl).toMatch(/^postgresql:\/\/u_\w+:.+@db\.internal:5432\/db$/);
    const resolved = await u.client.get(`/api/v1/services/${serviceId}/variables/resolved?environmentId=${envId}&`);
    expect(resolved.body.variables.find((v: { key: string }) => v.key === "DATABASE_URL")).toBeTruthy();
    // The first deployment waited for the database; the app reaches PostgreSQL on the private network.
    const r = JSON.parse((await viaProxy(host)).body);
    expect(r.db).toBe("postgres-N");
    // Data browser (read-only)
    const q = await u.client.post(`/api/v1/databases/${dbId}/query`, { sql: "select current_database() as db" });
    expect(q.body.result.rows).toEqual([["db"]]);
    // Backup with a verified test restore
    const b = await u.client.post(`/api/v1/databases/${dbId}/backups`);
    await until(async () => {
      const list = await u.client.get(`/api/v1/databases/${dbId}/backups`);
      const x = list.body.backups.find((y: { id: string }) => y.id === b.body.backup.id);
      if (x?.status === "failed") throw new Error(x.error);
      return x?.status === "completed" && x.verifiedAt ? x : null;
    }, 180_000, "verified backup");
  });

  it("8. live deployment -> automatic capture -> gallery -> share link revoked -> denied", async () => {
    const shot = await until(async () => {
      const rows = await getDb().select().from(screenshots).where(eq(screenshots.deploymentId, firstDeploymentId));
      const failed = rows.find((s) => s.status === "failed");
      if (failed) throw new Error(`capture failed: ${failed.error}`);
      return rows.length === 2 && rows.every((s) => s.status === "completed") ? rows : null;
    }, 120_000, "automatic screenshots");
    expect(shot.map((s) => s.viewport).sort()).toEqual(["desktop", "mobile"]);
    const gallery = await u.client.get(`/api/v1/services/${serviceId}/screenshots`);
    expect(gallery.body.screenshots.length).toBe(2);
    const img = await u.client.get(`/api/v1/screenshots/${shot[0]!.id}/image`);
    expect(img.headers["content-type"]).toBe("image/png");
    const share = await u.client.post(`/api/v1/screenshots/${shot[0]!.id}/share`, { expiresInDays: 1 });
    const token = share.body.url.split("/").pop();
    expect((await new Client().get(`/api/v1/public/screenshots/${token}`)).status).toBe(200);
    await u.client.del(`/api/v1/screenshots/${shot[0]!.id}/share`);
    expect((await new Client().get(`/api/v1/public/screenshots/${token}`)).status).toBe(404);
  });

  it("9. variables edited in JSON mode -> redeploy applies the values (zero downtime)", async () => {
    const put = await u.client.put(`/api/v1/environments/${envId}/variables`, { serviceId, replace: true, variables: [{ key: "GREETING", value: "bonjour" }] });
    expect(put.body.redeployRequired).toBe(true);
    const redeploy = await u.client.post(`/api/v1/services/${serviceId}/redeploy`, { environmentId: envId });
    expect(redeploy.status).toBe(201);
    // The old version keeps serving while the new one starts.
    let downtime = 0;
    let done = false;
    const poll = (async () => {
      while (!done) {
        if ((await viaProxy(host)).status !== 200) downtime++;
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const d = await waitDeployment(redeploy.body.deployment.id);
    await new Promise((r) => setTimeout(r, 4000));
    done = true;
    await poll;
    expect(d.status).toBe("live");
    expect(JSON.parse((await viaProxy(host)).body).greeting).toBe("bonjour");
    expect(downtime).toBe(0);
  });

  it("10. a failed deployment keeps the previous version live; rollback succeeds", async () => {
    const sha = commit("v2-broken", true);
    const dep = await u.client.post(`/api/v1/services/${serviceId}/deploy`, { environmentId: envId, commitSha: sha });
    const failed = await waitDeployment(dep.body.deployment.id);
    expect(failed.status).toBe("failed");
    const diag = await u.client.get(`/api/v1/deployments/${failed.id}/diagnosis`);
    expect(diag.body.diagnoses[0]).toMatchObject({ id: "missing-env", problem: "Missing environment variable FEATURE_TOKEN" });
    // Still serving the previous live version
    expect(JSON.parse((await viaProxy(host)).body)).toMatchObject({ version: "v1", greeting: "bonjour" });

    const rb = await u.client.post(`/api/v1/deployments/${firstDeploymentId}/rollback`);
    expect(rb.status).toBe(201);
    const live = await waitDeployment(rb.body.deployment.id);
    expect(live.status).toBe("live");
    const [inst] = await getDb().select().from(serviceInstances).where(eq(serviceInstances.serviceId, serviceId));
    expect(inst!.liveDeploymentId).toBe(live.id);
    expect(JSON.parse((await viaProxy(host)).body).version).toBe("v1");
  });

  it("3. API key -> authenticated deploy (ZIP upload, like the CLI) -> revoke -> rejected", async () => {
    const key = await u.client.post("/api/v1/api-keys", { name: "cli", teamId: u.teamId, scopes: ["deploy"] });
    const yazl = (await import("yazl")).default;
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({ name: "e2e-app", scripts: { start: "node server.js" } })), "package.json");
    zip.addBuffer(Buffer.from(APP("v3-zip")), "server.js");
    zip.end();
    const chunks: Buffer[] = [];
    for await (const c of zip.outputStream) chunks.push(c as Buffer);
    const boundary = "----sky";
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.zip"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.concat(chunks), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const app = await getApp();
    const send = () => app.inject({ method: "POST", url: `/api/v1/services/${serviceId}/deploy-zip?environmentId=${envId}`, payload, headers: { authorization: `Bearer ${key.body.secret}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
    const res = await send();
    expect(res.statusCode, res.body).toBe(201);
    const d = await waitDeployment(JSON.parse(res.body).deployment.id);
    expect(d.status).toBe("live");
    expect(d.trigger).toBe("cli");
    expect((await servedVersion(host, (b) => b.version === "v3-zip")).version).toBe("v3-zip");
    await u.client.post(`/api/v1/api-keys/${key.body.apiKey.id}/revoke`);
    expect((await send()).statusCode).toBe(401);
  });

  it("4. CLI: device login -> link -> deploy -> env set -> redeploy -> logs -> shell -> rollback", async () => {
    // The API runs in this process, so the CLI is always spawned asynchronously.
    const run = promisify(execFile);
    const cliDir = fileURLToPath(new URL("../../../cli", import.meta.url));
    await run("node", ["build.mjs"], { cwd: cliDir });
    const bin = join(cliDir, "dist/skyhost.js");
    const home = await mkdtemp(join(tmpdir(), "sh-cli-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "sh-cli-app-"));
    const env = { ...process.env, SKYHOST_CONFIG_DIR: home, NO_COLOR: "1", SKYHOST_API_URL: "", SKYHOST_TOKEN: "" };
    const cli = (...args: string[]) => run("node", [bin, ...args], { cwd, env, timeout: 300_000 }).then((r) => r.stdout);

    // Device flow: the CLI prints a code, the signed-in user approves it, the CLI receives its key.
    const login = spawn("node", [bin, "login", "--api-url", `http://127.0.0.1:${API_PORT}`, "--no-browser"], { cwd, env });
    let out = "";
    login.stdout.on("data", (d) => (out += d));
    const code = await until(async () => /confirm the code (\S+)/.exec(out)?.[1], 15_000, "CLI user code");
    expect((await u.client.post("/api/v1/auth/cli/approve", { userCode: code, teamId: u.teamId })).status).toBe(200);
    await new Promise((resolve) => login.on("exit", resolve));
    expect(out).toContain("Logged in as");
    expect(await cli("whoami")).toContain(u.email);

    const project = (await u.client.get(`/api/v1/projects/${projectId}`)).body;
    await cli("link", "--project", project.project.name, "--service", project.services.find((s: { id: string }) => s.id === serviceId).name);

    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "e2e-app", scripts: { start: "node server.js" } }));
    await writeFile(join(cwd, "server.js"), APP("v4-cli"));
    await writeFile(join(cwd, ".env"), "LOCAL_SECRET=must-not-be-uploaded\n");
    await mkdir(join(cwd, "node_modules/junk"), { recursive: true });
    await writeFile(join(cwd, "node_modules/junk/index.js"), "");
    const deployOut = await cli("deploy");
    expect(deployOut).toMatch(/Uploading 2 files/);
    expect(deployOut).toContain("Live at");
    expect((await servedVersion(host, (b) => b.version === "v4-cli")).version).toBe("v4-cli");

    expect(await cli("env", "set", "GREETING=from-cli")).toContain("1 variable(s) saved");
    expect(await cli("env", "list")).toContain("GREETING=from-cli");
    await cli("redeploy");
    expect(await servedVersion(host, (b) => b.greeting === "from-cli")).toMatchObject({ version: "v4-cli", greeting: "from-cli" });

    expect(await cli("status")).toMatch(/running|live/);
    expect(await cli("deployments")).toContain("cli");
    expect(await cli("logs", "--tail", "50")).toBeTypeOf("string");
    expect(await cli("shell", "-c", "node --version")).toMatch(/^v\d+/);
    await expect(cli("shell", "-c", "cat /etc/shadow")).rejects.toThrow();

    await cli("rollback");
    expect((await servedVersion(host, (b) => b.version !== "v4-cli")).version).toBe("v3-zip");
  }, 600_000);

  it("secure shell runs only allowed commands inside the service container", async () => {
    const { runShellCommand } = await import("@skyhost/engine");
    const [svc] = await getDb().select().from(services).where(eq(services.id, serviceId));
    const [inst] = await getDb().select().from(serviceInstances).where(eq(serviceInstances.serviceId, serviceId));
    const [dep] = await getDb().select().from(deployments).where(eq(deployments.id, inst!.liveDeploymentId!));
    const out = await runShellCommand(dep!.containers[0]!, "node --version", svc!.config.runtime ?? "node");
    expect(out.stdout.toString()).toMatch(/^v\d+/);
    await expect(runShellCommand(dep!.containers[0]!, "cat /etc/shadow; id", "node")).rejects.toThrow();
  });
});
