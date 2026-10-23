import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { and, avg, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql, sum } from "drizzle-orm";
import {
  abuseDecisions, abuseReports, alertRules, databaseBackups, databases, deploymentLogs, deployments, domains, environments, getDb, jobRuns, metricSamples, nodes, payments, plans, projects,
  screenshots, serviceInstances, services, teams, uptimeChecks, uptimeResults, usageRecords,
} from "@skyhost/db";
import type { PlanLimitKey, ServiceConfig } from "@skyhost/shared";
import { assertPublicUrl } from "@skyhost/shared/node";
import { attachEdgeToAllNetworks, containerStats, databaseStats, getDocker, getObjectStore, LABEL, listManagedContainers, stopContainer, tailLogs } from "@skyhost/engine";
import { analyzeErrors } from "@skyhost/analyzer";
import {
  approveDueRewards, audit, checkServerHealth, closeUsagePeriod, emailAdmins, enqueue, getSetting, getTeamPlan, getUsage, isDue, notify, redis, serviceHostname, verifyDomain, labelOf,
} from "@skyhost/core";
import { refOf } from "./processors/data";
import { platformBackup } from "./offsite";

const TICK_MS = 30_000;

/** Runs `fn` at most once per `everyMs` across the whole cluster. */
async function every(name: string, everyMs: number, fn: () => Promise<unknown>) {
  const key = `sh:sched:${name}`;
  if (!(await redis().set(key, String(Date.now()), "PX", everyMs, "NX"))) return;
  try {
    await fn();
  } catch (e) {
    console.error(`[scheduler] ${name} failed:`, (e as Error).message);
  }
}

