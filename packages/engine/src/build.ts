import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { BUILD_ENV_SECRET, DEFAULT_DOCKERIGNORE, generateBuildPlan, type AnalysisResult, type BuildPlanInput } from "@skyhost/analyzer";
import { isValidEnvKey } from "@skyhost/shared";
import { Redactor } from "@skyhost/shared/node";
import { engineConfig } from "./config";
import { getDocker, LABEL } from "./docker";
import { makeWorkDir, removeWorkDir } from "./source";

export class BuildError extends Error {
  constructor(
    message: string,
    public readonly phase: "plan" | "build" | "push" | "test" | "timeout" | "cancelled",
  ) {
    super(message);
  }
}

export interface BuildRequest {
  /** Repository checkout directory. */
  repoDir: string;
  image: string;
  cacheKey: string;
  labels: Record<string, string>;
  /** Effective service configuration (merged analysis + user overrides). */
  config: {
    runtime?: string | null;
    runtimeVersion?: string | null;
    packageManager?: string | null;
    rootDir?: string;
    workspaceRoot?: string | null;
    dockerfilePath?: string | null;
    installCommand?: string | null;
    buildCommand?: string | null;
    startCommand?: string | null;
    testCommand?: string | null;
    outputDirectory?: string | null;
    port?: number | null;
    spaFallback?: boolean;
  };
  serviceType: BuildPlanInput["serviceType"];
  useDockerfile: boolean;
  /** Variables exposed to install/build commands through a BuildKit secret (never baked into layers). */
  buildEnv: Record<string, string>;
  onLine: (line: string, level?: "info" | "warn" | "error") => void;
  signal?: AbortSignal;
  timeoutSeconds?: number;
}

export interface BuildResult {
  image: string;
  port: number | null;
  sizeBytes: number;
  durationSeconds: number;
  dockerfile: string;
}

function shellQuote(v: string) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export function serializeBuildEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([k]) => isValidEnvKey(k))
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join("\n") + "\n";
}

function insideRepo(repoDir: string, rel: string) {
  const full = resolve(repoDir, rel);
  const root = resolve(repoDir);
  if (full !== root && !full.startsWith(root + sep)) throw new BuildError(`Path escapes the repository: ${rel}`, "plan");
  return full;
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Builds an image with BuildKit. Never runs user code on the host: every user command runs inside BuildKit containers. */
const dockerEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", DOCKER_HOST: process.env.DOCKER_HOST ?? "", DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain", DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? "" });

function docker(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolveP) => {
    const child = spawn("docker", args, { env: dockerEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", (e) => resolveP({ code: -1, output: e.message }));
    child.on("close", (code) => resolveP({ code: code ?? -1, output }));
  });
}

const builders = new Map<string, Promise<void>>();

/**
 * A named BuildKit builder (docker-container driver). Used when the Docker API is reached through a socket proxy,
 * which cannot carry the h2c upgrade the daemon's embedded BuildKit needs. Images are loaded into the daemon.
 */
export function ensureBuilder(name: string, log: (l: string) => void = () => {}) {
  let p = builders.get(name);
  if (!p) {
    p = (async () => {
      if ((await docker(["buildx", "inspect", name])).code === 0) return;
      log(`Creating the BuildKit builder "${name}"`);
      // Optional buildkitd.toml: registry mirrors, private CAs (https://docs.docker.com/build/buildkit/toml-configuration/).
      const config = process.env.SKYHOST_BUILDKITD_CONFIG ? ["--buildkitd-config", process.env.SKYHOST_BUILDKITD_CONFIG] : [];
      // Pin the BuildKit version (or use an image with a private CA) with SKYHOST_BUILDKIT_IMAGE.
      if (process.env.SKYHOST_BUILDKIT_IMAGE) config.push("--driver-opt", `image=${process.env.SKYHOST_BUILDKIT_IMAGE}`);
      const r = await docker(["buildx", "create", "--name", name, "--driver", "docker-container", ...config, "--bootstrap"]);
      if (r.code !== 0 && !/existing instance/i.test(r.output)) throw new BuildError(`Cannot create the BuildKit builder: ${r.output.trim().slice(-500)}`, "build");
    })();
    p.catch(() => builders.delete(name));
    builders.set(name, p);
  }
  return p;
}

