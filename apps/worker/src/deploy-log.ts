import { eq } from "drizzle-orm";
import { deploymentLogs, deployments, getDb, projects, services } from "@skyhost/db";
import { Redactor } from "@skyhost/shared/node";
import { publish, redis } from "@skyhost/core";
import type { DeploymentStatus } from "@skyhost/shared";

/**
 * Buffered, redacted deployment log writer. Lines are persisted (for history/downloads) and streamed live
 * through Redis to the dashboard.
 */
export class DeployLog {
  private buf: Array<{ stream: string; level: string; line: string }> = [];
  private timer: NodeJS.Timeout | null = null;
  readonly redactor = new Redactor();
  readonly text: string[] = [];

  constructor(
    readonly deploymentId: string,
    private stream: "build" | "deploy",
  ) {}

  setStream(s: "build" | "deploy") {
    void this.flush();
    this.stream = s;
  }

  line(raw: string, level: "info" | "warn" | "error" = "info") {
    const line = this.redactor.apply(raw).slice(0, 8000);
    this.text.push(line);
    if (this.text.length > 20_000) this.text.shift();
    this.buf.push({ stream: this.stream, level, line });
    if (this.buf.length >= 200) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 300);
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buf.splice(0);
    if (!batch.length) return;
    const rows = await getDb()
      .insert(deploymentLogs)
      .values(batch.map((b) => ({ deploymentId: this.deploymentId, ...b })))
      .returning({ id: deploymentLogs.id, stream: deploymentLogs.stream, level: deploymentLogs.level, line: deploymentLogs.line, createdAt: deploymentLogs.createdAt });
    await publish(`deployment:${this.deploymentId}`, { type: "logs", lines: rows });
  }
}

export async function setDeploymentState(deploymentId: string, patch: Partial<typeof deployments.$inferInsert> & { status?: DeploymentStatus }) {
  const db = getDb();
  const [d] = await db.update(deployments).set(patch).where(eq(deployments.id, deploymentId)).returning();
  if (!d) return null;
  const [svc] = await db.select({ projectId: services.projectId }).from(services).where(eq(services.id, d.serviceId));
  const event = { type: "deployment.status", deploymentId, serviceId: d.serviceId, environmentId: d.environmentId, status: d.status, phase: d.phase, error: d.error };
  await publish(`deployment:${deploymentId}`, event);
  await publish(`service:${d.serviceId}`, event);
  if (svc) await publish(`project:${svc.projectId}`, event);
  return d;
}

export async function markPhase(deploymentId: string, phase: string) {
  const db = getDb();
  const [d] = await db.select({ phases: deployments.phases }).from(deployments).where(eq(deployments.id, deploymentId));
  const phases = { ...(d?.phases ?? {}) };
  const now = new Date().toISOString();
  for (const p of Object.values(phases)) if (!p.finishedAt) p.finishedAt = now;
  phases[phase] = { startedAt: now };
  await setDeploymentState(deploymentId, { phase, phases });
}

export async function isCancelled(deploymentId: string) {
  return (await redis().get(`sh:cancel:${deploymentId}`)) === "1";
}

export async function teamOfService(serviceId: string) {
  const [r] = await getDb().select({ teamId: projects.teamId, projectId: projects.id }).from(services).innerJoin(projects, eq(projects.id, services.projectId)).where(eq(services.id, serviceId));
  return r!;
}
