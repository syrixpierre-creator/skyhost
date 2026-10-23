import { and, count, eq, gte, inArray, isNull, sum } from "drizzle-orm";
import {
  buckets, databases, deployments, domains, environments, getDb, plans, projects, screenshots, services, teamInvites, teamMembers, teams, usageRecords, volumes,
} from "@skyhost/db";
import type { PlanFeatureKey, PlanLimitKey, PlanLimits } from "@skyhost/shared";
import { forbidden, notFound, quotaExceeded } from "./errors";
import { getSetting } from "./settings";

export type Plan = typeof plans.$inferSelect;

export async function getTeamPlan(teamId: string): Promise<Plan> {
  const db = getDb();
  const [team] = await db.select({ planId: teams.planId }).from(teams).where(eq(teams.id, teamId));
  if (!team) throw notFound("Team");
  if (team.planId) {
    const [p] = await db.select().from(plans).where(eq(plans.id, team.planId));
    if (p) return p;
  }
  const trial = (await getSetting("billing")).trialPlan;
  const [p] = await db.select().from(plans).where(eq(plans.slug, trial));
  if (!p) throw new Error(`Default plan "${trial}" is missing; run the seed`);
  return p;
}

export type Usage = Record<PlanLimitKey, number>;

const startOfMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export async function getUsage(teamId: string): Promise<Usage> {
  const db = getDb();
  const projectIds = (await db.select({ id: projects.id }).from(projects).where(and(eq(projects.teamId, teamId), isNull(projects.deletedAt)))).map((p) => p.id);
  const inProjects = projectIds.length ? projectIds : ["00000000-0000-0000-0000-000000000000"];
  const svcRows = await db
    .select({ id: services.id, type: services.type, config: services.config })
    .from(services)
    .where(and(inArray(services.projectId, inProjects), isNull(services.deletedAt)));
  const svcIds = svcRows.map((s) => s.id).length ? svcRows.map((s) => s.id) : ["00000000-0000-0000-0000-000000000000"];
  const n = async (q: Promise<Array<{ c: number | string | null }>>) => Number((await q)[0]?.c ?? 0);
  const since = startOfMonth();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);

  const [dbCount, dbStorage, members, invites, customDomains, deploysToday, shots, buildSeconds, previewEnvs, bucketCount, bucketQuota, volumeMb, bandwidth] = await Promise.all([
    n(db.select({ c: count() }).from(databases).where(and(eq(databases.teamId, teamId), isNull(databases.deletedAt)))),
    n(db.select({ c: sum(databases.storageMb) }).from(databases).where(and(eq(databases.teamId, teamId), isNull(databases.deletedAt)))),
    n(db.select({ c: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId))),
    n(db.select({ c: count() }).from(teamInvites).where(and(eq(teamInvites.teamId, teamId), isNull(teamInvites.acceptedAt), isNull(teamInvites.declinedAt), isNull(teamInvites.revokedAt), gte(teamInvites.expiresAt, new Date())))),
    n(db.select({ c: count() }).from(domains).where(and(inArray(domains.serviceId, svcIds)))),
    n(db.select({ c: count() }).from(deployments).where(and(inArray(deployments.serviceId, svcIds), gte(deployments.createdAt, dayAgo)))),
    n(db.select({ c: count() }).from(screenshots).where(and(inArray(screenshots.projectId, inProjects), gte(screenshots.createdAt, since)))),
    n(db.select({ c: sum(deployments.buildSeconds) }).from(deployments).where(and(inArray(deployments.serviceId, svcIds), gte(deployments.createdAt, since)))),
    n(db.select({ c: count() }).from(environments).where(and(inArray(environments.projectId, inProjects), eq(environments.isEphemeral, true), isNull(environments.deletedAt)))),
    n(db.select({ c: count() }).from(buckets).where(and(eq(buckets.teamId, teamId), isNull(buckets.deletedAt)))),
    n(db.select({ c: sum(buckets.quotaMb) }).from(buckets).where(and(eq(buckets.teamId, teamId), isNull(buckets.deletedAt)))),
    n(db.select({ c: sum(volumes.sizeMb) }).from(volumes).where(inArray(volumes.serviceId, svcIds))),
    n(db.select({ c: sum(usageRecords.quantity) }).from(usageRecords).where(and(eq(usageRecords.teamId, teamId), eq(usageRecords.metric, "bandwidth_bytes"), gte(usageRecords.periodStart, since)))),
  ]);

  let cpu = 0;
  let memoryMb = 0;
  for (const s of svcRows) {
    if (s.type === "static" || s.type === "job") continue;
    const r = s.config.resources ?? { cpu: 0.5, memoryMb: 512, replicas: 1 };
    cpu += (r.cpu ?? 0.5) * (r.replicas ?? 1);
    memoryMb += (r.memoryMb ?? 512) * (r.replicas ?? 1);
  }
  return {
    cpu: Math.round(cpu * 100) / 100,
    memoryMb,
    storageMb: dbStorage + volumeMb,
    bandwidthGb: Math.round((bandwidth / 1024 ** 3) * 100) / 100,
    buildMinutes: Math.ceil(buildSeconds / 60),
    services: svcRows.length,
    databases: dbCount,
    members: members + invites,
    deploysPerDay: deploysToday,
    logRetentionDays: 0,
    backupRetentionDays: 0,
    customDomains,
    screenshotsPerMonth: shots,
    previewEnvironments: previewEnvs,
    projects: projectIds.length,
    volumesMb: volumeMb,
    buckets: bucketCount,
    bucketStorageMb: bucketQuota,
    cronJobs: svcRows.filter((s) => s.type === "cron").length,
  };
}