// ------------------------------------------------------------------------------------------- Cron jobs & backups
async function runCronJobs(from: Date, to: Date) {
  const db = getDb();
  const rows = await db
    .select({ svc: services, inst: serviceInstances, team: teams })
    .from(serviceInstances)
    .innerJoin(services, eq(services.id, serviceInstances.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(eq(services.type, "cron"), isNull(services.deletedAt), isNotNull(serviceInstances.liveDeploymentId), isNull(teams.suspendedAt)));
  for (const { svc, inst, team } of rows) {
    const cron = svc.config.cron;
    if (!cron?.enabled || team.billingStatus === "suspended" || inst.status === "paused") continue;
    if (!isDue(cron.schedule, cron.timezone, from, to)) continue;
    const [run] = await db.insert(jobRuns).values({ serviceId: svc.id, environmentId: inst.environmentId, kind: "cron", command: svc.config.startCommand ?? "(image default)" }).returning();
    await enqueue("job", { jobRunId: run!.id }, { jobId: run!.id });
  }
}

async function scheduleBackups(from: Date, to: Date) {
  const db = getDb();
  const dbs = await db.select().from(databases).where(and(eq(databases.status, "available"), eq(databases.backupsEnabled, true), isNull(databases.deletedAt)));
  for (const d of dbs) {
    if (!isDue(d.backupSchedule, "UTC", from, to)) continue;
    const [b] = await db.insert(databaseBackups).values({ databaseId: d.id, kind: "scheduled" }).returning();
    await enqueue("backup", { action: "backup", backupId: b!.id }, { jobId: b!.id, attempts: 3, backoff: { type: "exponential", delay: 60_000 } });
  }
  // Retention: remove expired backups (never the last completed one).
  const expired = await db.select().from(databaseBackups).where(and(lte(databaseBackups.expiresAt, new Date()), eq(databaseBackups.status, "completed")));
  for (const b of expired) {
    const [{ c } = { c: 0 }] = await db.select({ c: sql<number>`count(*)` }).from(databaseBackups).where(and(eq(databaseBackups.databaseId, b.databaseId), eq(databaseBackups.status, "completed")));
    if (Number(c) <= 1) continue;
    if (b.objectKey) await getObjectStore().delete(b.objectKey).catch(() => {});
    await db.delete(databaseBackups).where(eq(databaseBackups.id, b.id));
  }
}

// ------------------------------------------------------------------------------------------- Metrics, crashes, sleep, abuse
const lastNet = new Map<string, { rx: number; at: number; idleSince: number }>();

async function sampleMetrics() {
  const db = getDb();
  const rows = await db
    .select({ inst: serviceInstances, svc: services, dep: deployments, team: teams })
    .from(serviceInstances)
    .innerJoin(services, eq(services.id, serviceInstances.serviceId))
    .innerJoin(deployments, eq(deployments.id, serviceInstances.liveDeploymentId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(isNull(services.deletedAt), inArray(serviceInstances.status, ["running", "crashed"])));
  for (const { inst, svc, dep, team } of rows) {
    if (!dep.containers.length || inst.sleeping) continue;
    let cpu = 0;
    let mem = 0;
    let limit = 0;
    let rx = 0;
    let tx = 0;
    let restarts = 0;
    let running = 0;
    for (const c of dep.containers) {
      const s = await containerStats(c);
      if (!s) continue;
      cpu += s.cpuPercent;
      mem += s.memoryBytes;
      limit += s.memoryLimitBytes;
      rx += s.netRxBytes;
      tx += s.netTxBytes;
      restarts += s.restarts;
      if (s.running) running++;
    }
    const up = running === dep.containers.length;
    await db.insert(metricSamples).values({ serviceId: svc.id, environmentId: inst.environmentId, cpuPercent: cpu, memoryBytes: mem, memoryLimitBytes: limit, netRxBytes: rx, netTxBytes: tx, restarts, up });
    const now = new Date();
    await db.insert(usageRecords).values([
      { teamId: team.id, serviceId: svc.id, metric: "cpu_seconds", quantity: (cpu / 100) * 60, periodStart: now },
      { teamId: team.id, serviceId: svc.id, metric: "memory_mb_seconds", quantity: (mem / 1048576) * 60, periodStart: now },
    ]);
    const prev = lastNet.get(inst.id);
    if (prev && tx >= 0) {
      const delta = Math.max(0, tx - (lastNet.get(`${inst.id}:tx`)?.rx ?? tx));
      if (delta) await db.insert(usageRecords).values({ teamId: team.id, serviceId: svc.id, metric: "bandwidth_bytes", quantity: delta, periodStart: now });
    }
    lastNet.set(`${inst.id}:tx`, { rx: tx, at: Date.now(), idleSince: 0 });

    // Crash detection
    if (restarts > inst.restartCount) {
      await db.update(serviceInstances).set({ restartCount: restarts, status: up ? "running" : "crashed" }).where(eq(serviceInstances.id, inst.id));
      // The email carries the crash output and the Smart Error Analyzer's reading of it.
      const logs = await tailLogs(dep.containers[0]!, 60);
      const diag = analyzeErrors(logs, { port: (svc.config as ServiceConfig).port, memoryMb: (svc.config as ServiceConfig).resources?.memoryMb })[0];
      await notify({
        teamId: team.id,
        event: "service.crashed",
        title: `${svc.name} crashed`,
        body: `${diag ? `${diag.problem}. ` : ""}The process exited and was restarted (${restarts} restart${restarts > 1 ? "s" : ""}).`,
        link: `/projects/${svc.projectId}/services/${svc.id}?tab=logs`,
        details: diag ? [["Cause", diag.cause], ["Suggested fix", diag.suggestedFix]] : undefined,
        logs,
      });
    } else if (!up && inst.status !== "crashed") {
      await db.update(serviceInstances).set({ status: "crashed" }).where(eq(serviceInstances.id, inst.id));
      const logs = await tailLogs(dep.containers[0]!, 60);
      await notify({ teamId: team.id, event: "service.unhealthy", title: `${svc.name} is down`, body: "No replica is running. Visitors get an error until it starts again.", link: `/projects/${svc.projectId}/services/${svc.id}?tab=logs`, logs });
    }

    // Sleep when idle: no inbound traffic during sleepAfterMinutes.
    const cfg = svc.config as ServiceConfig;
    if (cfg.sleepAfterMinutes > 0 && ["web", "docker", "static"].includes(svc.type)) {
      const p = lastNet.get(inst.id);
      const active = !p || rx - p.rx > 2048;
      const idleSince = active ? Date.now() : p.idleSince;
      lastNet.set(inst.id, { rx, at: Date.now(), idleSince });
      const lastReq = inst.lastRequestAt?.getTime() ?? 0;
      if (Date.now() - Math.max(idleSince, lastReq) > cfg.sleepAfterMinutes * 60_000) {
        for (const c of dep.containers) await stopContainer(c, 10);
        await db.update(serviceInstances).set({ sleeping: true, status: "sleeping" }).where(eq(serviceInstances.id, inst.id));
        lastNet.delete(inst.id);
      }
    } else lastNet.set(inst.id, { rx, at: Date.now(), idleSince: Date.now() });

    // Abuse heuristics: crypto miners (process names) and sustained CPU saturation on the free plan.
    await detectAbuse(svc, team, dep.containers, cpu);
  }

  // Databases
  const dbs = await db.select().from(databases).where(and(eq(databases.status, "available"), isNull(databases.deletedAt)));
  for (const d of dbs) {
    const s = await containerStats(d.containerName);
    const st = await databaseStats(refOf(d));
    await db.insert(metricSamples).values({ databaseId: d.id, cpuPercent: s?.cpuPercent ?? 0, memoryBytes: s?.memoryBytes ?? 0, memoryLimitBytes: s?.memoryLimitBytes ?? 0, netRxBytes: s?.netRxBytes ?? 0, netTxBytes: s?.netTxBytes ?? 0, diskBytes: st.sizeBytes, requests: st.connections, up: !!s?.running });
  }
}

const MINER = /\b(xmrig|minerd|cpuminer|ethminer|nbminer|t-rex|phoenixminer|lolminer|cgminer|bfgminer|xmr-stak)\b/i;

async function detectAbuse(svc: typeof services.$inferSelect, team: typeof teams.$inferSelect, containers: string[], cpu: number) {
  const db = getDb();
  for (const c of containers) {
    const top = (await getDocker().getContainer(c).top({ ps_args: "-eo comm,args" }).catch(() => null)) as { Processes?: string[][] } | null;
    const hit = top?.Processes?.find((p) => MINER.test(p.join(" ")));
    if (hit) {
      await db.insert(abuseReports).values({ targetUrl: `service:${svc.id}`, category: "mining", description: `Detected process: ${hit.join(" ").slice(0, 200)}`, serviceId: svc.id, teamId: team.id, source: "detector", status: "actioned" });
      await db.update(teams).set({ suspendedAt: new Date(), suspendedReason: "Cryptocurrency mining is not allowed" }).where(eq(teams.id, team.id));
      await db.insert(abuseDecisions).values({ teamId: team.id, action: "suspend", reason: "Automatic: crypto miner detected", automatic: true });
      for (const x of containers) await stopContainer(x, 1);
      await audit(null, team.id, "abuse.auto_suspended", { type: "service", id: svc.id }, { reason: "mining" });
      return;
    }
  }
  const plan = await getTeamPlan(team.id);
  if (plan.isFree && cpu > 90) {
    const key = `sh:abuse:cpu:${svc.id}`;
    const n = await redis().incr(key);
    await redis().expire(key, 3600);
    if (n === 30) await db.insert(abuseReports).values({ targetUrl: `service:${svc.id}`, category: "mining", description: "Sustained CPU above 90% for 30 minutes on the free plan", serviceId: svc.id, teamId: team.id, source: "detector" });
  }
}

async function evaluateAlerts() {
  const db = getDb();
  const rules = await db.select().from(alertRules).where(eq(alertRules.enabled, true));
  for (const r of rules) {
    if (r.lastTriggeredAt && Date.now() - r.lastTriggeredAt.getTime() < 3600_000) continue;
    if (r.metric !== "cpu" && r.metric !== "memory") continue;
    const since = new Date(Date.now() - r.durationMinutes * 60_000);
    const [agg] = await db
      .select({ cpu: avg(metricSamples.cpuPercent), mem: avg(sql<number>`case when ${metricSamples.memoryLimitBytes} > 0 then ${metricSamples.memoryBytes}::float / ${metricSamples.memoryLimitBytes} * 100 else 0 end`) })
      .from(metricSamples)
      .where(and(r.serviceId ? eq(metricSamples.serviceId, r.serviceId) : isNotNull(metricSamples.serviceId), gte(metricSamples.createdAt, since)));
    const value = Number((r.metric === "cpu" ? agg?.cpu : agg?.mem) ?? 0);
    if (value >= (r.threshold ?? 100)) {
      await db.update(alertRules).set({ lastTriggeredAt: new Date() }).where(eq(alertRules.id, r.id));
      await notify({ teamId: r.teamId, event: "alert.triggered", title: `High ${r.metric} usage`, body: `Average ${r.metric} was ${value.toFixed(1)}% over the last ${r.durationMinutes} minutes (threshold ${r.threshold}%).` });
    }
  }
}

// ------------------------------------------------------------------------------------------- Uptime, domains
async function runUptimeChecks() {
  const db = getDb();
  const checks = await db.select().from(uptimeChecks).where(eq(uptimeChecks.enabled, true));
  for (const c of checks) {
    if (c.lastCheckedAt && Date.now() - c.lastCheckedAt.getTime() < c.intervalSeconds * 1000 - 5000) continue;
    const t0 = Date.now();
    let up = false;
    let status: number | null = null;
    let error: string | null = null;
    try {
      await assertPublicUrl(c.url);
      const res = await fetch(c.url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "SKYHOST-Uptime/1.0" } });
      status = res.status;
      up = res.status === c.expectedStatus || (c.expectedStatus === 200 && res.status < 400);
    } catch (e) {
      error = (e as Error).message;
    }
    await db.insert(uptimeResults).values({ checkId: c.id, up, statusCode: status, latencyMs: Date.now() - t0, error });
    const next = up ? "up" : "down";
    await db.update(uptimeChecks).set({ lastStatus: next, lastCheckedAt: new Date() }).where(eq(uptimeChecks.id, c.id));
    if (c.lastStatus && c.lastStatus !== next) {
      const [p] = await db.select().from(projects).where(eq(projects.id, c.projectId));
      if (p) await notify({ teamId: p.teamId, event: up ? "deployment.succeeded" : "service.unhealthy", title: `${c.name} is ${next}`, body: up ? "The check passes again." : `The check failed: ${error ?? `HTTP ${status}`}`, link: `/projects/${p.id}?tab=uptime` });
    }
  }
}

