import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import { newRedisConnection } from "./redis";

export const QUEUES = {
  analyze: "analyze",
  deploy: "deploy",
  release: "release",
  database: "database",
  backup: "backup",
  screenshot: "screenshot",
  job: "job",
  notify: "notify",
  webhook: "webhook",
  bucket: "bucket",
  maintenance: "maintenance",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  analyze: { source: AnalyzeSource; rootDir?: string };
  deploy: { deploymentId: string };
  release: { deploymentId: string };
  database:
    | { action: "provision"; databaseId: string }
    | { action: "delete"; databaseId: string; keepVolume?: boolean; keepBackups?: boolean }
    | { action: "rotate"; databaseId: string }
    | { action: "public"; databaseId: string }
    | { action: "clone"; databaseId: string; sourceId: string; anonymize: boolean };
  backup: { action: "backup"; backupId: string } | { action: "restore"; restoreId: string } | { action: "verify"; backupId: string };
  screenshot: { screenshotId: string; attempt?: number };
  job: { jobRunId: string };
  notify: { channelId: string; event: string; payload: Record<string, unknown> } | { email: string; subject: string; text: string; html?: string };
  webhook: { deliveryId: string };
  bucket: { action: "provision" | "delete" | "visibility"; bucketId: string };
  maintenance: { task: string };
}

export type AnalyzeSource =
  | { kind: "git"; url: string; branch?: string | null; token?: string | null; tokenUsername?: string }
  | { kind: "zip"; uploadId: string };

const queues = new Map<string, Queue>();
const events = new Map<string, QueueEvents>();

export function getQueue<N extends QueueName>(name: N): Queue<JobPayloads[N]> {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: newRedisConnection(),
      defaultJobOptions: { removeOnComplete: { age: 24 * 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } },
    });
    queues.set(name, q);
  }
  return q as Queue<JobPayloads[N]>;
}

export function getQueueEvents(name: QueueName): QueueEvents {
  let e = events.get(name);
  if (!e) {
    e = new QueueEvents(name, { connection: newRedisConnection() });
    events.set(name, e);
  }
  return e;
}

export async function enqueue<N extends QueueName>(name: N, data: JobPayloads[N], opts: JobsOptions = {}) {
  return (getQueue(name) as unknown as Queue).add(name, data, opts);
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  await Promise.all([...events.values()].map((e) => e.close()));
  queues.clear();
  events.clear();
}