/** Throws a 402 quota error when adding `increment` would exceed the plan limit. Enforced server side for every create. */
export async function assertQuota(teamId: string, key: PlanLimitKey, increment = 1) {
  const plan = await getTeamPlan(teamId);
  const limit = (plan.limits as PlanLimits)[key];
  if (limit === undefined || limit < 0) return;
  const usage = await getUsage(teamId);
  if (usage[key] + increment > limit) {
    throw quotaExceeded(`Your ${plan.name} plan allows ${limit} ${labelOf(key)}. Upgrade your plan to add more.`, { key, limit, current: usage[key], plan: plan.slug });
  }
}

export async function assertFeature(teamId: string, feature: PlanFeatureKey) {
  const plan = await getTeamPlan(teamId);
  if (!plan.features[feature]) throw forbidden(`This feature (${feature}) is not included in the ${plan.name} plan.`);
}

export function labelOf(key: PlanLimitKey): string {
  const labels: Partial<Record<PlanLimitKey, string>> = {
    cpu: "vCPU",
    memoryMb: "MB of memory",
    storageMb: "MB of storage",
    bandwidthGb: "GB of bandwidth",
    buildMinutes: "build minutes per month",
    deploysPerDay: "deployments per day",
    customDomains: "custom domains",
    screenshotsPerMonth: "screenshots per month",
    previewEnvironments: "preview environments",
    volumesMb: "MB of volumes",
    bucketStorageMb: "MB of object storage",
    cronJobs: "cron jobs",
  };
  return labels[key] ?? key;
}

export async function usageSummary(teamId: string) {
  const plan = await getTeamPlan(teamId);
  const usage = await getUsage(teamId);
  const limits = plan.limits as PlanLimits;
  return {
    plan: { id: plan.id, slug: plan.slug, name: plan.name, priceCents: plan.priceCents, features: plan.features },
    items: (Object.keys(limits) as PlanLimitKey[]).map((k) => ({ key: k, label: labelOf(k), current: usage[k], limit: limits[k], remaining: Math.max(0, limits[k] - usage[k]) })),
  };
}


