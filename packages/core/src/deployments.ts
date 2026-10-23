import { and, desc, eq, inArray } from "drizzle-orm";
import { deployments, environments, getDb, projects, serviceInstances, services, teams, users, type DeployFreeze } from "@skyhost/db";
import { TERMINAL_DEPLOYMENT_STATUSES } from "@skyhost/shared";
import { audit, type Actor } from "./audit";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { enqueue, getQueue } from "./queue";
import { publish } from "./realtime";
import { assertQuota } from "./quotas";
import { serverConfig } from "./config";
import { redis } from "./redis";

export function isDeployFrozen(freeze: DeployFreeze | null | undefined, now = new Date()): { frozen: boolean; reason?: string } {
  if (!freeze?.enabled || !freeze.windows?.length) return { frozen: false };
  const tz = freeze.timezone || "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);
  const hm = `${parts.find((p) => p.type === "hour")!.value.replace("24", "00")}:${parts.find((p) => p.type === "minute")!.value}`;
  const inWindow = freeze.windows.some((w) => w.days.includes(wd) && (w.start <= w.end ? hm >= w.start && hm < w.end : hm >= w.start || hm < w.end));
  const mode = freeze.mode ?? "deny";
  if (mode === "deny" && inWindow) return { frozen: true, reason: "Deployments are frozen during this maintenance window" };
  if (mode === "allow" && !inWindow) return { frozen: true, reason: "Deployments are only allowed during the configured deploy windows" };
  return { frozen: false };
}

export interface CreateDeploymentInput {
  serviceId: string;
  environmentId: string;
  trigger: "manual" | "git" | "rollback" | "api" | "cli" | "template" | "redeploy" | "preview" | "config";
  actor?: Actor | null;
  commit?: { sha?: string | null; message?: string | null; author?: string | null; branch?: string | null } | null;
  prNumber?: number | null;
  rollbackOfId?: string | null;
  /** Reuse an existing image (rollback / redeploy without rebuild). */
  image?: string | null;
  sourceRef?: Record<string, unknown> | null;
  isCanary?: boolean;
  /** Configuration to deploy with (rollback reuses the target's snapshot). */
  configSnapshot?: typeof services.$inferSelect["config"] | null;
  /** Skip the deploy freeze (used for rollbacks, which must always be possible). */
  bypassFreeze?: boolean;
}