async function pollDomains() {
  const db = getDb();
  const pending = await db.select().from(domains).where(inArray(domains.status, ["pending", "error"]));
  for (const d of pending) {
    if (Date.now() - d.createdAt.getTime() > 7 * 86400_000) continue;
    let target = "";
    if (d.serviceId) {
      const [s] = await db.select().from(services).where(eq(services.id, d.serviceId));
      const [env] = d.environmentId ? await db.select().from(environments).where(eq(environments.id, d.environmentId)) : await db.select().from(environments).where(and(eq(environments.projectId, s!.projectId), eq(environments.type, "production")));
      if (s && env) target = serviceHostname(s, env);
    }
    const r = await verifyDomain(d.hostname, target, d.verificationToken).catch(() => null);
    if (r?.ownership && r.routing) {
      await db.update(domains).set({ status: "verified", verifiedAt: new Date(), lastCheckedAt: new Date(), error: null }).where(eq(domains.id, d.id));
      await enqueue("maintenance", { task: `check-certificate:${d.id}` }, { delay: 15_000 });
    } else await db.update(domains).set({ lastCheckedAt: new Date() }).where(eq(domains.id, d.id));
  }
}

// ------------------------------------------------------------------------------------------- Billing, spend caps, quotas
async function billingHousekeeping() {
  const db = getDb();
  const settings = await getSetting("billing");
  // Grace period over: suspend services until payment.
  const overdue = await db.select().from(teams).where(and(eq(teams.billingStatus, "past_due"), lte(teams.graceEndsAt, new Date())));
  for (const t of overdue) {
    await db.update(teams).set({ billingStatus: "suspended" }).where(eq(teams.id, t.id));
    const insts = await db.select({ id: serviceInstances.id, serviceId: serviceInstances.serviceId, environmentId: serviceInstances.environmentId }).from(serviceInstances).innerJoin(services, eq(services.id, serviceInstances.serviceId)).innerJoin(projects, eq(projects.id, services.projectId)).where(eq(projects.teamId, t.id));
    for (const i of insts) {
      await db.update(serviceInstances).set({ status: "paused", pausedReason: "billing" }).where(eq(serviceInstances.id, i.id));
      await enqueue("maintenance", { task: `stop:${i.serviceId}:${i.environmentId}` });
    }
    await notify({ teamId: t.id, event: "billing.payment_failed", title: "Services suspended for non-payment", body: "Your services were paused because the invoice is still unpaid. Pay to reactivate them immediately.", link: "/billing" });
    await audit(null, t.id, "billing.suspended", { type: "team", id: t.id });
  }
  // Dunning reminders during the grace period.
  const pastDue = await db.select().from(teams).where(eq(teams.billingStatus, "past_due"));
  for (const t of pastDue) {
    if (!t.graceEndsAt) continue;
    const daysLeft = Math.ceil((t.graceEndsAt.getTime() - Date.now()) / 86400_000);
    const day = settings.graceDays - daysLeft;
    if (!settings.dunningDays.includes(day)) continue;
    if (!(await redis().set(`sh:dunning:${t.id}:${day}`, "1", "EX", 3 * 86400, "NX"))) continue;
    await notify({ teamId: t.id, event: "billing.payment_failed", title: "Reminder: payment failed", body: `Update your payment method within ${daysLeft} day(s) to avoid suspension.`, link: "/billing" });
  }
  // Credits-funded subscriptions expire at period end.
  const { subscriptions } = await import("@skyhost/db");
  const ended = await db.select().from(subscriptions).where(and(eq(subscriptions.provider, "credits"), eq(subscriptions.status, "active"), lte(subscriptions.currentPeriodEnd, new Date())));
  const [free] = await db.select().from(plans).where(eq(plans.slug, settings.trialPlan));
  for (const s of ended) {
    await db.update(subscriptions).set({ status: "cancelled" }).where(eq(subscriptions.id, s.id));
    await db.update(teams).set({ planId: free?.id ?? null, billingStatus: "cancelled" }).where(eq(teams.id, s.teamId));
  }
}