export async function buildImage(req: BuildRequest): Promise<BuildResult> {
  const started = Date.now();
  const cfg = engineConfig();
  const redactor = new Redactor().add(...Object.values(req.buildEnv));
  const log = (l: string, level?: "info" | "warn" | "error") => req.onLine(redactor.apply(l), level);
  const rootDir = req.config.rootDir && req.config.rootDir !== "." ? req.config.rootDir : ".";

  let contextDir: string;
  let dockerfilePath: string;
  let dockerfileText = "";
  let port = req.config.port ?? null;

  if (req.useDockerfile) {
    contextDir = insideRepo(req.repoDir, rootDir);
    dockerfilePath = insideRepo(contextDir, req.config.dockerfilePath || "Dockerfile");
    if (!(await exists(dockerfilePath))) throw new BuildError(`Dockerfile not found at ${req.config.dockerfilePath || "Dockerfile"}`, "plan");
    log(`Using your Dockerfile (${req.config.dockerfilePath || "Dockerfile"})`);
  } else {
    let plan;
    try {
      plan = generateBuildPlan({
        runtime: (req.config.runtime ?? "unknown") as AnalysisResult["runtime"],
        version: req.config.runtimeVersion,
        packageManager: req.config.packageManager,
        installCommand: req.config.installCommand,
        buildCommand: req.config.buildCommand,
        startCommand: req.config.startCommand,
        outputDirectory: req.config.outputDirectory,
        rootDir,
        workspaceRoot: req.config.workspaceRoot,
        serviceType: req.serviceType,
        port: req.config.port,
        spaFallback: req.config.spaFallback,
        cacheKey: req.cacheKey,
      });
    } catch (e) {
      throw new BuildError((e as Error).message, "plan");
    }
    contextDir = insideRepo(req.repoDir, plan.context);
    const metaDir = join(contextDir, ".skyhost");
    await mkdir(metaDir, { recursive: true });
    dockerfilePath = join(metaDir, "Dockerfile");
    await writeFile(dockerfilePath, plan.dockerfile);
    for (const [name, content] of Object.entries(plan.files)) await writeFile(join(metaDir, name), content);
    if (!(await exists(join(contextDir, ".dockerignore")))) await writeFile(join(contextDir, ".dockerignore"), DEFAULT_DOCKERIGNORE);
    dockerfileText = plan.dockerfile;
    port = plan.port ?? port;
    log(`Generated build plan for ${req.config.runtime}${req.serviceType === "static" ? " (static site)" : ""}`);
  }

  // Build variables go into a secret file outside the build context.
  const secretDir = await makeWorkDir("buildenv");
  const secretFile = join(secretDir, "env");
  await writeFile(secretFile, serializeBuildEnv(req.buildEnv), { mode: 0o600 });

  const args = ["buildx", "build", "--progress=plain", "-f", dockerfilePath, "-t", req.image, "--secret", `id=${BUILD_ENV_SECRET},src=${secretFile}`];
  for (const [k, v] of Object.entries({ [LABEL.managed]: "true", ...req.labels })) args.push("--label", `${k}=${v}`);
  if (cfg.buildxBuilder) {
    await ensureBuilder(cfg.buildxBuilder, log);
    args.push("--builder", cfg.buildxBuilder, "--load");
  }
  args.push(contextDir);

  const timeoutSeconds = req.timeoutSeconds ?? cfg.buildTimeoutSeconds;
  try {
    await new Promise<void>((resolveP, reject) => {
      const child = spawn("docker", args, {
        env: dockerEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new BuildError(`Build exceeded the ${Math.round(timeoutSeconds / 60)} minute limit`, "timeout"));
      }, timeoutSeconds * 1000);
      const onAbort = () => {
        child.kill("SIGKILL");
        reject(new BuildError("Build cancelled", "cancelled"));
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      let buf = "";
      const onData = (b: Buffer) => {
        buf += b.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) log(l, /ERROR|error:/.test(l) ? "error" : "info");
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new BuildError(e.message, "build"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        if (buf.trim()) log(buf);
        if (code === 0) resolveP();
        else reject(new BuildError(`Build failed (exit code ${code})`, "build"));
      });
    });
  } finally {
    await removeWorkDir(secretDir).catch(() => {});
  }

  if (req.config.testCommand && req.serviceType !== "static") {
    await runTests(req.image, req.config.testCommand, log, req.signal);
  }

  if (cfg.registry && req.image.startsWith(cfg.registry + "/")) {
    log(`Pushing image to the internal registry`);
    await pushImage(req.image, log);
  }

  const info = await getDocker().getImage(req.image).inspect();
  const durationSeconds = Math.round((Date.now() - started) / 1000);
  log(`Image built in ${durationSeconds}s (${Math.round(info.Size / 1048576)} MB)`);
  return { image: req.image, port, sizeBytes: info.Size, durationSeconds, dockerfile: dockerfileText };
}

