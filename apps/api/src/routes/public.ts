import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { abuseReports, announcements, getDb, nodes, projects, services, statusIncidents, uptimeChecks, uptimeResults } from "@skyhost/db";
import { redis, serverConfig } from "@skyhost/core";
import { route } from "../lib/http";

type Project = typeof projects.$inferSelect;

export async function statusPageData(p: Project) {
  const db = getDb();
  const checks = await db.select().from(uptimeChecks).where(and(eq(uptimeChecks.projectId, p.id), eq(uptimeChecks.enabled, true)));
  const since = new Date(Date.now() - 90 * 86400_000);
  const results = checks.length ? await db.select().from(uptimeResults).where(and(inArray(uptimeResults.checkId, checks.map((c) => c.id)), gte(uptimeResults.createdAt, since))) : [];
  const incidents = await db.select().from(statusIncidents).where(eq(statusIncidents.projectId, p.id)).orderBy(desc(statusIncidents.createdAt)).limit(20);
  return {
    name: p.name,
    checks: checks.map((c) => {
      const rs = results.filter((r) => r.checkId === c.id);
      const days: Array<{ day: string; uptime: number | null }> = [];
      for (let i = 89; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
        const of = rs.filter((r) => r.createdAt.toISOString().startsWith(day));
        days.push({ day, uptime: of.length ? of.filter((r) => r.up).length / of.length : null });
      }
      const up = rs.length ? rs.filter((r) => r.up).length / rs.length : null;
      return { name: c.name, status: c.lastStatus ?? "unknown", uptime90d: up === null ? null : Math.round(up * 10000) / 100, days };
    }),
    incidents: incidents.map((i) => ({ title: i.title, status: i.status, impact: i.impact, body: i.body, createdAt: i.createdAt, resolvedAt: i.resolvedAt })),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderStatusPage(d: Awaited<ReturnType<typeof statusPageData>>) {
  const allUp = d.checks.every((c) => c.status === "up");
  const color = (u: number | null) => (u === null ? "#2c313a" : u >= 0.999 ? "#16a34a" : u >= 0.95 ? "#ca8a04" : "#dc2626");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.name)} status</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#e6e8eb;margin:0;padding:24px}main{max-width:760px;margin:auto}.card{border:1px solid #23272e;border-radius:8px;background:#121418;padding:16px;margin:12px 0}.bars{display:flex;gap:2px;margin-top:8px}.bars span{flex:1;height:28px;border-radius:2px}.row{display:flex;justify-content:space-between}.muted{color:#9aa1ab;font-size:13px}</style></head>
<body><main><h1>${esc(d.name)}</h1><div class="card"><strong>${allUp ? "All systems operational" : "Some systems are degraded"}</strong></div>
${d.checks.map((c) => `<div class="card"><div class="row"><strong>${esc(c.name)}</strong><span class="muted">${c.uptime90d ?? "–"}% uptime (90 days)</span></div><div class="bars">${c.days.map((x) => `<span title="${x.day}" style="background:${color(x.uptime)}"></span>`).join("")}</div></div>`).join("")}
${d.incidents.length ? `<h2>Incidents</h2>${d.incidents.map((i) => `<div class="card"><strong>${esc(i.title)}</strong> <span class="muted">${esc(i.status)} · ${i.createdAt.toISOString().slice(0, 10)}</span><p>${esc(i.body)}</p></div>`).join("")}` : ""}
<p class="muted">Powered by SKYHOST</p></main></body></html>`;
}

export default async function publicRoutes(app: FastifyInstance) {
  /** Platform status (public status page of SKYHOST itself). */
  route(app, { method: "GET", url: "/public/status", public: true, tags: ["public"] }, async () => {
    const db = getDb();
    const components: Array<{ name: string; status: string }> = [];
    const t0 = Date.now();
    try {
      await redis().ping();
      components.push({ name: "Queue", status: "operational" });
    } catch {
      components.push({ name: "Queue", status: "outage" });
    }
    components.push({ name: "API", status: Date.now() - t0 < 2000 ? "operational" : "degraded" });
    const workers = await db.select().from(nodes);
    const fresh = workers.filter((n) => n.lastHeartbeatAt && Date.now() - n.lastHeartbeatAt.getTime() < 120_000);
    for (const role of ["build", "deploy", "scheduler", "screenshot"]) {
      const ok = fresh.some((n) => n.roles.includes(role) || n.roles.includes("all"));
      components.push({ name: `${role[0]!.toUpperCase()}${role.slice(1)} workers`, status: ok ? "operational" : workers.length ? "degraded" : "unknown" });
    }
    const now = new Date();
    const notices = await db.select().from(announcements).where(and(lte(announcements.startsAt, now), or(isNull(announcements.endsAt), gte(announcements.endsAt, now)))).orderBy(desc(announcements.startsAt));
    const incidents = await db.select().from(statusIncidents).where(isNull(statusIncidents.projectId)).orderBy(desc(statusIncidents.createdAt)).limit(20);
    return { components, announcements: notices, incidents, updatedAt: now };
  });

  route(app, { method: "GET", url: "/public/announcements", public: true, tags: ["public"] }, async () => {
    const now = new Date();
    return { announcements: await getDb().select().from(announcements).where(and(lte(announcements.startsAt, now), or(isNull(announcements.endsAt), gte(announcements.endsAt, now)))) };
  });

  route(app, { method: "GET", url: "/public/status-pages/:slug", public: true, tags: ["public"], params: z.object({ slug: z.string().regex(/^[a-z0-9-]{3,48}$/) }) }, async (_req, reply, { params }) => {
    const [p] = await getDb().select().from(projects).where(and(eq(projects.statusPageSlug, params.slug), eq(projects.statusPageEnabled, true), isNull(projects.deletedAt)));
    if (!p) return reply.code(404).send({ error: { code: "not_found", message: "Status page not found" } });
    return statusPageData(p);
  });

  route(
    app,
    {
      method: "POST",
      url: "/public/abuse-reports",
      public: true,
      tags: ["public"],
      body: z.object({ targetUrl: z.string().url().max(2048), category: z.enum(["phishing", "spam", "malware", "mining", "ddos", "copyright", "other"]), description: z.string().min(10).max(5000), email: z.string().email().optional() }),
      rateLimit: { max: 5, timeWindow: "10 minutes" },
    },
    async (req, reply, { body }) => {
      const db = getDb();
      // Map the reported host to a service so admins can act quickly.
      const host = new URL(body.targetUrl).hostname;
      let serviceId: string | null = null;
      let teamId: string | null = null;
      const base = serverConfig().SKYHOST_BASE_DOMAIN;
      const m = host.endsWith(`.${base}`) ? /-([a-z0-9]{6})(?:-[a-z0-9-]+)?$/.exec(host.slice(0, -base.length - 1)) : null;
      if (m) {
        const [s] = await db.select({ s: services, p: projects }).from(services).innerJoin(projects, eq(projects.id, services.projectId)).where(eq(services.subdomain, m[1]!));
        if (s) {
          serviceId = s.s.id;
          teamId = s.p.teamId;
        }
      }
      await db.insert(abuseReports).values({ reporterEmail: body.email ?? null, reporterUserId: req.auth.user?.id ?? null, targetUrl: body.targetUrl, category: body.category, description: body.description, serviceId, teamId });
      reply.code(201);
      return { ok: true, message: "Thank you. Our team reviews every report." };
    },
  );
}