async function spendCaps() {
  const db = getDb();
  const capped = await db.select().from(teams).where(and(isNotNull(teams.spendCapCents), isNull(teams.deletedAt)));
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const monthKey = monthStart.toISOString().slice(0, 7);
  for (const t of capped) {
    const [{ s } = { s: 0 }] = await db.select({ s: sum(payments.amountCents) }).from(payments).where(and(eq(payments.teamId, t.id), eq(payments.status, "succeeded"), gte(payments.createdAt, monthStart), ne(payments.provider, "credits")));
    const spent = Number(s ?? 0);
    const pct = t.spendCapCents ? (spent / t.spendCapCents) * 100 : 0;
    const sent = t.spendAlertsSent[monthKey] ?? [];
    for (const threshold of [50, 80, 100]) {
      if (pct < threshold || sent.includes(threshold)) continue;
      sent.push(threshold);
      await notify({ teamId: t.id, event: "spend.threshold", title: `Spending at ${threshold}% of your cap`, body: `This month: ${(spent / 100).toFixed(2)} of ${(t.spendCapCents! / 100).toFixed(2)}.${threshold === 100 && t.spendCapAction !== "alert" ? ` Action: ${t.spendCapAction === "pause_services" ? "services paused" : "new deployments blocked"}.` : ""}`, link: "/billing" });
      if (threshold === 100 && t.spendCapAction !== "alert") {
        await redis().set(`sh:spendcap:${t.id}`, "1", "EX", 40 * 86400);
        if (t.spendCapAction === "pause_services") {
          const insts = await db.select({ id: serviceInstances.id, serviceId: serviceInstances.serviceId, environmentId: serviceInstances.environmentId }).from(serviceInstances).innerJoin(services, eq(services.id, serviceInstances.serviceId)).innerJoin(projects, eq(projects.id, services.projectId)).where(eq(projects.teamId, t.id));
          for (const i of insts) {
            await db.update(serviceInstances).set({ status: "paused", pausedReason: "spend_cap" }).where(eq(serviceInstances.id, i.id));
            await enqueue("maintenance", { task: `stop:${i.serviceId}:${i.environmentId}` });
          }
        }
      }
    }
    await db.update(teams).set({ spendAlertsSent: { [monthKey]: sent } }).where(eq(teams.id, t.id));
  }
}