async function pushImage(image: string, log: (l: string) => void) {
  const img = getDocker().getImage(image);
  const stream = await img.push({});
  await new Promise<void>((resolveP, reject) => {
    getDocker().modem.followProgress(
      stream,
      (err) => (err ? reject(new BuildError(`Push failed: ${err.message}`, "push")) : resolveP()),
      (ev: { error?: string; status?: string }) => {
        if (ev.error) reject(new BuildError(`Push failed: ${ev.error}`, "push"));
        else if (ev.status === "Pushed") log("Layer pushed");
      },
    );
  });
}

/** Runs the test command in an isolated, network-less container from the freshly built image. */
async function runTests(image: string, command: string, log: (l: string) => void, signal?: AbortSignal) {
  const cfg = engineConfig();
  log(`Running tests: ${command}`);
  const d = getDocker();
  const container = await d.createContainer({
    Image: image,
    Cmd: ["/bin/sh", "-c", command],
    Env: ["CI=true", "NODE_ENV=test"],
    Labels: { [LABEL.managed]: "true", [LABEL.kind]: "test" },
    HostConfig: {
      NetworkMode: "none",
      Memory: cfg.buildMemoryMb * 1024 * 1024,
      NanoCpus: Math.round(cfg.buildCpus * 1e9),
      PidsLimit: cfg.defaultPidsLimit,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Runtime: cfg.runtime,
      AutoRemove: false,
    },
  });
  try {
    await container.start();
    const timer = setTimeout(() => container.kill().catch(() => {}), 15 * 60 * 1000);
    signal?.addEventListener("abort", () => container.kill().catch(() => {}), { once: true });
    const res = (await container.wait()) as { StatusCode: number };
    clearTimeout(timer);
    const logs = (await container.logs({ stdout: true, stderr: true, tail: 200 })) as unknown as Buffer;
    for (const l of demuxToText(logs).split("\n")) if (l.trim()) log(`[test] ${l}`);
    if (res.StatusCode !== 0) throw new BuildError(`Tests failed (exit code ${res.StatusCode})`, "test");
    log("Tests passed");
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/** Converts a multiplexed docker log buffer into text. */
export function demuxToText(buf: Buffer): string {
  if (!Buffer.isBuffer(buf)) return String(buf ?? "");
  const out: string[] = [];
  let i = 0;
  // Multiplexed frames start with [stream, 0, 0, 0, size(4)]
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      out.push(buf.subarray(i + 8, i + 8 + size).toString());
      i += 8 + size;
    }
    return out.join("");
  }
  return buf.toString();
}
