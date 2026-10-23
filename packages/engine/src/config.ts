/** Engine configuration, read from the environment once. */
export interface EngineConfig {
  /** OCI runtime for customer containers: "runsc" (gVisor), "kata-runtime" or "runc" (dev only). */
  runtime: string;
  /** Runtime for build sandboxes when builds run in containers (clone/extract/analyze steps). */
  buildRuntime: string;
  registry: string | null;
  buildxBuilder: string | null;
  buildTimeoutSeconds: number;
  buildMemoryMb: number;
  buildCpus: number;
  workDir: string;
  baseDomain: string;
  publicScheme: "http" | "https";
  /** Containers (proxy, deploy worker) that must join team networks to route traffic and run health checks. */
  edgeContainers: string[];
  /** Hostname used by the health checker to reach containers: "ip" (container IP) or "dns" (container name). */
  healthcheckMode: "ip" | "dns";
  allowLocalGit: boolean;
  defaultPidsLimit: number;
  databasePublicHost: string;
  networkPrefix: string;
  /** Open files limit for containers; 0 keeps the daemon default. */
  nofileLimit: number;
}

let cfg: EngineConfig | null = null;

export function engineConfig(): EngineConfig {
  if (cfg) return cfg;
  const env = process.env;
  cfg = {
    runtime: env.SKYHOST_CONTAINER_RUNTIME ?? "runsc",
    buildRuntime: env.SKYHOST_BUILD_RUNTIME ?? env.SKYHOST_CONTAINER_RUNTIME ?? "runsc",
    registry: env.SKYHOST_REGISTRY || null,
    buildxBuilder: env.SKYHOST_BUILDX_BUILDER || null,
    buildTimeoutSeconds: Number(env.SKYHOST_BUILD_TIMEOUT ?? 1800),
    buildMemoryMb: Number(env.SKYHOST_BUILD_MEMORY_MB ?? 4096),
    buildCpus: Number(env.SKYHOST_BUILD_CPUS ?? 2),
    workDir: env.SKYHOST_WORK_DIR ?? "/tmp/skyhost",
    baseDomain: env.SKYHOST_BASE_DOMAIN ?? "skyhost.app",
    publicScheme: (env.SKYHOST_PUBLIC_SCHEME as "http" | "https") ?? "https",
    edgeContainers: (env.SKYHOST_EDGE_CONTAINERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    healthcheckMode: (env.SKYHOST_HEALTHCHECK_MODE as "ip" | "dns") ?? "ip",
    allowLocalGit: env.SKYHOST_ALLOW_LOCAL_GIT === "1",
    defaultPidsLimit: Number(env.SKYHOST_PIDS_LIMIT ?? 512),
    databasePublicHost: env.SKYHOST_DATABASE_PUBLIC_HOST ?? `db.${env.SKYHOST_BASE_DOMAIN ?? "skyhost.app"}`,
    networkPrefix: env.SKYHOST_NETWORK_PREFIX ?? "sh",
    nofileLimit: Number(env.SKYHOST_NOFILE_LIMIT ?? 65536),
  };
  return cfg;
}

export function setEngineConfig(partial: Partial<EngineConfig>) {
  cfg = { ...engineConfig(), ...partial };
}
