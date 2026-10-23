import type Docker from "dockerode";
import { request } from "node:http";
import { engineConfig } from "./config";
import { containerIp, ensureNetwork, getDocker, LABEL, removeContainer } from "./docker";
import { demuxToText } from "./build";

export interface ContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  /** Optional command override (sh -c). */
  command?: string | null;
  /** Exec-form arguments passed to the image entrypoint (takes precedence over command). */
  args?: string[];
  network: string;
  networkLabels: Record<string, string>;
  /** DNS names inside the team network, e.g. ["api", "api.internal"]. */
  aliases: string[];
  labels: Record<string, string>;
  cpu: number;
  memoryMb: number;
  pidsLimit?: number;
  volumes?: Array<{ dockerVolume: string; mountPath: string }>;
  restart?: "always" | "on-failure" | "no";
  stopGraceSeconds?: number;
  /** Publish container port on the host (databases with public access only). */
  publish?: { containerPort: number; hostPort?: number; hostIp?: string };
  user?: string;
  readOnlyRootfs?: boolean;
  tmpfs?: Record<string, string>;
  /** Extra capabilities needed by trusted platform images (database engines). Customer apps get none. */
  capAdd?: string[];
  /** Platform-managed containers (databases) may use runc when the configured runtime does not support them. */
  runtime?: string;
}

/**
 * Capabilities kept for images that start as root and drop privileges themselves (nginx, apache, postgres...).
 * Everything else from Docker's default set (NET_RAW, MKNOD, SYS_CHROOT, SETFCAP, ...) is dropped.
 */
export const SAFE_CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "NET_BIND_SERVICE", "KILL"];

/** Hardened container creation: no privileges, no host mounts, no Docker socket, all capabilities dropped. */
export async function createAndStart(spec: ContainerSpec): Promise<Docker.Container> {
  const cfg = engineConfig();
  const d = getDocker();
  await ensureNetwork(spec.network, spec.networkLabels);
  for (const v of spec.volumes ?? []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(v.dockerVolume)) throw new Error("Invalid volume name");
    if (!v.mountPath.startsWith("/") || v.mountPath.includes("..")) throw new Error("Invalid mount path");
  }
  await removeContainer(spec.name, { graceSeconds: 1 });
  const portKey = spec.publish ? `${spec.publish.containerPort}/tcp` : null;
  const container = await d.createContainer({
    name: spec.name,
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Cmd: spec.args ?? (spec.command ? ["/bin/sh", "-c", spec.command] : undefined),
    Labels: { [LABEL.managed]: "true", ...spec.labels },
    User: spec.user,
    StopSignal: "SIGTERM",
    StopTimeout: spec.stopGraceSeconds ?? 30,
    ExposedPorts: portKey ? { [portKey]: {} } : undefined,
    HostConfig: {
      NetworkMode: spec.network,
      Memory: spec.memoryMb * 1024 * 1024,
      MemorySwap: spec.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.cpu * 1e9),
      PidsLimit: spec.pidsLimit ?? cfg.defaultPidsLimit,
      CapDrop: ["ALL"],
      CapAdd: spec.capAdd ?? SAFE_CAPS,
      SecurityOpt: ["no-new-privileges"],
      Privileged: false,
      ReadonlyRootfs: spec.readOnlyRootfs ?? false,
      Tmpfs: spec.tmpfs,
      Runtime: spec.runtime ?? cfg.runtime,
      Init: true,
      RestartPolicy: spec.restart === "no" ? { Name: "no" } : spec.restart === "always" ? { Name: "unless-stopped" } : { Name: "on-failure", MaximumRetryCount: 10 },
      Mounts: (spec.volumes ?? []).map((v) => ({ Type: "volume" as const, Source: v.dockerVolume, Target: v.mountPath })),
      PortBindings: portKey ? { [portKey]: [{ HostIp: spec.publish!.hostIp ?? "0.0.0.0", HostPort: spec.publish!.hostPort ? String(spec.publish!.hostPort) : "" }] } : undefined,
      LogConfig: { Type: "json-file", Config: { "max-size": "20m", "max-file": "3" } },
      Ulimits: cfg.nofileLimit > 0 ? [{ Name: "nofile", Soft: cfg.nofileLimit, Hard: cfg.nofileLimit }] : undefined,
    },
    NetworkingConfig: { EndpointsConfig: { [spec.network]: { Aliases: spec.aliases } } },
  });
  await container.start();
  return container;
}

export interface HealthcheckSpec {
  container: string;
  network: string;
  port: number | null;
  path: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  retries: number;
  /** For services without HTTP: healthy once the container stays up for this long. */
  minUptimeSeconds?: number;
  onLine?: (l: string) => void;
  signal?: AbortSignal;
}

export class HealthcheckError extends Error {
  constructor(
    message: string,
    public readonly logs: string,
  ) {
    super(message);
  }
}

