import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { deployments, getDb, metricSamples, serviceInstances, statusIncidents, teams, uptimeChecks, uptimeResults } from "@skyhost/db";
import { Redactor, assertPublicUrl } from "@skyhost/shared/node";
import { listManagedContainers, LABEL, streamLogs, type LogLine } from "@skyhost/engine";
import { assertFeature, audit, badRequest, notFound, resolveServiceEnv } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { projectAccess, serviceAccess } from "../lib/authz";
import { idParam, queryBool, route } from "../lib/http";

const LEVEL_RE: Record<string, RegExp> = {
  error: /\b(error|err|fatal|exception|panic|traceback)\b/i,
  warn: /\b(warn|warning)\b/i,
  info: /\b(info|notice)\b/i,
  debug: /\b(debug|trace)\b/i,
};

function levelOf(l: LogLine) {
  for (const [lvl, re] of Object.entries(LEVEL_RE)) if (re.test(l.line)) return lvl;
  return l.stream === "stderr" ? "error" : "info";
}

export default async function observabilityRoutes(app: FastifyInstance) {
  route(
    app,
    {
      method: "GET",
      url: "/services/:id/logs",
      tags: ["logs"],
      params: idParam,
      query: z.object({
        environmentId: z.string().uuid(),
        tail: z.coerce.number().int().min(1).max(5000).default(500),
        sinceMinutes: z.coerce.number().int().min(1).max(60 * 24 * 90).optional(),
        search: z.string().max(200).optional(),
        level: z.enum(["error", "warn", "info", "debug"]).optional(),
        download: queryBool(),
      }),
    },
    async (req, reply, { params, query }) => {
      const a = await serviceAccess(req, params.id, "logs:read");
      const db = getDb();
      const [team] = await db.select().from(teams).where(eq(teams.id, a.team.id));
      const { getTeamPlan } = await import("@skyhost/core");
      const plan = await getTeamPlan(a.team.id);
      // Retention: never return logs older than the plan (or team) retention.
      const retentionDays = Math.min(team?.retention.logsDays ?? plan.limits.logRetentionDays, plan.limits.logRetentionDays);
      const maxSince = retentionDays * 24 * 60;
      const sinceMin = Math.min(query.sinceMinutes ?? maxSince, maxSince);
      const [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, params.id), eq(serviceInstances.environmentId, query.environmentId)));
      if (!inst?.liveDeploymentId) return { lines: [] };
      const [dep] = await db.select().from(deployments).where(eq(deployments.id, inst.liveDeploymentId));
      const containers = dep?.containers.length ? dep.containers : (await listManagedContainers({ [LABEL.deployment]: inst.liveDeploymentId })).map((c) => c.Id);
      const env = await resolveServiceEnv(params.id, query.environmentId).catch(() => ({ secrets: [] as string[] }));
      const redactor = new Redactor().add(...env.secrets);
      const lines: Array<LogLine & { level: string; replica: number }> = [];
      for (const [i, c] of containers.entries()) {
        await streamLogs(c, { follow: false, tail: query.tail, since: Math.floor(Date.now() / 1000) - sinceMin * 60 }, (l) => lines.push({ ...l, line: redactor.apply(l.line), level: levelOf(l), replica: i })).catch(() => {});
      }
      const s = query.search?.toLowerCase();
      const filtered = lines.filter((l) => (!s || l.line.toLowerCase().includes(s)) && (!query.level || l.level === query.level)).sort((x, y) => x.ts.localeCompare(y.ts)).slice(-query.tail);
      if (query.download) {
        reply.header("Content-Type", "text/plain; charset=utf-8").header("Content-Disposition", `attachment; filename="${a.service.slug}-logs.txt"`);
        return filtered.map((l) => `${l.ts} [${l.stream}] ${l.line}`).join("\n") + "\n";
      }
      return { lines: filtered, retentionDays };
    },
  );

  route(app, { method: "GET", url: "/services/:id/metrics", tags: ["metrics"], params: idParam, query: z.object({ environmentId: z.string().uuid(), hours: z.coerce.number().int().min(1).max(720).default(24) }) }, async (req, _r, { params, query }) => {
    await serviceAccess(req, params.id, "metrics:read");
    const since = new Date(Date.now() - query.hours * 3600_000);
    const rows = await getDb()
      .select()
      .from(metricSamples)
      .where(and(eq(metricSamples.serviceId, params.id), eq(metricSamples.environmentId, query.environmentId), gte(metricSamples.createdAt, since)))
      .orderBy(metricSamples.createdAt)
      .limit(10_000);
    const up = rows.length ? rows.filter((r) => r.up).length / rows.length : null;
    const last = rows.at(-1);
    return {
      samples: rows.map((r) => ({ t: r.createdAt, cpu: r.cpuPercent, memory: r.memoryBytes, memoryLimit: r.memoryLimitBytes, rx: r.netRxBytes, tx: r.netTxBytes, requests: r.requests, responseMs: r.avgResponseMs, restarts: r.restarts, up: r.up })),
      summary: { uptimePercent: up === null ? null : Math.round(up * 10000) / 100, restarts: last?.restarts ?? 0, cpuPercent: last?.cpuPercent ?? 0, memoryBytes: last?.memoryBytes ?? 0 },
    };
  });

  // ---------------------------------------------------------------------------------- Uptime monitoring
  route(app, { method: "GET", url: "/projects/:id/uptime", tags: ["uptime"], params: idParam }, async (req, _r, { params }) => {
    await projectAccess(req, params.id, "metrics:read");
    const db = getDb();
    const checks = await db.select().from(uptimeChecks).where(eq(uptimeChecks.projectId, params.id));
    const since = new Date(Date.now() - 24 * 3600_000);
    const results = checks.length ? await db.select().from(uptimeResults).where(and(inArray(uptimeResults.checkId, checks.map((c) => c.id)), gte(uptimeResults.createdAt, since))).orderBy(desc(uptimeResults.createdAt)) : [];
    return {
      checks: checks.map((c) => {
        const rs = results.filter((r) => r.checkId === c.id);
        return { ...c, uptime24h: rs.length ? Math.round((rs.filter((r) => r.up).length / rs.length) * 10000) / 100 : null, recent: rs.slice(0, 60) };
      }),
    };
  });

  route(
    app,
    { method: "POST", url: "/projects/:id/uptime", tags: ["uptime"], params: idParam, body: z.object({ name: z.string().min(1).max(80), url: z.string().url().max(2048), intervalSeconds: z.number().int().min(30).max(3600).default(60), expectedStatus: z.number().int().min(100).max(599).default(200), serviceId: z.string().uuid().optional() }) },
    async (req, reply, { params, body }) => {
      const a = await projectAccess(req, params.id, "project:update");
      await assertFeature(a.team.id, "uptimeMonitoring");
      await assertPublicUrl(body.url).catch((e) => Promise.reject(badRequest((e as Error).message)));
      const [c] = await getDb().insert(uptimeChecks).values({ projectId: params.id, ...body }).returning();
      await audit(actorOf(req), a.team.id, "uptime.create", { type: "uptime_check", id: c!.id }, { url: body.url });
      reply.code(201);
      return { check: c };
    },
  );

  route(app, { method: "DELETE", url: "/uptime/:id", tags: ["uptime"], params: idParam }, async (req, _r, { params }) => {
    const [c] = await getDb().select().from(uptimeChecks).where(eq(uptimeChecks.id, params.id));
    if (!c) throw notFound("Check");
    await projectAccess(req, c.projectId, "project:update");
    await getDb().delete(uptimeChecks).where(eq(uptimeChecks.id, params.id));
    return { ok: true };
  });

  route(
    app,
    { method: "POST", url: "/projects/:id/incidents", tags: ["uptime"], params: idParam, body: z.object({ title: z.string().min(1).max(200), status: z.enum(["investigating", "identified", "monitoring", "resolved"]).default("investigating"), impact: z.enum(["minor", "major", "critical"]).default("minor"), body: z.string().max(5000).default("") }) },
    async (req, reply, { params, body }) => {
      await projectAccess(req, params.id, "project:update");
      const [i] = await getDb().insert(statusIncidents).values({ projectId: params.id, ...body, resolvedAt: body.status === "resolved" ? new Date() : null }).returning();
      reply.code(201);
      return { incident: i };
    },
  );
}
