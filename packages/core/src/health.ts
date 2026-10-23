import { readFile, statfs } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { getDocker } from "@skyhost/engine";
import { emailAdmins } from "./notify";

export interface ServerHealth {
  disk: { usedBytes: number; totalBytes: number; percent: number } | null;
  memory: { usedBytes: number; totalBytes: number; percent: number } | null;
  load: { perCpu: number; cpus: number };
  /** SKYHOST's own containers that are not running or not healthy. */
  unhealthy: Array<{ name: string; state: string }>;
  checkedAt: string;
}

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);

/**
 * Health of the server SKYHOST runs on. Containers see the host's disk (through the data volume), memory
 * (/proc/meminfo) and load average, so the API and the scheduler can both report it.
 */
export async function serverHealth(): Promise<ServerHealth> {
  let disk: ServerHealth["disk"] = null;
  try {
    const s = await statfs(process.env.SKYHOST_DATA_DIR ?? "/var/lib/skyhost");
    const total = s.blocks * s.bsize;
    const used = total - s.bavail * s.bsize;
    disk = { usedBytes: used, totalBytes: total, percent: pct(used, total) };
  } catch {
    /* no data dir (development) */
  }
  let memory: ServerHealth["memory"] = null;
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0) * 1024;
    const total = kb("MemTotal");
    const used = total - kb("MemAvailable");
    memory = { usedBytes: used, totalBytes: total, percent: pct(used, total) };
  } catch {
    /* not Linux */
  }
  const n = Math.max(1, cpus().length);
  const unhealthy: ServerHealth["unhealthy"] = [];
  try {
    // The Compose project of SKYHOST (named after its install folder): the one skyhost-api belongs to.
    const all = await getDocker().listContainers({ all: true, filters: { label: ["com.docker.compose.project"] } });
    const project = process.env.COMPOSE_PROJECT_NAME ?? all.find((c) => c.Names.includes("/skyhost-api"))?.Labels["com.docker.compose.project"] ?? "skyhost";
    const list = all.filter((c) => c.Labels["com.docker.compose.project"] === project);
    for (const c of list) {
      const name = (c.Names[0] ?? c.Id).replace(/^\//, "");
      const oneOff = c.Labels["com.docker.compose.oneoff"] === "True";
      if (oneOff) continue;
      if (c.State !== "running" || /unhealthy|restarting/i.test(c.Status)) unhealthy.push({ name, state: c.Status || c.State });
    }
  } catch {
    /* no Docker access */
  }
  return { disk, memory, load: { perCpu: Math.round((loadavg()[0]! / n) * 100) / 100, cpus: n }, unhealthy, checkedAt: new Date().toISOString() };
}

/** Emails administrators when the server needs attention (each alert at most every 6 hours). */
export async function checkServerHealth() {
  const h = await serverHealth();
  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (h.disk && h.disk.percent >= 85) {
    await emailAdmins(`Disk ${h.disk.percent}% full`, [`The server disk uses ${gb(h.disk.usedBytes)} of ${gb(h.disk.totalBytes)}.`, h.disk.percent >= 95 ? "Builds and databases will start failing soon. Delete unused services or grow the disk now." : "Old images and build cache are pruned automatically every 6 hours; consider growing the disk."], { cooldownKey: `disk-${h.disk.percent >= 95 ? "critical" : "high"}`, link: "/admin" });
  }
  if (h.memory && h.memory.percent >= 90) {
    await emailAdmins(`Memory ${h.memory.percent}% used`, [`The server uses ${gb(h.memory.usedBytes)} of ${gb(h.memory.totalBytes)} of RAM. Services may be killed for lack of memory.`], { cooldownKey: "memory-high", link: "/admin" });
  }
  if (h.load.perCpu >= 3) {
    await emailAdmins("Server overloaded", [`The load average is ${h.load.perCpu} per CPU (${h.load.cpus} CPUs). Deployments and apps will be slow.`], { cooldownKey: "load-high", link: "/admin" });
  }
  if (h.unhealthy.length) {
    await emailAdmins("A SKYHOST component is down", [`Not running or unhealthy: ${h.unhealthy.map((c) => `${c.name} (${c.state})`).join(", ")}.`, "Run ./skyhost status and ./skyhost logs <service> on the server."], { cooldownKey: `components-${h.unhealthy.map((c) => c.name).sort().join(",")}`, link: "/admin" });
  }
  return h;
}