export async function createDeployment(input: CreateDeploymentInput) {
  const db = getDb();
  const [row] = await db
    .select({ service: services, project: projects, team: teams })
    .from(services)
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(services.id, input.serviceId));
  if (!row || row.service.deletedAt) throw notFound("Service");
  const [env] = await db.select().from(environments).where(and(eq(environments.id, input.environmentId), eq(environments.projectId, row.project.id)));
  if (!env || env.deletedAt) throw notFound("Environment");
  const team = row.team;
  if (team.suspendedAt) throw forbidden(`This team is suspended${team.suspendedReason ? `: ${team.suspendedReason}` : ""}. Deployments are disabled.`);
  if (team.billingStatus === "suspended") throw forbidden("Deployments are disabled because of an unpaid invoice. Update your payment method to reactivate.");
  if (input.actor?.userId && serverConfig().SKYHOST_REQUIRE_EMAIL_VERIFICATION) {
    const [u] = await db.select({ verified: users.emailVerifiedAt }).from(users).where(eq(users.id, input.actor.userId));
    if (u && !u.verified) throw forbidden("Verify your email address before deploying.");
  }
  if (!input.bypassFreeze && input.trigger !== "rollback") {
    const f = isDeployFrozen(team.deployFreeze);
    if (f.frozen) throw forbidden(f.reason!);
  }
  if (team.spendCapCents != null && team.spendCapAction !== "alert") {
    const reached = await redis().get(`sh:spendcap:${team.id}`);
    if (reached === "1" && input.trigger !== "rollback") throw forbidden("The team spending cap has been reached. Raise the cap to deploy again.");
  }
  await assertQuota(team.id, "deploysPerDay");
  if (env.isEphemeral) {
    /* preview quotas are enforced when the preview environment is created */
  }

  const [dep] = await db
    .insert(deployments)
    .values({
      serviceId: row.service.id,
      environmentId: env.id,
      status: "queued",
      trigger: input.trigger,
      commitSha: input.commit?.sha ?? null,
      commitMessage: input.commit?.message?.slice(0, 500) ?? null,
      commitAuthor: input.commit?.author ?? null,
      branch: input.commit?.branch ?? (row.service.source as { branch?: string }).branch ?? null,
      prNumber: input.prNumber ?? null,
      image: input.image ?? null,
      sourceRef: input.sourceRef ?? null,
      configSnapshot: input.configSnapshot ?? row.service.config,
      rollbackOfId: input.rollbackOfId ?? null,
      isCanary: input.isCanary ?? false,
      createdBy: input.actor?.userId ?? null,
      createdByApiKeyId: input.actor?.apiKeyId ?? null,
    })
    .returning();
  await db.insert(serviceInstances).values({ serviceId: row.service.id, environmentId: env.id }).onConflictDoNothing();
  await enqueue("deploy", { deploymentId: dep!.id }, { jobId: dep!.id, attempts: 1 });
  await publish(`service:${row.service.id}`, { type: "deployment.created", deployment: dep });
  await publish(`project:${row.project.id}`, { type: "deployment.created", serviceId: row.service.id, deploymentId: dep!.id, status: "queued" });
  await audit(input.actor ?? null, team.id, input.trigger === "rollback" ? "deployment.rollback" : "deployment.create", { type: "deployment", id: dep!.id }, {
    serviceId: row.service.id,
    environment: env.name,
    trigger: input.trigger,
    commit: input.commit?.sha ?? null,
  });
  return dep!;
}

export async function cancelDeployment(deploymentId: string, actor: Actor | null, teamId: string) {
  const db = getDb();
  const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!dep) throw notFound("Deployment");
  if (TERMINAL_DEPLOYMENT_STATUSES.includes(dep.status as never)) throw conflict(`Deployment is already ${dep.status}`);
  // Flag for the worker (it aborts the build) and remove the job if it has not started yet.
  await redis().set(`sh:cancel:${deploymentId}`, "1", "EX", 3600);
  await redis().publish("sh:cancel", deploymentId);
  const job = await getQueue("deploy").getJob(deploymentId);
  const state = await job?.getState();
  if (job && (state === "waiting" || state === "delayed")) {
    await job.remove();
    await db.update(deployments).set({ status: "cancelled", finishedAt: new Date(), error: "Cancelled before it started" }).where(eq(deployments.id, deploymentId));
    await publish(`deployment:${deploymentId}`, { type: "deployment.status", status: "cancelled" });
    await publish(`service:${dep.serviceId}`, { type: "deployment.status", deploymentId, status: "cancelled" });
  }
  await audit(actor, teamId, "deployment.cancel", { type: "deployment", id: deploymentId });
}

export async function rollbackTo(targetDeploymentId: string, actor: Actor | null) {
  const db = getDb();
  const [target] = await db.select().from(deployments).where(eq(deployments.id, targetDeploymentId));
  if (!target) throw notFound("Deployment");
  if (!target.image) throw badRequest("This deployment has no image to roll back to (it never finished building).");
  if (!["live", "superseded", "stopped"].includes(target.status)) throw badRequest("You can only roll back to a deployment that was live before.");
  return createDeployment({
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    trigger: "rollback",
    actor,
    image: target.image,
    rollbackOfId: target.id,
    configSnapshot: target.configSnapshot,
    commit: { sha: target.commitSha, message: target.commitMessage, author: target.commitAuthor, branch: target.branch },
    bypassFreeze: true,
  });
}

export async function latestDeployments(serviceIds: string[]) {
  if (!serviceIds.length) return [];
  return getDb().select().from(deployments).where(inArray(deployments.serviceId, serviceIds)).orderBy(desc(deployments.createdAt)).limit(200);
}
