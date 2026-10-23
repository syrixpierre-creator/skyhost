import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { deployHooks, environments, getDb } from "@skyhost/db";
import { randomToken, sha256 } from "@skyhost/shared/node";
import { audit, badRequest, createDeployment, notFound, serverConfig } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { serviceAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";

const view = (h: typeof deployHooks.$inferSelect) => ({ id: h.id, name: h.name, environmentId: h.environmentId, prefix: h.tokenPrefix, lastUsedAt: h.lastUsedAt, createdAt: h.createdAt });

/** Deploy hooks: a secret URL that deploys a service when called with POST (CI pipelines, CMS publish buttons…). */
export default async function hookRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/services/:id/deploy-hooks", tags: ["deploy-hooks"], params: idParam }, async (req, _r, { params }) => {
    await serviceAccess(req, params.id, "service:read");
    const rows = await getDb().select().from(deployHooks).where(and(eq(deployHooks.serviceId, params.id), isNull(deployHooks.revokedAt))).orderBy(desc(deployHooks.createdAt));
    return { hooks: rows.map(view) };
  });

  route(
    app,
    { method: "POST", url: "/services/:id/deploy-hooks", tags: ["deploy-hooks"], params: idParam, body: z.object({ name: z.string().trim().min(1).max(60), environmentId: z.string().uuid() }) },
    async (req, reply, { params, body }) => {
      const a = await serviceAccess(req, params.id, "deploy:create");
      const [env] = await getDb().select().from(environments).where(and(eq(environments.id, body.environmentId), eq(environments.projectId, a.project.id), isNull(environments.deletedAt)));
      if (!env) throw badRequest("Unknown environment");
      const token = randomToken(32);
      const [h] = await getDb()
        .insert(deployHooks)
        .values({ serviceId: params.id, environmentId: env.id, name: body.name, tokenHash: sha256(token), tokenPrefix: token.slice(0, 6), createdBy: req.auth.user!.id })
        .returning();
      await audit(actorOf(req), a.team.id, "deploy_hook.create", { type: "service", id: params.id }, { name: body.name, environment: env.name });
      reply.code(201);
      // The URL contains the secret: shown once, only its hash is stored.
      return { hook: view(h!), url: `${serverConfig().SKYHOST_API_URL}/api/v1/hooks/deploy/${token}` };
    },
  );

  route(app, { method: "DELETE", url: "/deploy-hooks/:id", tags: ["deploy-hooks"], params: idParam }, async (req, _r, { params }) => {
    const db = getDb();
    const [h] = await db.select().from(deployHooks).where(and(eq(deployHooks.id, params.id), isNull(deployHooks.revokedAt)));
    if (!h) throw notFound("Deploy hook");
    const a = await serviceAccess(req, h.serviceId, "deploy:create");
    await db.update(deployHooks).set({ revokedAt: new Date() }).where(eq(deployHooks.id, h.id));
    await audit(actorOf(req), a.team.id, "deploy_hook.revoke", { type: "service", id: h.serviceId }, { name: h.name });
    return { ok: true };
  });

  route(
    app,
    { method: "POST", url: "/hooks/deploy/:token", public: true, tags: ["deploy-hooks"], params: z.object({ token: z.string().min(20).max(100) }), rateLimit: { max: 20, timeWindow: "1 minute" } },
    async (req, reply, { params }) => {
      const db = getDb();
      const [h] = await db.select().from(deployHooks).where(and(eq(deployHooks.tokenHash, sha256(params.token)), isNull(deployHooks.revokedAt)));
      if (!h) throw notFound("Deploy hook");
      const dep = await createDeployment({ serviceId: h.serviceId, environmentId: h.environmentId, trigger: "hook", actor: { userId: h.createdBy, ip: req.ip } });
      await db.update(deployHooks).set({ lastUsedAt: new Date() }).where(eq(deployHooks.id, h.id));
      reply.code(201);
      return { deployment: { id: dep.id, status: dep.status } };
    },
  );
}