function httpGet(host: string, port: number, path: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: "GET", timeout: timeoutMs, headers: { "User-Agent": "SKYHOST-HealthCheck/1.0", Host: "localhost" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function tailLogs(container: string, lines = 80): Promise<string> {
  try {
    const buf = (await getDocker().getContainer(container).logs({ stdout: true, stderr: true, tail: lines })) as unknown as Buffer;
    return demuxToText(buf);
  } catch {
    return "";
  }
}

/** Waits until the container answers on its port (HTTP status below 500) or stays running (workers). */
export async function waitHealthy(spec: HealthcheckSpec): Promise<void> {
  const d = getDocker();
  const cfg = engineConfig();
  const started = Date.now();
  let lastError = "";
  for (let attempt = 1; attempt <= spec.retries; attempt++) {
    if (spec.signal?.aborted) throw new HealthcheckError("Cancelled", "");
    const info = await d.getContainer(spec.container).inspect().catch(() => null);
    if (!info) throw new HealthcheckError("Container disappeared", "");
    if (!info.State.Running || info.State.Restarting || info.RestartCount > 0) {
      const logs = await tailLogs(spec.container);
      const reason = info.State.OOMKilled ? "out of memory (OOMKilled, exit code 137)" : `exit code ${info.State.ExitCode}`;
      throw new HealthcheckError(`The process exited during startup: ${reason}`, logs);
    }
    if (spec.port == null) {
      if ((Date.now() - started) / 1000 >= (spec.minUptimeSeconds ?? 5)) {
        spec.onLine?.("Process is running");
        return;
      }
    } else {
      const host = cfg.healthcheckMode === "dns" ? spec.container : await containerIp(spec.container, spec.network);
      if (host) {
        try {
          const status = await httpGet(host, spec.port, spec.path, spec.timeoutSeconds * 1000);
          if (status > 0 && status < 500) {
            spec.onLine?.(`Health check passed: GET ${spec.path} returned ${status}`);
            return;
          }
          lastError = `GET ${spec.path} returned ${status}`;
        } catch (e) {
          lastError = `connection refused on port ${spec.port} (${(e as Error).message})`;
        }
      }
      spec.onLine?.(`Health check attempt ${attempt}/${spec.retries}: ${lastError || "waiting for network"}`);
    }
    await new Promise((r) => setTimeout(r, spec.intervalSeconds * 1000));
  }
  const logs = await tailLogs(spec.container);
  throw new HealthcheckError(`Health check failed after ${spec.retries} attempts: ${lastError || "no response"}`, logs);
}

export interface ContainerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  restarts: number;
  running: boolean;
}

export async function containerStats(nameOrId: string): Promise<ContainerStats | null> {
  const c = getDocker().getContainer(nameOrId);
  try {
    const [s, info] = await Promise.all([c.stats({ stream: false }) as Promise<Docker.ContainerStats>, c.inspect()]);
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
    const cpus = s.cpu_stats.online_cpus ?? s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
    const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
    let rx = 0;
    let tx = 0;
    for (const n of Object.values(s.networks ?? {})) {
      rx += n.rx_bytes;
      tx += n.tx_bytes;
    }
    const cache = (s.memory_stats.stats as Record<string, number> | undefined)?.inactive_file ?? 0;
    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryBytes: Math.max(0, (s.memory_stats.usage ?? 0) - cache),
      memoryLimitBytes: s.memory_stats.limit ?? 0,
      netRxBytes: rx,
      netTxBytes: tx,
      restarts: info.RestartCount,
      running: info.State.Running,
    };
  } catch {
    return null;
  }
}

export async function stopContainer(nameOrId: string, graceSeconds = 30) {
  try {
    await getDocker().getContainer(nameOrId).stop({ t: graceSeconds });
  } catch {
    /* already stopped */
  }
}

export async function startContainer(nameOrId: string) {
  try {
    await getDocker().getContainer(nameOrId).start();
  } catch (e) {
    if (!/already started/i.test((e as Error).message)) throw e;
  }
}

export interface LogLine {
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
}

/** Streams container logs (timestamps on). Returns a stop function. */
export async function streamLogs(nameOrId: string, opts: { follow: boolean; tail?: number; since?: number }, onLine: (l: LogLine) => void): Promise<() => void> {
  const c = getDocker().getContainer(nameOrId);
  const stream = (await c.logs({ stdout: true, stderr: true, follow: opts.follow as true, tail: opts.tail ?? 200, since: opts.since, timestamps: true })) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
  const parse = (kind: LogLine["stream"]) => {
    let buf = "";
    return (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const sp = raw.indexOf(" ");
        onLine({ ts: raw.slice(0, sp), stream: kind, line: raw.slice(sp + 1) });
      }
    };
  };
  const { PassThrough } = await import("node:stream");
  const out = new PassThrough();
  const err = new PassThrough();
  out.on("data", parse("stdout"));
  err.on("data", parse("stderr"));
  if (Buffer.isBuffer(stream)) {
    // Non-follow mode returns a buffer
    const text = demuxToText(stream as unknown as Buffer);
    parse("stdout")(Buffer.from(text + "\n"));
    return () => {};
  }
  getDocker().modem.demuxStream(stream, out, err);
  return () => stream.destroy?.();
}
