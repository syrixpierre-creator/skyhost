import type { FastifyInstance } from "fastify";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  buckets, databaseConnections, databases, deployments, domains, environments, getDb, projects, serviceInstances, services, teamMembers, uploads, variables,
} from "@skyhost/db";
import {
  createEnvironmentSchema, createProjectSchema, DATABASE_ENGINES, getTemplate, nameSchema, serviceConfigSchema, SERVICE_TYPES, sourceSchema, TEMPLATES, slugify,
} from "@skyhost/shared";
import { randomPassword } from "@skyhost/shared/node";
import { explainAnalysis, type AnalysisResult } from "@skyhost/analyzer";
import {
  assertFeature, assertQuota, audit, badRequest, conflict, copyVariables, createDeployment, enqueue, getQueueEvents, notFound, providerClient, serverConfig, serviceHostname, publicUrl, upsertVariables, forbidden, unavailable,
} from "@skyhost/core";
import { gitInstallations } from "@skyhost/db";
import { actorOf } from "../lib/auth";
import { projectAccess, teamAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";
import { connectDatabase, createDatabase, createService, validateSource } from "../lib/provisioning";

export function projectView(p: typeof projects.$inferSelect) {
  return { id: p.id, teamId: p.teamId, name: p.name, slug: p.slug, description: p.description, regionId: p.regionId, canvas: p.canvas, statusPageEnabled: p.statusPageEnabled, statusPageSlug: p.statusPageSlug, createdAt: p.createdAt };
}

export async function uniqueProjectSlug(teamId: string, name: string) {
  const base = slugify(name, 40);
  const taken = new Set((await getDb().select({ slug: projects.slug }).from(projects).where(and(eq(projects.teamId, teamId), isNull(projects.deletedAt)))).map((p) => p.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export async function createProjectRecord(teamId: string, name: string, description: string | undefined, region: string | undefined, actorUser: string | null) {
  await assertQuota(teamId, "projects");
  const db = getDb();
  const [p] = await db.insert(projects).values({ teamId, name, slug: await uniqueProjectSlug(teamId, name), description, regionId: region ?? serverConfig().SKYHOST_REGION }).returning();
  const [env] = await db.insert(environments).values({ projectId: p!.id, name: "production", type: "production" }).returning();
  void actorUser;
  return { project: p!, environment: env! };
}

/** Resolves the clone URL + token for an analysis, from a git installation or a public URL. */
async function analyzeSourceFor(teamId: string, source: z.infer<typeof sourceSchema>) {
  if (source.kind === "git") return { kind: "git" as const, url: source.url, branch: source.branch ?? null };
  if (source.kind === "zip") {
    const [u] = await getDb().select().from(uploads).where(and(eq(uploads.id, source.uploadId), eq(uploads.teamId, teamId)));
    if (!u) throw badRequest("Unknown upload");
    return { kind: "zip" as const, uploadId: u.id };
  }
  if (source.kind === "image") throw badRequest("Docker images do not need analysis");
  const [inst] = await getDb()
    .select()
    .from(gitInstallations)
    .where(and(eq(gitInstallations.teamId, teamId), eq(gitInstallations.provider, source.kind), source.installationId ? eq(gitInstallations.id, source.installationId) : undefined));
  if (!inst) throw badRequest(`Connect ${source.kind} to this team first`);
  const client = providerClient(inst);
  const repo = await client.getRepo(source.repo);
  const auth = await client.cloneAuth(source.repo);
  return { kind: "git" as const, url: auth.url, token: auth.token, tokenUsername: auth.username, branch: source.branch ?? repo.defaultBranch };
}

const launchSchema = z.object({
  teamId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  projectName: nameSchema.optional(),
  source: sourceSchema,
  services: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(48),
        type: z.enum(SERVICE_TYPES),
        config: serviceConfigSchema.partial().default({}),
        variables: z.array(z.object({ key: z.string(), value: z.string(), secret: z.boolean().default(false) })).max(300).default([]),
        analysis: z.record(z.unknown()).optional(),
        image: z.string().max(512).optional(),
      }),
    )
    .min(1)
    .max(20),
  databases: z.array(z.object({ name: z.string().trim().min(1).max(48), engine: z.enum(DATABASE_ENGINES), connectTo: z.array(z.string()).default([]), variableName: z.string().optional() })).max(10).default([]),
  deploy: z.boolean().default(true),
});

export default async function projectRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/teams/:teamId/projects", tags: ["projects"], params: z.object({ teamId: z.string().uuid() }) }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "project:read");
    const db = getDb();
    const key = req.auth.apiKey;
    const list = await db
      .select()
      .from(projects)
      .where(and(eq(projects.teamId, params.teamId), isNull(projects.deletedAt), key?.projectId ? eq(projects.id, key.projectId) : undefined))
      .orderBy(desc(projects.updatedAt));
    const ids = list.map((p) => p.id);
    const svc = ids.length ? await db.select({ projectId: services.projectId, id: services.id, name: services.name, type: services.type }).from(services).where(and(inArray(services.projectId, ids), isNull(services.deletedAt))) : [];
    const insts = svc.length ? await db.select().from(serviceInstances).where(inArray(serviceInstances.serviceId, svc.map((s) => s.id))) : [];
    const dbs = ids.length ? await db.select({ projectId: databases.projectId, id: databases.id, name: databases.name, engine: databases.engine, status: databases.status }).from(databases).where(and(inArray(databases.projectId, ids), isNull(databases.deletedAt))) : [];
    // Latest deployment per service (any environment), for the status shown on project cards.
    const latest = svc.length
      ? await db
          .selectDistinctOn([deployments.serviceId], { serviceId: deployments.serviceId, status: deployments.status })
          .from(deployments)
          .where(inArray(deployments.serviceId, svc.map((s) => s.id)))
          .orderBy(deployments.serviceId, desc(deployments.createdAt))
      : [];
    return {
      projects: list.map((p) => ({
        ...projectView(p),
        services: svc.filter((s) => s.projectId === p.id).map((s) => ({ ...s, status: insts.find((i) => i.serviceId === s.id)?.status ?? "idle", latestDeploymentStatus: latest.find((d) => d.serviceId === s.id)?.status ?? null })),
        databases: dbs.filter((d) => d.projectId === p.id),
      })),
    };
  });

  route(app, { method: "POST", url: "/projects", tags: ["projects"], body: createProjectSchema }, async (req, reply, { body }) => {
    await teamAccess(req, body.teamId, "project:create");
    const { project, environment } = await createProjectRecord(body.teamId, body.name, body.description, body.region, req.auth.user!.id);
    await audit(actorOf(req), body.teamId, "project.create", { type: "project", id: project.id }, { name: body.name });
    reply.code(201);
    return { project: projectView(project), environment };
  });

  route(app, { method: "GET", url: "/projects/:id", tags: ["projects"], params: idParam }, async (req, _r, { params }) => {
    const a = await projectAccess(req, params.id, "project:read");
    const db = getDb();
    const envs = await db.select().from(environments).where(and(eq(environments.projectId, params.id), isNull(environments.deletedAt))).orderBy(environments.createdAt);
    const svcs = await db.select().from(services).where(and(eq(services.projectId, params.id), isNull(services.deletedAt))).orderBy(services.createdAt);
    const insts = svcs.length ? await db.select().from(serviceInstances).where(inArray(serviceInstances.serviceId, svcs.map((s) => s.id))) : [];
    const liveIds = insts.map((i) => i.liveDeploymentId).filter(Boolean) as string[];
    const latest = svcs.length ? await db.select().from(deployments).where(inArray(deployments.serviceId, svcs.map((s) => s.id))).orderBy(desc(deployments.createdAt)).limit(200) : [];
    const live = liveIds.length ? await db.select().from(deployments).where(inArray(deployments.id, liveIds)) : [];
    const dbs = await db.select().from(databases).where(and(eq(databases.projectId, params.id), isNull(databases.deletedAt)));
    const conns = dbs.length ? await db.select().from(databaseConnections).where(inArray(databaseConnections.databaseId, dbs.map((d) => d.id))) : [];
    const bks = await db.select().from(buckets).where(and(eq(buckets.projectId, params.id), isNull(buckets.deletedAt)));
    return {
      project: projectView(a.project),
      role: a.role,
      permissions: [...a.permissions],
      environments: envs,
      services: svcs.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        type: s.type,
        source: { ...s.source, ...(s.source.registryAuth ? { registryAuth: "[hidden]" } : {}) },
        config: s.config,
        instances: envs.map((e) => {
          const inst = insts.find((i) => i.serviceId === s.id && i.environmentId === e.id);
          const liveDep = live.find((d) => d.id === inst?.liveDeploymentId);
          return {
            environmentId: e.id,
            status: inst?.status ?? "idle",
            sleeping: inst?.sleeping ?? false,
            liveDeploymentId: inst?.liveDeploymentId ?? null,
            canaryWeight: inst?.canaryWeight ?? 0,
            url: ["web", "static", "docker"].includes(s.type) && liveDep ? publicUrl(serviceHostname(s, e)) : null,
            latestDeployment: latest.find((d) => d.serviceId === s.id && d.environmentId === e.id) ?? null,
          };
        }),
      })),
      databases: dbs.map((d) => ({ id: d.id, name: d.name, engine: d.engine, version: d.version, status: d.status, environmentId: d.environmentId, connections: conns.filter((c) => c.databaseId === d.id).map((c) => ({ serviceId: c.serviceId, variableName: c.variableName })) })),
      buckets: bks.map((b) => ({ id: b.id, name: b.name, isPublic: b.isPublic })),
    };
  });

  route(app, { method: "PATCH", url: "/projects/:id", tags: ["projects"], params: idParam, body: z.object({ name: nameSchema.optional(), description: z.string().max(500).nullable().optional() }) }, async (req, _r, { params, body }) => {
    const a = await projectAccess(req, params.id, "project:update");
    const [p] = await getDb().update(projects).set({ ...body, updatedAt: new Date() }).where(eq(projects.id, params.id)).returning();
    await audit(actorOf(req), a.team.id, "project.update", { type: "project", id: params.id }, { fields: Object.keys(body) });
    return { project: projectView(p!) };
  });

  route(app, { method: "PUT", url: "/projects/:id/canvas", tags: ["projects"], params: idParam, body: z.object({ positions: z.record(z.object({ x: z.number().finite(), y: z.number().finite() })) }) }, async (req, _r, { params, body }) => {
    await projectAccess(req, params.id, "project:update");
    if (Object.keys(body.positions).length > 500) throw badRequest("Too many nodes");
    await getDb().update(projects).set({ canvas: body.positions }).where(eq(projects.id, params.id));
    return { ok: true };
  });

  route(app, { method: "DELETE", url: "/projects/:id", tags: ["projects"], params: idParam, body: z.object({ confirmName: z.string() }) }, async (req, _r, { params, body }) => {
    const a = await projectAccess(req, params.id, "project:delete");
    if (body.confirmName !== a.project.name) throw badRequest("Type the project name to confirm");
    const db = getDb();
    const dbs = await db.select().from(databases).where(and(eq(databases.projectId, params.id), isNull(databases.deletedAt)));
    if (dbs.some((d) => d.deletionProtection)) throw conflict("A database of this project has deletion protection enabled. Disable it first.");
    const svcs = await db.select().from(services).where(and(eq(services.projectId, params.id), isNull(services.deletedAt)));
    const now = new Date();
    for (const s of svcs) {
      await db.update(services).set({ deletedAt: now }).where(eq(services.id, s.id));
      await enqueue("maintenance", { task: `teardown-service:${s.id}` });
    }
    for (const d of dbs) {
      await db.update(databases).set({ deletedAt: now, status: "deleting" }).where(eq(databases.id, d.id));
      await enqueue("database", { action: "delete", databaseId: d.id, keepBackups: false });
    }
    // Buckets and their stored objects go with the project.
    for (const b of await db.select().from(buckets).where(and(eq(buckets.projectId, params.id), isNull(buckets.deletedAt)))) {
      await db.update(buckets).set({ deletedAt: now }).where(eq(buckets.id, b.id));
      await enqueue("bucket", { action: "delete", bucketId: b.id });
    }
    await db.update(environments).set({ deletedAt: now }).where(and(eq(environments.projectId, params.id), isNull(environments.deletedAt)));
    await db.update(projects).set({ deletedAt: now }).where(eq(projects.id, params.id));
    await audit(actorOf(req), a.team.id, "project.delete", { type: "project", id: params.id }, { name: a.project.name });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/projects/:id/transfer", tags: ["projects"], params: idParam, body: z.object({ targetTeamId: z.string().uuid() }) }, async (req, _r, { params, body }) => {
    const a = await projectAccess(req, params.id, "project:delete");
    if (!["owner", "admin"].includes(a.role)) throw forbidden("Only owners and admins can transfer projects");
    const target = await teamAccess(req, body.targetTeamId, "project:create");
    if (!["owner", "admin"].includes(target.role)) throw forbidden("You must be an owner or admin of the destination team");
    await assertQuota(body.targetTeamId, "projects");
    const db = getDb();
    const svcCount = (await db.select({ id: services.id }).from(services).where(and(eq(services.projectId, params.id), isNull(services.deletedAt)))).length;
    await assertQuota(body.targetTeamId, "services", svcCount);
    await db.update(projects).set({ teamId: body.targetTeamId, slug: await uniqueProjectSlug(body.targetTeamId, a.project.name), updatedAt: new Date() }).where(eq(projects.id, params.id));
    await db.update(databases).set({ teamId: body.targetTeamId }).where(eq(databases.projectId, params.id));
    await db.update(buckets).set({ teamId: body.targetTeamId }).where(eq(buckets.projectId, params.id));
    await enqueue("maintenance", { task: `move-project-network:${params.id}` });
    await audit(actorOf(req), a.team.id, "project.transfer_out", { type: "project", id: params.id }, { to: body.targetTeamId });
    await audit(actorOf(req), body.targetTeamId, "project.transfer_in", { type: "project", id: params.id }, { from: a.team.id });
    return { ok: true };
  });

  /** Infrastructure as Code export (skyhost.json). Secrets are never exported. */
  route(app, { method: "GET", url: "/projects/:id/export", tags: ["projects"], params: idParam }, async (req, reply, { params }) => {
    const a = await projectAccess(req, params.id, "project:read");
    const db = getDb();
    const svcs = await db.select().from(services).where(and(eq(services.projectId, params.id), isNull(services.deletedAt)));
    const dbs = await db.select().from(databases).where(and(eq(databases.projectId, params.id), isNull(databases.deletedAt)));
    const conns = dbs.length ? await db.select().from(databaseConnections).where(inArray(databaseConnections.databaseId, dbs.map((d) => d.id))) : [];
    const prod = (await db.select().from(environments).where(and(eq(environments.projectId, params.id), eq(environments.type, "production"))))[0];
    const vars = prod ? await db.select().from(variables).where(eq(variables.environmentId, prod.id)) : [];
    const doc = {
      $schema: "https://skyhost.app/schema/skyhost.json",
      version: 1,
      project: { name: a.project.name, region: a.project.regionId },
      services: svcs.map((s) => {
        const { registryAuth: _ra, ...source } = s.source as Record<string, unknown>;
        const prot = { ...s.config.protection, basicPassword: undefined, password: undefined };
        return { name: s.name, type: s.type, source, config: { ...s.config, protection: prot }, variables: vars.filter((v) => v.serviceId === s.id).map((v) => ({ key: v.key, secret: v.isSecret })) };
      }),
      databases: dbs.map((d) => ({ name: d.name, engine: d.engine, version: d.version, storageMb: d.storageMb, connectTo: conns.filter((c) => c.databaseId === d.id).map((c) => svcs.find((s) => s.id === c.serviceId)?.name).filter(Boolean) })),
      sharedVariables: vars.filter((v) => !v.serviceId).map((v) => ({ key: v.key, secret: v.isSecret })),
    };
    reply.header("Content-Disposition", `attachment; filename="skyhost.json"`);
    return doc;
  });

  // -------------------------------------------------------------------------------------- Environments
  route(app, { method: "POST", url: "/projects/:id/environments", tags: ["environments"], params: idParam, body: createEnvironmentSchema }, async (req, reply, { params, body }) => {
    const a = await projectAccess(req, params.id, "project:update");
    const db = getDb();
    if (body.type === "production") throw badRequest("A project has exactly one production environment");
    const existing = await db.select().from(environments).where(and(eq(environments.projectId, params.id), eq(environments.name, body.name), isNull(environments.deletedAt)));
    if (existing.length) throw conflict("An environment with this name already exists");
    const [env] = await db.insert(environments).values({ projectId: params.id, name: body.name, type: body.type, clonedFromId: body.cloneFrom ?? null }).returning();
    const svcs = await db.select().from(services).where(and(eq(services.projectId, params.id), isNull(services.deletedAt)));
    for (const s of svcs) await db.insert(serviceInstances).values({ serviceId: s.id, environmentId: env!.id }).onConflictDoNothing();
    let copied = 0;
    if (body.cloneFrom) {
      const [src] = await db.select().from(environments).where(and(eq(environments.id, body.cloneFrom), eq(environments.projectId, params.id)));
      if (!src) throw badRequest("Unknown source environment");
      // Previews never inherit production secrets.
      copied = await copyVariables(src.id, env!.id, params.id, { includeSecrets: body.type !== "preview" });
      if (body.cloneDatabases) {
        const dbs = await db.select().from(databases).where(and(eq(databases.projectId, params.id), isNull(databases.deletedAt), or(isNull(databases.environmentId), eq(databases.environmentId, src.id))));
        for (const d of dbs) {
          const clone = await createDatabase({ teamId: a.team.id, projectId: params.id, environmentId: env!.id, name: `${d.name}-${slugify(body.name, 10)}`, engine: d.engine as never, version: d.version, storageMb: d.storageMb });
          await db.update(databases).set({ clonedFromId: d.id }).where(eq(databases.id, clone.id));
          await enqueue("database", { action: "clone", databaseId: clone.id, sourceId: d.id, anonymize: body.anonymize }, { delay: 2000, attempts: 3, backoff: { type: "exponential", delay: 10_000 } });
          // Services of the new environment use the cloned database under the same variable names.
          const conns = await db.select().from(databaseConnections).where(eq(databaseConnections.databaseId, d.id));
          for (const c of conns) {
            await upsertVariables(params.id, env!.id, c.serviceId, [{ key: c.variableName, value: `\${{${clone.name}.${c.variableName === "MONGODB_URI" ? "MONGODB_URI" : c.variableName === "REDIS_URL" ? "REDIS_URL" : "DATABASE_URL"}}}` }], false, req.auth.user!.id);
          }
        }
      }
    }
    await audit(actorOf(req), a.team.id, "environment.create", { type: "environment", id: env!.id }, { name: body.name, type: body.type, cloneFrom: body.cloneFrom, cloneDatabases: body.cloneDatabases, anonymize: body.anonymize });
    reply.code(201);
    return { environment: env, copiedVariables: copied };
  });

  route(app, { method: "DELETE", url: "/environments/:id", tags: ["environments"], params: idParam }, async (req, _r, { params }) => {
    const db = getDb();
    const [env] = await db.select().from(environments).where(eq(environments.id, params.id));
    if (!env) throw notFound("Environment");
    const a = await projectAccess(req, env.projectId, "project:update");
    if (env.type === "production") throw badRequest("The production environment cannot be deleted");
    await db.update(environments).set({ deletedAt: new Date() }).where(eq(environments.id, env.id));
    await enqueue("maintenance", { task: `teardown-environment:${env.id}` });
    await audit(actorOf(req), a.team.id, "environment.delete", { type: "environment", id: env.id }, { name: env.name });
    return { ok: true };
  });

  // -------------------------------------------------------------------------------------- SmartDeploy
  route(
    app,
    { method: "POST", url: "/projects/analyze", tags: ["smartdeploy"], body: z.object({ teamId: z.string().uuid(), source: sourceSchema, rootDir: z.string().max(256).optional() }), rateLimit: { max: 30, timeWindow: "1 minute" } },
    async (req, _r, { body }) => {
      await teamAccess(req, body.teamId, "project:create");
      const source = await analyzeSourceFor(body.teamId, body.source);
      const job = await enqueue("analyze", { source, rootDir: body.rootDir }, { attempts: 1, removeOnComplete: { age: 600 } });
      let analysis: AnalysisResult & { commit?: unknown };
      try {
        analysis = (await job.waitUntilFinished(getQueueEvents("analyze"), 120_000)) as typeof analysis;
      } catch (e) {
        const msg = (e as Error).message;
        if (/timed out/i.test(msg)) throw unavailable("The analysis is taking too long. Try again or configure the service manually.");
        throw badRequest(`Could not analyze the repository: ${msg}`);
      }
      return { analysis, explanation: explainAnalysis(analysis) };
    },
  );

  /**
   * One-shot creation: project (optional), services, databases, connections and variables, then deploy.
   * Used by the "Project detected" card (single service, monorepo or docker-compose).
   */
  route(app, { method: "POST", url: "/projects/launch", tags: ["smartdeploy"], body: launchSchema }, async (req, reply, { body }) => {
    const access = await teamAccess(req, body.teamId, "service:create");
    const db = getDb();
    let projectId = body.projectId;
    let created = false;
    if (projectId) {
      const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.teamId, body.teamId), isNull(projects.deletedAt)));
      if (!p) throw notFound("Project");
    } else {
      await teamAccess(req, body.teamId, "project:create");
      const repoName = "repo" in body.source ? body.source.repo.split("/").pop() : "url" in body.source ? body.source.url.split("/").pop()?.replace(/\.git$/, "") : undefined;
      projectId = (await createProjectRecord(body.teamId, body.projectName ?? repoName ?? "New project", undefined, undefined, req.auth.user!.id)).project.id;
      created = true;
    }
    await assertQuota(body.teamId, "services", body.services.length);
    await assertQuota(body.teamId, "databases", body.databases.length);
    const [prod] = await db.select().from(environments).where(and(eq(environments.projectId, projectId!), eq(environments.type, "production")));
    const source = await validateSource(body.teamId, body.source as never);
    const createdServices: Array<typeof services.$inferSelect> = [];
    for (const s of body.services) {
      const svcSource = s.image ? { kind: "image", image: s.image } : source;
      const svc = await createService({ projectId: projectId!, teamId: body.teamId, name: s.name, type: s.type, source: svcSource as never, config: s.config, analysis: s.analysis ?? null, createdBy: req.auth.user!.id });
      createdServices.push(svc);
      if (s.variables.length) await upsertVariables(projectId!, prod!.id, svc.id, s.variables, false, req.auth.user!.id);
    }
    const createdDbs = [];
    for (const d of body.databases) {
      const row = await createDatabase({ teamId: body.teamId, projectId: projectId!, name: d.name, engine: d.engine });
      createdDbs.push(row);
      for (const target of d.connectTo) {
        const svc = createdServices.find((x) => x.name === target || x.slug === slugify(target));
        if (svc) await connectDatabase(row.id, svc.id, d.variableName);
      }
    }
    const deps = [];
    if (body.deploy) {
      for (const svc of createdServices) {
        deps.push(await createDeployment({ serviceId: svc.id, environmentId: prod!.id, trigger: "manual", actor: actorOf(req) }));
      }
    }
    await audit(actorOf(req), access.team.id, "project.launch", { type: "project", id: projectId! }, { services: createdServices.map((s) => s.name), databases: createdDbs.map((d) => d.name), createdProject: created });
    reply.code(201);
    return { projectId, services: createdServices.map((s) => ({ id: s.id, name: s.name, slug: s.slug })), databases: createdDbs.map((d) => ({ id: d.id, name: d.name })), deployments: deps.map((d) => ({ id: d.id, serviceId: d.serviceId })) };
  });

  // -------------------------------------------------------------------------------------- Templates
  route(app, { method: "GET", url: "/templates", public: true, tags: ["templates"] }, async () => ({ templates: TEMPLATES }));

  route(app, { method: "POST", url: "/templates/:id/deploy", tags: ["templates"], params: z.object({ id: z.string().max(64) }), body: z.object({ teamId: z.string().uuid(), projectName: nameSchema.optional() }) }, async (req, reply, { params, body }) => {
    const tpl = getTemplate(params.id);
    if (!tpl) throw notFound("Template");
    await teamAccess(req, body.teamId, "project:create");
    await assertQuota(body.teamId, "services", tpl.services.length);
    await assertQuota(body.teamId, "databases", tpl.databases.length);
    const { project, environment } = await createProjectRecord(body.teamId, body.projectName ?? tpl.name, tpl.description, undefined, req.auth.user!.id);
    const repo = process.env.SKYHOST_TEMPLATES_REPO;
    const svcs = [];
    for (const s of tpl.services) {
      const source = s.source.kind === "image" ? { kind: "image", image: s.source.image } : { kind: "git", url: repo ?? s.source.repo, branch: s.source.branch ?? "main" };
      const svc = await createService({
        projectId: project.id,
        teamId: body.teamId,
        name: s.name,
        type: s.type,
        source: source as never,
        config: { port: s.port, rootDir: s.source.kind === "git" ? (s.source.rootDir ?? ".") : ".", startCommand: s.startCommand, healthcheck: s.healthcheckPath ? { path: s.healthcheckPath, intervalSeconds: 5, timeoutSeconds: 5, retries: 24, enabled: true } : undefined } as never,
        createdBy: req.auth.user!.id,
        volumes: s.volumes,
      });
      const vars = Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value: value === "@secret" ? randomPassword(32) : value, secret: value === "@secret" }));
      if (vars.length) await upsertVariables(project.id, environment.id, svc.id, vars, false, req.auth.user!.id);
      svcs.push(svc);
    }
    for (const d of tpl.databases) {
      const row = await createDatabase({ teamId: body.teamId, projectId: project.id, name: d.name, engine: d.engine });
      for (const t of d.connectTo) {
        const svc = svcs.find((x) => x.name === t);
        if (svc) await connectDatabase(row.id, svc.id);
      }
    }
    // Databases need a moment to be provisioned; the deploy worker waits for connected databases.
    for (const svc of svcs) await createDeployment({ serviceId: svc.id, environmentId: environment.id, trigger: "template", actor: actorOf(req) });
    await audit(actorOf(req), body.teamId, "template.deploy", { type: "project", id: project.id }, { template: tpl.id });
    reply.code(201);
    return { projectId: project.id };
  });

  // -------------------------------------------------------------------------------------- Global search (Ctrl+K)
  route(app, { method: "GET", url: "/search", tags: ["search"], query: z.object({ q: z.string().trim().min(1).max(100), teamId: z.string().uuid().optional() }) }, async (req, _r, { query }) => {
    const db = getDb();
    const teamIds = (await db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, req.auth.user!.id))).map((t) => t.id).filter((t) => !query.teamId || t === query.teamId);
    if (!teamIds.length) return { results: [] };
    const like = `%${query.q.replace(/[%_\\]/g, "")}%`;
    const ps = await db.select().from(projects).where(and(inArray(projects.teamId, teamIds), isNull(projects.deletedAt), ilike(projects.name, like))).limit(10);
    const ss = await db
      .select({ s: services, p: projects })
      .from(services)
      .innerJoin(projects, eq(projects.id, services.projectId))
      .where(and(inArray(projects.teamId, teamIds), isNull(services.deletedAt), isNull(projects.deletedAt), or(ilike(services.name, like), ilike(services.slug, like))))
      .limit(10);
    const ds = await db.select().from(databases).where(and(inArray(databases.teamId, teamIds), isNull(databases.deletedAt), ilike(databases.name, like))).limit(10);
    const doms = await db
      .select({ d: domains, s: services, p: projects })
      .from(domains)
      .innerJoin(services, eq(services.id, domains.serviceId))
      .innerJoin(projects, eq(projects.id, services.projectId))
      .where(and(inArray(projects.teamId, teamIds), isNotNull(domains.serviceId), ilike(domains.hostname, like)))
      .limit(10);
    return {
      results: [
        ...ps.map((p) => ({ type: "project", id: p.id, title: p.name, subtitle: "Project", url: `/projects/${p.id}` })),
        ...ss.map(({ s, p }) => ({ type: "service", id: s.id, title: s.name, subtitle: `${p.name} · ${s.type}`, url: `/projects/${p.id}/services/${s.id}` })),
        ...ds.map((d) => ({ type: "database", id: d.id, title: d.name, subtitle: d.engine, url: `/projects/${d.projectId}/databases/${d.id}` })),
        ...doms.map(({ d, s, p }) => ({ type: "domain", id: d.id, title: d.hostname, subtitle: `${p.name} · ${s.name}`, url: `/projects/${p.id}/services/${s.id}?tab=domains` })),
      ],
    };
  });

  route(app, { method: "GET", url: "/projects/:id/changelog", tags: ["projects"], params: idParam }, async (req, _r, { params }) => {
    await projectAccess(req, params.id, "project:read");
    const db = getDb();
    const svcs = await db.select({ id: services.id, name: services.name }).from(services).where(eq(services.projectId, params.id));
    if (!svcs.length) return { entries: [] };
    const deps = await db
      .select()
      .from(deployments)
      .where(and(inArray(deployments.serviceId, svcs.map((s) => s.id)), eq(deployments.status, "live")))
      .orderBy(desc(deployments.createdAt))
      .limit(100);
    // Automatic changelog: one entry per live deployment, grouped by day.
    const seen = new Set<string>();
    const entries = deps
      .filter((d) => {
        const k = `${d.serviceId}:${d.commitSha}`;
        if (!d.commitSha || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((d) => ({ date: d.createdAt.toISOString().slice(0, 10), service: svcs.find((s) => s.id === d.serviceId)?.name, commit: d.commitSha?.slice(0, 7), message: d.commitMessage, author: d.commitAuthor, deploymentId: d.id }));
    return { entries };
  });

  void assertFeature;
}
