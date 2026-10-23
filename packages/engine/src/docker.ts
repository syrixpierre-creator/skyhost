import Docker from "dockerode";
import { PassThrough, type Readable } from "node:stream";
import { engineConfig } from "./config";

let docker: Docker | null = null;

export function getDocker(): Docker {
  if (docker) return docker;
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("tcp://")) {
    const u = new URL(host);
    docker = new Docker({ host: u.hostname, port: Number(u.port || 2375) });
  } else {
    docker = new Docker({ socketPath: host?.replace(/^unix:\/\//, "") || "/var/run/docker.sock" });
  }
  return docker;
}

export const LABEL = {
  managed: "skyhost.managed",
  team: "skyhost.team",
  project: "skyhost.project",
  service: "skyhost.service",
  environment: "skyhost.environment",
  deployment: "skyhost.deployment",
  database: "skyhost.database",
  bucket: "skyhost.bucket",
  kind: "skyhost.kind", // app | database | db-proxy | job | build | storage
} as const;

const short = (id: string) => id.replace(/-/g, "").slice(0, 12);

export const names = {
  teamNetwork: (teamId: string) => `${engineConfig().networkPrefix}-net-${short(teamId)}`,
  appContainer: (serviceId: string, deploymentId: string, replica = 0) => `${engineConfig().networkPrefix}-app-${short(serviceId)}-${short(deploymentId)}-${replica}`,
  jobContainer: (jobId: string) => `${engineConfig().networkPrefix}-job-${short(jobId)}`,
  dbContainer: (dbId: string) => `${engineConfig().networkPrefix}-db-${short(dbId)}`,
  dbVolume: (dbId: string) => `${engineConfig().networkPrefix}-dbdata-${short(dbId)}`,
  dbProxy: (dbId: string) => `${engineConfig().networkPrefix}-dbproxy-${short(dbId)}`,
  volume: (volumeId: string) => `${engineConfig().networkPrefix}-vol-${short(volumeId)}`,
  bucketContainer: (bucketId: string) => `${engineConfig().networkPrefix}-s3-${short(bucketId)}`,
  bucketVolume: (bucketId: string) => `${engineConfig().networkPrefix}-s3data-${short(bucketId)}`,
  image: (teamId: string, serviceId: string, deploymentId: string) => {
    const repo = `skyhost/${short(teamId)}/${short(serviceId)}`;
    const reg = engineConfig().registry;
    return `${reg ? `${reg}/` : ""}${repo}:${short(deploymentId)}`;
  },
};

export async function ensureNetwork(name: string, labels: Record<string, string>) {
  const d = getDocker();
  const existing = await d.listNetworks({ filters: { name: [name] } });
  if (existing.some((n) => n.Name === name)) return name;
  await d.createNetwork({
    Name: name,
    Driver: "bridge",
    CheckDuplicate: true,
    Labels: { [LABEL.managed]: "true", ...labels },
    // Inter-container traffic is allowed inside a team network (private networking) and nowhere else.
    Options: { "com.docker.network.bridge.enable_icc": "true" },
  });
  // Edge containers (proxy, deploy worker) join every team network so they can route and health check.
  for (const c of engineConfig().edgeContainers) {
    try {
      await d.getNetwork(name).connect({ Container: c });
    } catch (e) {
      if (!/already exists|is already connected|endpoint with name/i.test(String((e as Error).message))) throw e;
    }
  }
  return name;
}

/** Connects edge containers to every existing team network (used at worker/proxy startup). */
export async function attachEdgeToAllNetworks() {
  const d = getDocker();
  const nets = await d.listNetworks({ filters: { label: [`${LABEL.managed}=true`] } });
  for (const n of nets) {
    for (const c of engineConfig().edgeContainers) {
      try {
        await d.getNetwork(n.Id).connect({ Container: c });
      } catch {
        /* already connected */
      }
    }
  }
}

export async function pullImage(image: string, onLine?: (l: string) => void, auth?: { username: string; password: string; serveraddress?: string }) {
  const d = getDocker();
  const stream = (await d.pull(image, auth ? { authconfig: auth } : {})) as Readable;
  await new Promise<void>((resolve, reject) => {
    d.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (ev: { status?: string; id?: string; progress?: string; error?: string }) => {
        if (ev.error) onLine?.(ev.error);
        else if (ev.status && !ev.progress) onLine?.(`${ev.id ? ev.id + ": " : ""}${ev.status}`);
      },
    );
  });
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await getDocker().getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function ensureImage(image: string, onLine?: (l: string) => void) {
  if (!(await imageExists(image))) await pullImage(image, onLine);
}

export async function removeContainer(nameOrId: string, opts: { graceSeconds?: number } = {}) {
  const c = getDocker().getContainer(nameOrId);
  try {
    await c.stop({ t: opts.graceSeconds ?? 10 });
  } catch {
    /* not running */
  }
  try {
    await c.remove({ force: true, v: false });
  } catch {
    /* gone */
  }
}

export async function containerIp(nameOrId: string, network: string): Promise<string | null> {
  try {
    const info = await getDocker().getContainer(nameOrId).inspect();
    return info.NetworkSettings.Networks[network]?.IPAddress || null;
  } catch {
    return null;
  }
}

/** Runs a command in a container, returns stdout/stderr (demultiplexed) and the exit code. */
export async function execInContainer(
  nameOrId: string,
  cmd: string[],
  opts: { env?: string[]; stdin?: Buffer | Readable; timeoutMs?: number; user?: string; workingDir?: string; maxOutput?: number } = {},
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  const c = getDocker().getContainer(nameOrId);
  const exec = await c.exec({
    Cmd: cmd,
    Env: opts.env,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: !!opts.stdin,
    User: opts.user,
    WorkingDir: opts.workingDir,
    Privileged: false,
  });
  const stream = await exec.start({ hijack: !!opts.stdin, stdin: !!opts.stdin });
  const out = new PassThrough();
  const err = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const max = opts.maxOutput ?? 512 * 1024 * 1024;
  let size = 0;
  out.on("data", (b: Buffer) => {
    size += b.length;
    if (size <= max) outChunks.push(b);
  });
  err.on("data", (b: Buffer) => {
    if (errChunks.reduce((a, x) => a + x.length, 0) < 1024 * 1024) errChunks.push(b);
  });
  getDocker().modem.demuxStream(stream, out, err);
  if (opts.stdin) {
    const input = Buffer.isBuffer(opts.stdin) ? Readable_from(opts.stdin) : opts.stdin;
    input.pipe(stream as unknown as NodeJS.WritableStream);
    input.on("end", () => (stream as unknown as { end(): void }).end?.());
  }
  await new Promise<void>((resolve, reject) => {
    const t = opts.timeoutMs ? setTimeout(() => reject(new Error("Command timed out")), opts.timeoutMs) : null;
    stream.on("end", () => {
      if (t) clearTimeout(t);
      resolve();
    });
    stream.on("close", () => {
      if (t) clearTimeout(t);
      resolve();
    });
    stream.on("error", reject);
  });
  let exitCode: number | null = null;
  for (let i = 0; i < 20; i++) {
    const info = await exec.inspect();
    if (!info.Running) {
      exitCode = info.ExitCode ?? null;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { exitCode, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks) };
}

function Readable_from(b: Buffer): Readable {
  const p = new PassThrough();
  p.end(b);
  return p;
}

export async function listManagedContainers(filters: Record<string, string>) {
  const labels = Object.entries({ [LABEL.managed]: "true", ...filters }).map(([k, v]) => `${k}=${v}`);
  return getDocker().listContainers({ all: true, filters: { label: labels } });
}
