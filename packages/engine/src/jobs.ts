import { engineConfig } from "./config";
import { ensureNetwork, getDocker, LABEL, names } from "./docker";
import { SAFE_CAPS } from "./runtime";
import { demuxToText } from "./build";

export interface JobSpec {
  id: string;
  image: string;
  command: string;
  env: Record<string, string>;
  network: string;
  teamId: string;
  serviceId: string;
  cpu: number;
  memoryMb: number;
  timeoutSeconds: number;
  volumes?: Array<{ dockerVolume: string; mountPath: string }>;
  onLine?: (l: string) => void;
  signal?: AbortSignal;
}

export interface JobResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs a one-off command (migration, seed, cron run) in a fresh, isolated container from the service image. */
export async function runJob(spec: JobSpec): Promise<JobResult> {
  const cfg = engineConfig();
  const d = getDocker();
  await ensureNetwork(spec.network, { [LABEL.team]: spec.teamId });
  const name = names.jobContainer(spec.id);
  const container = await d.createContainer({
    name,
    Image: spec.image,
    Cmd: ["/bin/sh", "-c", spec.command],
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "job", [LABEL.team]: spec.teamId, [LABEL.service]: spec.serviceId },
    HostConfig: {
      NetworkMode: spec.network,
      Memory: spec.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.cpu * 1e9),
      PidsLimit: cfg.defaultPidsLimit,
      CapDrop: ["ALL"],
      CapAdd: SAFE_CAPS,
      SecurityOpt: ["no-new-privileges"],
      Runtime: cfg.runtime,
      Init: true,
      Mounts: (spec.volumes ?? []).map((v) => ({ Type: "volume" as const, Source: v.dockerVolume, Target: v.mountPath })),
    },
  });
  let timedOut = false;
  try {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const { PassThrough } = await import("node:stream");
    const pt = new PassThrough();
    let output = "";
    let buf = "";
    pt.on("data", (b: Buffer) => {
      const s = b.toString();
      if (output.length < 1024 * 1024) output += s;
      buf += s;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) spec.onLine?.(l);
    });
    d.modem.demuxStream(stream, pt, pt);
    await container.start();
    const timer = setTimeout(() => {
      timedOut = true;
      container.kill().catch(() => {});
    }, spec.timeoutSeconds * 1000);
    spec.signal?.addEventListener("abort", () => container.kill().catch(() => {}), { once: true });
    const res = (await container.wait()) as { StatusCode: number };
    clearTimeout(timer);
    if (buf) spec.onLine?.(buf);
    if (!output) output = demuxToText((await container.logs({ stdout: true, stderr: true, tail: 1000 })) as unknown as Buffer);
    return { exitCode: res.StatusCode, output, timedOut };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}
