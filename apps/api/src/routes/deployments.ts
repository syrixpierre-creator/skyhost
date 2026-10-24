import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { deploymentComments, deploymentLogs, deployments, environments, getDb, gitInstallations, serviceInstances, services, users } from "@skyhost/db";
import { serviceConfigSchema } from "@skyhost/shared";
import { applyFileFix, type ErrorDiagnosis } from "@skyhost/analyzer";
import { audit, badRequest, cancelDeployment, createDeployment, getTeamPlan, notFound, providerClient, publicUrl, rollbackTo, serviceHostname, upsertVariables } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { deploymentAccess, environmentAccess, serviceAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";

export default async function deploymentRoutes(app: FastifyInstance) {
  route(
    app,
    { method: "GET", url: "/services/:id/deployments", tags: ["deployments"], params: idParam, query: z.object({ environmentId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.coerce.date().optional() }) },
    async (req, _r, { params, query }) => {
      await serviceAccess(req, params.id, "service:read");
      const rows = await getDb()
        .select({ d: deployments, creator: users.name })
        .from(deployments)
        .leftJoin(users, eq(users.id, deployments.createdBy))
        .where(and(eq(deployments.serviceId, params.id), query.environmentId ? eq(deployments.environmentId, query.environmentId) : undefined, query.before ? lt(deployments.createdAt, query.before) : undefined))
        .orderBy(desc(deployments.createdAt))
        .limit(query.limit);
      return {
        deployments: rows.map(({ d, creator }) => ({
          ...d,
          createdByName: creator,
          durationSeconds: d.startedAt && d.finishedAt ? Math.round((d.finishedAt.getTime() - d.startedAt.getTime()) / 1000) : null,
        })),
      };
    },
  );

  route(
    app,
    { method: "POST", url: "/services/:id/deploy", tags: ["deployments"], params: idParam, body: z.object({ environmentId: z.string().uuid().optional(), commitSha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(), branch: z.string().max(255).optional() }) },
    async (req, reply, { params, body }) => {
      const a = await serviceAccess(req, params.id, "deploy:create");
      const db = getDb();
      let envId = body.environmentId;
      if (envId) {
        const e = await environmentAccess(req, envId, "deploy:create");
        if (e.environment.projectId !== a.service.projectId) throw badRequest("Environment of another project");
      } else {
        const [prod] = await db.select().from(environments).where(and(eq(environments.projectId, a.service.projectId), eq(environments.type, "production")));
        envId = prod!.id;
      }
      const dep = await createDeployment({
        serviceId: params.id,
        environmentId: envId,
        trigger: req.auth.apiKey ? "api" : "manual",
        actor: actorOf(req),
        commit: body.commitSha || body.branch ? { sha: body.commitSha ?? null, branch: body.branch ?? null } : null,
      });
      reply.code(201);
      return { deployment: dep };
    },
  );

  /** Redeploy the live image with the current variables and settings (no rebuild). */
  route(app, { method: "POST", url: "/services/:id/redeploy", tags: ["deployments"], params: idParam, body: z.object({ environmentId: z.string().uuid() }) }, async (req, reply, { params, body }) => {
    await serviceAccess(req, params.id, "deploy:create");
    const db = getDb();
    const [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, params.id), eq(serviceInstances.environmentId, body.environmentId)));
    const [live] = inst?.liveDeploymentId ? await db.select().from(deployments).where(eq(deployments.id, inst.liveDeploymentId)) : [];
    const dep = await createDeployment({
      serviceId: params.id,
      environmentId: body.environmentId,
      trigger: "redeploy",
      actor: actorOf(req),
      image: live?.image ?? null,
      commit: live ? { sha: live.commitSha, message: live.commitMessage, author: live.commitAuthor, branch: live.branch } : null,
    });
    reply.code(201);
    return { deployment: dep };
  });

  route(app, { method: "GET", url: "/deployments/:id", tags: ["deployments"], params: idParam }, async (req, _r, { params }) => {
    const a = await deploymentAccess(req, params.id, "service:read");
    // Public address of the release, shown at the top of the page once it is live (like Render or Railway).
    let url: string | null = null;
    if (["web", "static", "docker"].includes(a.service.type)) {
      const [env] = await getDb().select().from(environments).where(eq(environments.id, a.deployment.environmentId));
      if (env) url = publicUrl(serviceHostname(a.service, env));
    }
    const src = a.service.source as { kind?: string; repo?: string };
    const repo = ["github", "gitlab", "bitbucket"].includes(src.kind ?? "") ? (src.repo ?? null) : null;
    return { deployment: a.deployment, url, service: { id: a.service.id, name: a.service.name, projectId: a.service.projectId, type: a.service.type, repo } };
  });

  route(
    app,
    { method: "GET", url: "/deployments/:id/logs", tags: ["logs"], params: idParam, query: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(2000), stream: z.enum(["build", "deploy"]).optional() }) },
    async (req, _r, { params, query }) => {
      await deploymentAccess(req, params.id, "logs:read");
      const rows = await getDb()
        .select()
        .from(deploymentLogs)
        .where(and(eq(deploymentLogs.deploymentId, params.id), gt(deploymentLogs.id, query.after), query.stream ? eq(deploymentLogs.stream, query.stream) : undefined))
        .orderBy(asc(deploymentLogs.id))
        .limit(query.limit);
      return { lines: rows, nextCursor: rows.at(-1)?.id ?? query.after };
    },
  );

  route(app, { method: "GET", url: "/deployments/:id/logs/download", tags: ["logs"], params: idParam }, async (req, reply, { params }) => {
    await deploymentAccess(req, params.id, "logs:read");
    const rows = await getDb().select().from(deploymentLogs).where(eq(deploymentLogs.deploymentId, params.id)).orderBy(asc(deploymentLogs.id));
    reply.header("Content-Type", "text/plain; charset=utf-8").header("Content-Disposition", `attachment; filename="deployment-${params.id}.log"`);
    return rows.map((r) => `${r.createdAt.toISOString()} [${r.stream}] ${r.line}`).join("\n") + "\n";
  });

  route(app, { method: "POST", url: "/deployments/:id/cancel", tags: ["deployments"], params: idParam }, async (req, _r, { params }) => {
    const a = await deploymentAccess(req, params.id, "deploy:cancel");
    await cancelDeployment(params.id, actorOf(req), a.team.id);
    return { ok: true };
  });

  route(app, { method: "POST", url: "/deployments/:id/rollback", tags: ["deployments"], params: idParam }, async (req, reply, { params }) => {
    await deploymentAccess(req, params.id, "deploy:rollback");
    const dep = await rollbackTo(params.id, actorOf(req));
    reply.code(201);
    return { deployment: dep };
  });

  // ---------------------------------------------------------------------------------- Smart Error Analyzer & Auto Fix
  route(app, { method: "GET", url: "/deployments/:id/diagnosis", tags: ["deployments"], params: idParam }, async (req, _r, { params }) => {
    const a = await deploymentAccess(req, params.id, "logs:read");
    return { diagnoses: (a.deployment.errorAnalysis ?? []) as ErrorDiagnosis[], error: a.deployment.error };
  });

  route(
    app,
    { method: "POST", url: "/deployments/:id/autofix", tags: ["deployments"], params: idParam, body: z.object({ index: z.number().int().min(0), mode: z.enum(["apply", "pull_request"]), value: z.string().max(32 * 1024).optional(), confirm: z.literal(true) }) },
    async (req, _r, { params, body }) => {
      const a = await deploymentAccess(req, params.id, "service:update");
      const diags = (a.deployment.errorAnalysis ?? []) as ErrorDiagnosis[];
      const d = diags[body.index];
      if (!d?.autoFix) throw badRequest("This diagnosis has no automatic fix");
      const fix = d.autoFix;
      const db = getDb();
      // Every fix requires explicit confirmation and is audited; nothing is ever changed silently.
      if (fix.kind === "config_change") {
        const cfg = structuredClone(a.service.config) as Record<string, unknown>;
        const path = fix.field!.split(".");
        let cur = cfg;
        for (const p of path.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
        cur[path.at(-1)!] = fix.value;
        const parsed = serviceConfigSchema.parse(cfg);
        if (fix.field === "resources.memoryMb") {
          const plan = await getTeamPlan(a.team.id);
          if ((fix.value as number) > plan.limits.memoryMb) throw badRequest(`Your plan allows up to ${plan.limits.memoryMb} MB of memory; upgrade to apply this fix`);
        }
        await db.update(services).set({ config: parsed, updatedAt: new Date() }).where(eq(services.id, a.service.id));
        await audit(actorOf(req), a.team.id, "autofix.applied", { type: "service", id: a.service.id }, { diagnosis: d.id, field: fix.field, value: fix.value });
        return { applied: true, change: { field: fix.field, value: fix.value }, redeployRequired: true };
      }
      if (fix.kind === "variable") {
        if (body.value === undefined) throw badRequest(`Provide the value of ${fix.field}`);
        await upsertVariables(a.service.projectId, a.deployment.environmentId, a.service.id, [{ key: fix.field!, value: body.value, secret: true }], false, req.auth.user!.id);
        await audit(actorOf(req), a.team.id, "autofix.applied", { type: "service", id: a.service.id }, { diagnosis: d.id, variable: fix.field });
        return { applied: true, change: { variable: fix.field }, redeployRequired: true };
      }
      // file_edit: open a pull request on the repository (never pushed to the default branch).
      const src = a.service.source as { kind: string; repo?: string; branch?: string; installationId?: string };
      if (body.mode !== "pull_request" || !src.repo || !src.installationId) {
        return { applied: false, patch: { file: fix.file, find: fix.find, replace: fix.replace, reason: fix.reason }, message: "Apply this change in your repository, then push." };
      }
      const [inst] = await db.select().from(gitInstallations).where(and(eq(gitInstallations.id, src.installationId), eq(gitInstallations.teamId, a.team.id)));
      if (!inst) throw badRequest("The Git connection of this service is missing");
      const client = providerClient(inst);
      const base = a.deployment.branch ?? src.branch ?? "main";
      const current = await client.readFile(src.repo, base, fix.file!);
      if (current == null) throw badRequest(`${fix.file} was not found on ${base}`);
      const next = applyFileFix(current, fix);
      if (next == null) throw badRequest("The file changed since the diagnosis; redeploy to get an up-to-date fix");
      const branch = `skyhost/autofix-${d.id}-${Date.now().toString(36)}`;
      const pr = await client.createFixPullRequest(src.repo, base, branch, [{ path: fix.file!, content: next }], `SKYHOST Auto Fix: ${d.problem}`, `**Problem:** ${d.problem}\n\n**Cause:** ${d.cause}\n\n**Change:** ${fix.description}\n\n**Why:** ${fix.reason}\n\nGenerated by SKYHOST Smart Error Analyzer and confirmed by ${req.auth.user!.name}.`);
      await audit(actorOf(req), a.team.id, "autofix.pull_request", { type: "service", id: a.service.id }, { diagnosis: d.id, url: pr.url });
      return { applied: false, pullRequest: pr };
    },
  );

  // ---------------------------------------------------------------------------------- Comments
  route(app, { method: "GET", url: "/deployments/:id/comments", tags: ["deployments"], params: idParam }, async (req, _r, { params }) => {
    await deploymentAccess(req, params.id, "service:read");
    const rows = await getDb().select({ c: deploymentComments, name: users.name }).from(deploymentComments).leftJoin(users, eq(users.id, deploymentComments.userId)).where(eq(deploymentComments.deploymentId, params.id)).orderBy(asc(deploymentComments.createdAt));
    return { comments: rows.map((r) => ({ ...r.c, author: r.name })) };
  });

  route(app, { method: "POST", url: "/deployments/:id/comments", tags: ["deployments"], params: idParam, body: z.object({ body: z.string().trim().min(1).max(5000) }) }, async (req, reply, { params, body }) => {
    await deploymentAccess(req, params.id, "service:read");
    const [c] = await getDb().insert(deploymentComments).values({ deploymentId: params.id, userId: req.auth.user!.id, body: body.body }).returning();
    reply.code(201);
    return { comment: c };
  });

  route(app, { method: "GET", url: "/services/:id/cost-estimate", tags: ["billing"], params: idParam }, async (req, _r, { params }) => {
    const a = await serviceAccess(req, params.id, "service:read");
    const plan = await getTeamPlan(a.team.id);
    const r = a.service.config.resources;
    const share = Math.max((r.cpu * r.replicas) / Math.max(plan.limits.cpu, 0.01), (r.memoryMb * r.replicas) / Math.max(plan.limits.memoryMb, 1));
    // Resources are included in the plan; the estimate shows the share of the plan this service uses.
    return { plan: plan.slug, includedInPlan: share <= 1, planShare: Math.round(share * 1000) / 10, estimatedMonthlyCents: Math.round(plan.priceCents * Math.min(share, 1)), resources: r };
  });

  void notFound;
}