async function quotaWarnings() {
  const db = getDb();
  const all = await db.select({ id: teams.id }).from(teams).where(isNull(teams.deletedAt));
  for (const t of all) {
    const plan = await getTeamPlan(t.id);
    const usage = await getUsage(t.id);
    for (const k of ["buildMinutes", "bandwidthGb", "screenshotsPerMonth", "storageMb"] as PlanLimitKey[]) {
      const limit = plan.limits[k];
      if (!limit || usage[k] < limit * 0.8) continue;
      if (!(await redis().set(`sh:quota-warn:${t.id}:${k}`, "1", "EX", 86400, "NX"))) continue;
      await notify({ teamId: t.id, event: "quota.near_limit", title: `You used ${Math.round((usage[k] / limit) * 100)}% of your ${labelOf(k)}`, body: `${usage[k]} of ${limit}. Upgrade your plan to avoid interruptions.`, link: "/billing" });
    }
  }
}

// ------------------------------------------------------------------------------------------- Retention & cleanup
async function retention() {
  const db = getDb();
  const allTeams = await db.select().from(teams);
  for (const t of allTeams) {
    const plan = await getTeamPlan(t.id);
    const logsDays = Math.min(t.retention.logsDays ?? plan.limits.logRetentionDays, plan.limits.logRetentionDays);
    const svcIds = (await db.select({ id: services.id }).from(services).innerJoin(projects, eq(projects.id, services.projectId)).where(eq(projects.teamId, t.id))).map((s) => s.id);
    if (!svcIds.length) continue;
    const depIds = (await db.select({ id: deployments.id }).from(deployments).where(and(inArray(deployments.serviceId, svcIds), lt(deployments.createdAt, new Date(Date.now() - logsDays * 86400_000))))).map((d) => d.id);
    for (let i = 0; i < depIds.length; i += 500) await db.delete(deploymentLogs).where(inArray(deploymentLogs.deploymentId, depIds.slice(i, i + 500)));
    if (t.retention.screenshotsDays) {
      const old = await db.select().from(screenshots).where(and(inArray(screenshots.serviceId, svcIds), lt(screenshots.createdAt, new Date(Date.now() - t.retention.screenshotsDays * 86400_000))));
      for (const s of old) {
        if (s.objectKey) await getObjectStore().delete(s.objectKey).catch(() => {});
        await db.delete(screenshots).where(eq(screenshots.id, s.id));
      }
    }
    const previewDays = t.retention.previewsDays ?? 14;
    const projIds = (await db.select({ id: projects.id }).from(projects).where(eq(projects.teamId, t.id))).map((p) => p.id);
    if (projIds.length) {
      const stale = await db.select().from(environments).where(and(inArray(environments.projectId, projIds), eq(environments.isEphemeral, true), isNull(environments.deletedAt), lt(environments.createdAt, new Date(Date.now() - previewDays * 86400_000))));
      for (const e of stale) {
        await db.update(environments).set({ deletedAt: new Date() }).where(eq(environments.id, e.id));
        await enqueue("maintenance", { task: `teardown-environment:${e.id}` });
      }
    }
  }
  await db.delete(metricSamples).where(lt(metricSamples.createdAt, new Date(Date.now() - 31 * 86400_000)));
  await db.delete(uptimeResults).where(lt(uptimeResults.createdAt, new Date(Date.now() - 91 * 86400_000)));
  await db.delete(jobRuns).where(lt(jobRuns.createdAt, new Date(Date.now() - 31 * 86400_000)));
  // Superseded containers that survived a crash of the deploy worker.
  for (const c of await listManagedContainers({ [LABEL.kind]: "app" })) {
    const depId = c.Labels[LABEL.deployment];
    if (!depId) continue;
    const [d] = await db.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, depId));
    if (!d || ["superseded", "failed", "cancelled", "stopped"].includes(d.status)) {
      if (c.State !== "running" || !d) await getDocker().getContainer(c.Id).remove({ force: true }).catch(() => {});
    }
  }
}

