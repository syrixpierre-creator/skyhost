import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { domains, environments, getDb, projects } from "@skyhost/db";
import { domainSchema } from "@skyhost/shared";
import { randomToken } from "@skyhost/shared/node";
import { assertQuota, audit, badRequest, conflict, enqueue, notify, serverConfig, serviceHostname, slugifySafe } from "../lib/domain-helpers";
import { actorOf } from "../lib/auth";
import { domainAccess, projectAccess, serviceAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";
import { dnsInstructions, verifyDomain } from "../lib/dns";

function domainView(d: typeof domains.$inferSelect, target: string) {
  return { ...d, dns: dnsInstructions(d.hostname, target, d.verificationToken) };
}

async function targetFor(serviceId: string | null, environmentId: string | null, fallback: string) {
  if (!serviceId) return fallback;
  const db = getDb();
  const { services } = await import("@skyhost/db");
  const [s] = await db.select().from(services).where(eq(services.id, serviceId));
  const [env] = environmentId ? await db.select().from(environments).where(eq(environments.id, environmentId)) : await db.select().from(environments).where(and(eq(environments.projectId, s!.projectId), eq(environments.type, "production")));
  return serviceHostname(s!, env!);
}

export default async function domainRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/services/:id/domains", tags: ["domains"], params: idParam }, async (req, _r, { params }) => {
    await serviceAccess(req, params.id, "service:read");
    const rows = await getDb().select().from(domains).where(eq(domains.serviceId, params.id));
    const out = [];
    for (const d of rows) out.push(domainView(d, await targetFor(d.serviceId, d.environmentId, "")));
    return { domains: out };
  });

  route(app, { method: "POST", url: "/services/:id/domains", tags: ["domains"], params: idParam, body: domainSchema.extend({ environmentId: z.string().uuid().optional() }) }, async (req, reply, { params, body }) => {
    const a = await serviceAccess(req, params.id, "domain:manage");
    if (!["web", "static", "docker"].includes(a.service.type)) throw badRequest("Only web services, static sites and Docker services can have domains");
    const base = serverConfig().SKYHOST_BASE_DOMAIN;
    const bare = body.hostname.replace(/^\*\./, "");
    if (bare === base || bare.endsWith(`.${base}`)) throw badRequest(`${base} domains are managed by SKYHOST`);
    if (body.hostname.startsWith("*.") && !serverConfig().SKYHOST_WILDCARD_CERT_RESOLVER) throw badRequest("Wildcard domains need a DNS challenge certificate resolver on this SKYHOST installation");
    await assertQuota(a.team.id, "customDomains");
    const db = getDb();
    const [exists] = await db.select().from(domains).where(eq(domains.hostname, body.hostname));
    if (exists) throw conflict("This domain is already used on SKYHOST. If you own it, remove it from the other project first.");
    if (body.environmentId) {
      const [env] = await db.select().from(environments).where(and(eq(environments.id, body.environmentId), eq(environments.projectId, a.service.projectId)));
      if (!env) throw badRequest("Unknown environment");
    }
    const existing = await db.select().from(domains).where(eq(domains.serviceId, params.id));
    const [d] = await db
      .insert(domains)
      .values({ serviceId: params.id, environmentId: body.environmentId ?? null, hostname: body.hostname, isWildcard: body.hostname.startsWith("*."), redirectTo: body.redirectTo ?? null, verificationToken: `skyhost-verify=${randomToken(18)}`, isPrimary: existing.length === 0 })
      .returning();
    await audit(actorOf(req), a.team.id, "domain.add", { type: "domain", id: d!.id }, { hostname: body.hostname });
    reply.code(201);
    return { domain: domainView(d!, await targetFor(d!.serviceId, d!.environmentId, "")) };
  });

  route(app, { method: "POST", url: "/domains/:id/verify", tags: ["domains"], params: idParam, rateLimit: { max: 20, timeWindow: "1 minute" } }, async (req, _r, { params }) => {
    const a = await domainAccess(req, params.id, "domain:manage");
    const d = a.domain;
    const target = await targetFor(d.serviceId, d.environmentId, `status.${serverConfig().SKYHOST_BASE_DOMAIN}`);
    const result = await verifyDomain(d.hostname, target, d.verificationToken);
    const db = getDb();
    // Ownership (TXT) is mandatory: routing alone never activates a domain (prevents domain takeover).
    const ok = result.ownership && result.routing;
    const status = ok ? (d.status === "ssl_issued" ? "ssl_issued" : "verified") : d.status === "pending" ? "pending" : "error";
    const [updated] = await db
      .update(domains)
      .set({ status: ok ? status : result.ownership ? "pending" : status, verifiedAt: ok ? (d.verifiedAt ?? new Date()) : d.verifiedAt, lastCheckedAt: new Date(), error: ok ? null : result.details.join("; ") })
      .where(eq(domains.id, d.id))
      .returning();
    if (ok && d.status !== "verified" && d.status !== "ssl_issued") {
      await enqueue("maintenance", { task: "reconcile-proxy" });
      await enqueue("maintenance", { task: `check-certificate:${d.id}` }, { delay: 15_000 });
      await audit(actorOf(req), a.team.id, "domain.verified", { type: "domain", id: d.id }, { hostname: d.hostname });
      await notify({ teamId: a.team.id, event: "domain.verified", title: `${d.hostname} is verified`, body: "SKYHOST is issuing an HTTPS certificate. It usually takes less than a minute." });
    }
    return { domain: domainView(updated!, target), check: result };
  });

  route(app, { method: "PATCH", url: "/domains/:id", tags: ["domains"], params: idParam, body: z.object({ isPrimary: z.boolean().optional(), redirectTo: z.string().max(253).nullable().optional() }) }, async (req, _r, { params, body }) => {
    const a = await domainAccess(req, params.id, "domain:manage");
    const db = getDb();
    if (body.redirectTo) {
      const [target] = await db.select().from(domains).where(and(eq(domains.hostname, body.redirectTo), eq(domains.serviceId, a.domain.serviceId!)));
      if (!target && !body.redirectTo.endsWith(serverConfig().SKYHOST_BASE_DOMAIN)) throw badRequest("Redirects can only target another domain of this service");
    }
    if (body.isPrimary && a.domain.serviceId) await db.update(domains).set({ isPrimary: false }).where(eq(domains.serviceId, a.domain.serviceId));
    const [d] = await db.update(domains).set(body).where(eq(domains.id, params.id)).returning();
    await enqueue("maintenance", { task: "reconcile-proxy" });
    await audit(actorOf(req), a.team.id, "domain.update", { type: "domain", id: params.id }, body);
    return { domain: d };
  });

  route(app, { method: "DELETE", url: "/domains/:id", tags: ["domains"], params: idParam }, async (req, _r, { params }) => {
    const a = await domainAccess(req, params.id, "domain:manage");
    await getDb().delete(domains).where(eq(domains.id, params.id));
    await enqueue("maintenance", { task: "reconcile-proxy" });
    await audit(actorOf(req), a.team.id, "domain.remove", { type: "domain", id: params.id }, { hostname: a.domain.hostname });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Project status page
  route(
    app,
    { method: "PUT", url: "/projects/:id/status-page", tags: ["uptime"], params: idParam, body: z.object({ enabled: z.boolean(), slug: z.string().regex(/^[a-z0-9-]{3,48}$/).optional(), domain: domainSchema.shape.hostname.optional() }) },
    async (req, _r, { params, body }) => {
      const a = await projectAccess(req, params.id, "project:update");
      const db = getDb();
      const slug = body.slug ?? a.project.statusPageSlug ?? slugifySafe(`${a.project.slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`);
      const [taken] = await db.select().from(projects).where(and(eq(projects.statusPageSlug, slug), isNull(projects.deletedAt)));
      if (taken && taken.id !== params.id) throw conflict("This status page address is taken");
      await db.update(projects).set({ statusPageEnabled: body.enabled, statusPageSlug: slug, statusPageDomain: body.domain ?? null }).where(eq(projects.id, params.id));
      let domain = null;
      if (body.domain) {
        const [existing] = await db.select().from(domains).where(eq(domains.hostname, body.domain));
        if (existing && existing.projectId !== params.id) throw conflict("This domain is already used on SKYHOST");
        if (!existing) {
          await assertQuota(a.team.id, "customDomains");
          [domain] = await db.insert(domains).values({ projectId: params.id, target: "status_page", hostname: body.domain, verificationToken: `skyhost-verify=${randomToken(18)}` }).returning();
        } else domain = existing;
      }
      await audit(actorOf(req), a.team.id, "status_page.update", { type: "project", id: params.id }, body);
      return { statusPage: { enabled: body.enabled, slug, url: `${serverConfig().SKYHOST_DASHBOARD_URL}/status/${slug}` }, domain: domain ? domainView(domain, `status.${serverConfig().SKYHOST_BASE_DOMAIN}`) : null };
    },
  );
}
