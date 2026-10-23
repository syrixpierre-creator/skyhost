import { Worker, type Job } from "bullmq";
import { closeDb } from "@skyhost/db";
import { attachEdgeToAllNetworks } from "@skyhost/engine";
import { closeQueues, closeRedis, newRedisConnection, QUEUES, serverConfig } from "@skyhost/core";
import { processBuild } from "./processors/build";
import { processRelease } from "./processors/release";
import { processAnalyze, processBackup, processDatabase } from "./processors/data";
import { processBucket, processJob, processMaintenance, processNotify, processScreenshot, processWebhook } from "./processors/ops";
import { heartbeat, startScheduler } from "./scheduler";

/**
 * Worker roles (SKYHOST_WORKER_ROLES, comma separated):
 *  build      – analysis and image builds
 *  deploy     – releases, databases, backups, jobs, buckets, maintenance
 *  scheduler  – cron, backups schedule, metrics, uptime, billing, retention
 *  screenshot – Playwright captures
 *  notify     – emails, chat channels and outgoing webhooks
 * "all" runs everything in one process (self-host mode).
 */
const ROLE_QUEUES: Record<string, Array<{ queue: string; concurrency: number; run: (job: Job) => Promise<unknown> }>> = {
  build: [
    { queue: QUEUES.analyze, concurrency: 4, run: (j) => processAnalyze(j.data) },
    { queue: QUEUES.deploy, concurrency: Number(process.env.SKYHOST_BUILD_CONCURRENCY ?? 2), run: (j) => processBuild(j.data.deploymentId) },
  ],
  deploy: [
    { queue: QUEUES.release, concurrency: 4, run: (j) => processRelease(j.data.deploymentId) },
    { queue: QUEUES.database, concurrency: 2, run: (j) => processDatabase(j.data) },
    { queue: QUEUES.backup, concurrency: 2, run: (j) => processBackup(j.data) },
    { queue: QUEUES.job, concurrency: 4, run: (j) => processJob(j.data) },
    { queue: QUEUES.bucket, concurrency: 2, run: (j) => processBucket(j.data) },
    { queue: QUEUES.maintenance, concurrency: 4, run: (j) => processMaintenance(j.data) },
  ],
  screenshot: [{ queue: QUEUES.screenshot, concurrency: 2, run: (j) => processScreenshot(j.data) }],
  notify: [
    { queue: QUEUES.notify, concurrency: 8, run: (j) => processNotify(j.data) },
    { queue: QUEUES.webhook, concurrency: 8, run: (j) => processWebhook(j.data) },
  ],
};

export function startWorkers(roles: string[]) {
  const all = roles.includes("all");
  const active = all ? Object.keys(ROLE_QUEUES).concat("scheduler") : roles;
  const workers: Worker[] = [];
  for (const role of active) {
    for (const def of ROLE_QUEUES[role] ?? []) {
      const w = new Worker(def.queue, (job) => def.run(job), { connection: newRedisConnection(), concurrency: def.concurrency, lockDuration: 120_000 });
      w.on("failed", (job, err) => console.error(`[${def.queue}] job ${job?.id} failed: ${err.message}`));
      workers.push(w);
    }
  }
  const stopScheduler = active.includes("scheduler") ? startScheduler() : () => {};
  const hb = setInterval(() => void heartbeat(active).catch(() => {}), 30_000);
  void heartbeat(active).catch(() => {});
  return async () => {
    clearInterval(hb);
    stopScheduler();
    await Promise.all(workers.map((w) => w.close()));
  };
}

if (process.argv[1]?.match(/worker[/\\](src|dist)[/\\]index\.(ts|js)$/)) {
  serverConfig();
  const roles = (process.env.SKYHOST_WORKER_ROLES ?? "all").split(",").map((r) => r.trim());
  await attachEdgeToAllNetworks().catch((e) => console.warn(`Could not attach edge containers: ${(e as Error).message}`));
  const stop = startWorkers(roles);
  console.info(`SKYHOST worker started (roles: ${roles.join(", ")})`);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      console.info(`${sig}: draining jobs`);
      await stop();
      await closeQueues();
      await closeRedis();
      await closeDb();
      process.exit(0);
    });
  }
}