/**
 * Crypto-mining and runaway processes: a service that uses nearly all of its CPU for hours. On a free plan it is
 * paused (an abuse report explains why and an administrator can resume it); on a paid plan administrators are
 * only told. Thresholds: SKYHOST_ABUSE_CPU_RATIO (0.9 of the allocated vCPU) over SKYHOST_ABUSE_CPU_HOURS (2).
 */
export async function detectCpuAbuse() {
  const db = getDb();
  const ratio = Number(process.env.SKYHOST_ABUSE_CPU_RATIO ?? 0.9);
  const hours = Number(process.env.SKYHOST_ABUSE_CPU_HOURS ?? 2);
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = await db
    .select({ inst: serviceInstances, svc: services, teamId: projects.teamId })
    .from(serviceInstances)
    .innerJoin(services, eq(services.id, serviceInstances.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(and(eq(serviceInstances.status, "running"), isNull(services.deletedAt)));
  for (const { inst, svc, teamId } of rows) {
    const [m] = await db
      .select({ avg: avg(metricSamples.cpuPercent), n: sql<number>`count(*)::int`, first: sql<Date>`min(${metricSamples.createdAt})` })
      .from(metricSamples)
      .where(and(eq(metricSamples.serviceId, svc.id), eq(metricSamples.environmentId, inst.environmentId), gte(metricSamples.createdAt, since)));
    // Enough samples spread over the whole window (one per minute), not a burst after a deploy.
    if (!m || m.n < hours * 40 || new Date(m.first).getTime() > since.getTime() + 15 * 60_000) continue;
    const cfg = svc.config as ServiceConfig;
    const allocated = (cfg.resources?.cpu ?? 0.5) * (cfg.resources?.replicas ?? 1) * 100;
    const usage = Number(m.avg) / allocated;
    if (usage < ratio) continue;
    const [recent] = await db.select({ id: abuseReports.id }).from(abuseReports).where(and(eq(abuseReports.serviceId, svc.id), eq(abuseReports.source, "detector"), gte(abuseReports.createdAt, new Date(Date.now() - 24 * 3600_000))));
    if (recent) continue;
    const plan = await getTeamPlan(teamId);
    const pause = plan.isFree;
    const pct = Math.round(usage * 100);
    await db.insert(abuseReports).values({
      targetUrl: `service:${svc.id}`,
      category: "mining",
      description: `${svc.name} used ${pct}% of its ${cfg.resources?.cpu ?? 0.5} vCPU on average for ${hours} hours${pause ? " and was paused automatically (free plan)" : ""}.`,
      serviceId: svc.id,
      teamId,
      status: "open",
      source: "detector",
    });
    if (pause) {
      await db.update(serviceInstances).set({ status: "paused", pausedReason: "abuse" }).where(eq(serviceInstances.id, inst.id));
      await enqueue("maintenance", { task: `stop:${svc.id}:${inst.environmentId}` });
      await notify({ teamId, event: "alert.triggered", title: `${svc.name} was paused`, body: `It used ${pct}% of its CPU for ${hours} hours, which looks like crypto-mining or a runaway process. Contact support if this is expected; paid plans are not paused.`, link: `/projects/${svc.projectId}/services/${svc.id}` });
    }
    await emailAdmins(`Sustained CPU usage: ${svc.name}`, [`${svc.name} (team ${teamId}) used ${pct}% of its CPU for ${hours} hours.`, pause ? "It was paused automatically (free plan). Review the abuse report: dismiss it to keep it paused, or unsuspend the team to resume it." : "It runs on a paid plan and was not paused."], { cooldownKey: `cpu-abuse:${svc.id}`, cooldownSeconds: 24 * 3600, link: "/admin/abuse" });
  }
}

/**
 * Keeps the server's disk in check: images of old releases (the live one and the last few stay for rollbacks),
 * images and containers of deleted services or databases, BuildKit cache older than three days.
 */
const KEEP_IMAGES = 3;
async function diskCleanup() {
  const db = getDb();
  const docker = getDocker();
  const images = await docker.listImages({ filters: { label: [`${LABEL.service}`] } });
  const byService = new Map<string, Array<{ id: string; deploymentId: string; created: number }>>();
  for (const i of images) {
    const sid = i.Labels?.[LABEL.service];
    const did = i.Labels?.[LABEL.deployment];
    if (!sid || !did) continue;
    byService.set(sid, [...(byService.get(sid) ?? []), { id: i.Id, deploymentId: did, created: i.Created }]);
  }
  for (const [sid, imgs] of byService) {
    const [svc] = await db.select({ deletedAt: services.deletedAt }).from(services).where(eq(services.id, sid));
    const live = new Set((await db.select({ a: serviceInstances.liveDeploymentId, b: serviceInstances.canaryDeploymentId }).from(serviceInstances).where(eq(serviceInstances.serviceId, sid))).flatMap((r) => [r.a, r.b]).filter(Boolean));
    const removable = !svc || svc.deletedAt ? imgs : imgs.filter((i) => !live.has(i.deploymentId)).sort((a, b) => b.created - a.created).slice(KEEP_IMAGES);
    for (const i of removable) await docker.getImage(i.id).remove({ force: !svc || !!svc.deletedAt }).catch(() => {}); // in use → skipped
  }
  // Containers whose service or database no longer exists (deleted while a worker was down).
  for (const c of await listManagedContainers({})) {
    const sid = c.Labels[LABEL.service];
    const dbid = c.Labels[LABEL.database];
    if (sid) {
      const [s] = await db.select({ deletedAt: services.deletedAt }).from(services).where(eq(services.id, sid));
      if (!s || s.deletedAt) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
    } else if (dbid) {
      const [d] = await db.select({ deletedAt: databases.deletedAt }).from(databases).where(eq(databases.id, dbid));
      if (!d || d.deletedAt) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
    }
  }
  await docker.pruneImages({ filters: { dangling: { true: true } } }).catch(() => {});
  const builder = process.env.SKYHOST_BUILDX_BUILDER;
  if (builder) {
    // The builder runs in its own container (docker-container driver): prune its cache with buildctl inside it.
    await new Promise<void>((resolve) => execFile("docker", ["exec", `buildx_buildkit_${builder}0`, "buildctl", "prune", "--keep-duration", "72h"], { timeout: 600_000 }, () => resolve()));
  }
}

async function failStaleDeployments() {
  const db = getDb();
  const cutoff = new Date(Date.now() - (Number(process.env.SKYHOST_BUILD_TIMEOUT ?? 1800) + 600) * 1000);
  const stale = await db.select().from(deployments).where(and(inArray(deployments.status, ["building", "deploying"]), lt(deployments.startedAt, cutoff)));
  for (const d of stale) await db.update(deployments).set({ status: "failed", error: "The deployment timed out (worker lost)", finishedAt: new Date() }).where(eq(deployments.id, d.id));
}

export async function heartbeat(roles: string[]) {
  const name = process.env.SKYHOST_NODE_NAME ?? hostname();
  await getDb()
    .insert(nodes)
    .values({ name, regionId: process.env.SKYHOST_REGION ?? "eu-west", roles, lastHeartbeatAt: new Date(), info: { pid: process.pid, version: process.env.SKYHOST_VERSION ?? "dev" } })
    .onConflictDoUpdate({ target: nodes.name, set: { roles, lastHeartbeatAt: new Date(), status: "online" } });
}

export function startScheduler() {
  let last = new Date(Date.now() - TICK_MS);
  const tick = async () => {
    const now = new Date();
    const from = last;
    last = now;
    // Self-healing: after Traefik or a worker is recreated, reconnect them to every team network.
    await every("edge-networks", 30_000, attachEdgeToAllNetworks);
    await every("cron", 25_000, () => runCronJobs(from, now));
    await every("backups", 25_000, () => scheduleBackups(from, now));
    await every("metrics", 55_000, sampleMetrics);
    await every("alerts", 60_000, evaluateAlerts);
    await every("uptime", 25_000, runUptimeChecks);
    await every("domains", 5 * 60_000, pollDomains);
    await every("referrals", 60 * 60_000, () => approveDueRewards());
    await every("billing", 10 * 60_000, billingHousekeeping);
    await every("spendcap", 10 * 60_000, spendCaps);
    await every("quota-warnings", 60 * 60_000, quotaWarnings);
    await every("retention", 6 * 60 * 60_000, retention);
    await every("disk-cleanup", 6 * 60 * 60_000, diskCleanup);
    await every("cpu-abuse", 10 * 60_000, detectCpuAbuse);
    await every("server-health", 5 * 60_000, checkServerHealth);
    // Usage beyond the plan is billed once per team and month (idempotent), checked every few hours.
    await every("usage-billing", 3 * 60 * 60_000, () => closeUsagePeriod());
    await every("offsite-platform", 24 * 60 * 60_000, platformBackup);
    await every("stale", 5 * 60_000, failStaleDeployments);
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  return () => clearInterval(timer);
}

void desc;
