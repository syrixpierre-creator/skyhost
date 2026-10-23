import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  databaseConnections, databases, domains, environments, getDb, jobRuns, serviceInstances, services, uploads, volumes, volumeSnapshots,
} from "@skyhost/db";
import { createServiceSchema, serviceConfigSchema, sourceSchema, type ServiceConfig } from "@skyhost/shared";
import { encrypt, randomId, sha256 } from "@skyhost/shared/node";
import { getObjectStore, names, ShellRejected, validateCommand } from "@skyhost/engine";
import {
  assertFeature, assertQuota, audit, badRequest, conflict, createDeployment, enqueue, getTeamPlan, notFound, protectionSecretAad, publicUrl, publish, serviceHostname, validateCron,
} from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { environmentAccess, projectAccess, serviceAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";
import { createService, productionEnvironment, validateSource } from "../lib/provisioning";

const MAX_ZIP = 100 * 1024 * 1024;

function serviceView(s: typeof services.$inferSelect) {
  const prot = s.config.protection;
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    slug: s.slug,
    type: s.type,
    source: { ...s.source, ...(s.source.registryAuth ? { registryAuth: "[hidden]" } : {}) },
    config: { ...s.config, protection: { ...prot, basicPassword: prot?.basicPassword ? "********" : undefined, password: prot?.password ? "********" : undefined } },
    analysis: s.analysis,
    subdomain: s.subdomain,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Encrypts protection passwords before they are stored in the service config. */
function sealProtection(serviceId: string, next: ServiceConfig, prev?: ServiceConfig): ServiceConfig {
  const p = { ...next.protection };
  for (const k of ["basicPassword", "password"] as const) {
    const v = p[k];
    if (v === "********" || v === undefined) p[k] = prev?.protection?.[k];
    else if (v && !v.startsWith("v1:")) p[k] = encrypt(v, undefined, protectionSecretAad(serviceId));
  }
  return { ...next, protection: p };
}

export async function storeUpload(teamId: string, userId: string, data: Buffer, kind = "source-zip") {
  if (data.length > MAX_ZIP) throw badRequest("Archive is larger than 100 MB");
  if (data.subarray(0, 4).toString("hex") !== "504b0304") throw badRequest("The file is not a ZIP archive");
  const db = getDb();
  const key = `uploads/${teamId}/${randomId(16)}.zip`;
  await getObjectStore().put(key, data, "application/zip");
  const [u] = await db.insert(uploads).values({ teamId, userId, kind, objectKey: key, sizeBytes: data.length, sha256: sha256(data) }).returning();
  return u!;
}

export default async function serviceRoutes(app: FastifyInstance) {
  route(app, { method: "POST", url: "/projects/:id/services", tags: ["services"], params: idParam, body: createServiceSchema }, async (req, reply, { params, body }) => {
    const a = await projectAccess(req, params.id, "service:create");
    const source = await validateSource(a.team.id, body.source as never);
    const svc = await createService({ projectId: params.id, teamId: a.team.id, name: body.name, type: body.type, source: source as never, config: body.config, createdBy: req.auth.user!.id });
    await audit(actorOf(req), a.team.id, "service.create", { type: "service", id: svc.id }, { name: svc.name, type: svc.type, source: source.kind });
    let deployment = null;
    if (body.deploy) {
      const env = await productionEnvironment(params.id);
      deployment = await createDeployment({ serviceId: svc.id, environmentId: env.id, trigger: "manual", actor: actorOf(req) });
    }
    await publish(`project:${params.id}`, { type: "service.created", serviceId: svc.id });
    reply.code(201);
    return { service: serviceView(svc), deployment };
  });

  route(app, { method: "GET", url: "/services/:id", tags: ["services"], params: idParam }, async (req, _r, { params }) => {
    const a = await serviceAccess(req, params.id, "service:read");
    const db = getDb();
    const envs = await db.select().from(environments).where(and(eq(environments.projectId, a.service.projectId), isNull(environments.deletedAt)));
    const insts = await db.select().from(serviceInstances).where(eq(serviceInstances.serviceId, params.id));
    const doms = await db.select().from(domains).where(eq(domains.serviceId, params.id));
    const vols = await db.select().from(volumes).where(eq(volumes.serviceId, params.id));
    const conns = await db.select({ c: databaseConnections, d: databases }).from(databaseConnections).innerJoin(databases, eq(databases.id, databaseConnections.databaseId)).where(eq(databaseConnections.serviceId, params.id));
    return {
      service: serviceView(a.service),
      role: a.role,
      permissions: [...a.permissions],
      environments: envs.map((e) => {
        const i = insts.find((x) => x.environmentId === e.id);
        return {
          ...e,
          instance: i ?? null,
          generatedDomain: ["web", "static", "docker"].includes(a.service.type) ? serviceHostname(a.service, e) : null,
          url: ["web", "static", "docker"].includes(a.service.type) && i?.liveDeploymentId ? publicUrl(serviceHostname(a.service, e)) : null,
          internalHost: `${a.service.slug}.internal`,
        };
      }),
      domains: doms,
      volumes: vols,
      databases: conns.map(({ c, d }) => ({ id: d.id, name: d.name, engine: d.engine, variableName: c.variableName, status: d.status })),
    };
  });

  route(
    app,
    { method: "PATCH", url: "/services/:id", tags: ["services"], params: idParam, body: z.object({ name: z.string().trim().min(1).max(48).optional(), config: serviceConfigSchema.partial().optional() }) },
    async (req, _r, { params, body }) => {
      const a = await serviceAccess(req, params.id, "service:update");
      const merged = serviceConfigSchema.parse({ ...a.service.config, ...(body.config ?? {}) });
      if (merged.cron) {
        const v = validateCron(merged.cron.schedule, merged.cron.timezone);
        if (!v.ok) throw badRequest(`Invalid cron schedule: ${v.error}`);
      }
      if (a.service.type === "cron" && !merged.cron) throw badRequest("Cron jobs need a schedule");
      if (merged.protection.mode !== "none" && a.service.config.protection?.mode !== merged.protection.mode) await assertFeature(a.team.id, "accessProtection");
      if (merged.waf.enabled && !a.service.config.waf?.enabled) await assertFeature(a.team.id, "waf");
      const plan = await getTeamPlan(a.team.id);
      if (plan.features.autoSleepForced && merged.sleepAfterMinutes === 0 && ["web", "docker"].includes(a.service.type)) merged.sleepAfterMinutes = 30;
      const res = merged.resources;
      const prev = a.service.config.resources;
      const deltaCpu = res.cpu * res.replicas - (prev?.cpu ?? 0.5) * (prev?.replicas ?? 1);
      const deltaMem = res.memoryMb * res.replicas - (prev?.memoryMb ?? 512) * (prev?.replicas ?? 1);
      if (deltaCpu > 0) await assertQuota(a.team.id, "cpu", deltaCpu);
      if (deltaMem > 0) await assertQuota(a.team.id, "memoryMb", deltaMem);
      const config = sealProtection(params.id, merged, a.service.config);
      const [s] = await getDb().update(services).set({ name: body.name ?? a.service.name, config, updatedAt: new Date() }).where(eq(services.id, params.id)).returning();
      await audit(actorOf(req), a.team.id, "service.update", { type: "service", id: params.id }, { fields: Object.keys(body.config ?? {}) });
      // Routing related settings apply immediately; build/runtime settings need a redeploy.
      const live = ["protection", "waf", "sleepAfterMinutes"];
      const keys = Object.keys(body.config ?? {});
      await enqueue("maintenance", { task: "reconcile-proxy" });
      return { service: serviceView(s!), redeployRequired: keys.some((k) => !live.includes(k)) };
    },
  );

  route(app, { method: "PUT", url: "/services/:id/source", tags: ["services"], params: idParam, body: z.object({ source: sourceSchema }) }, async (req, _r, { params, body }) => {
    const a = await serviceAccess(req, params.id, "service:update");
    const source = await validateSource(a.team.id, body.source as never);
    await getDb().update(services).set({ source: source as never, updatedAt: new Date() }).where(eq(services.id, params.id));
    await audit(actorOf(req), a.team.id, "service.source_changed", { type: "service", id: params.id }, { kind: source.kind, branch: (source as { branch?: string }).branch });
    return { ok: true };
  });

  route(app, { method: "DELETE", url: "/services/:id", tags: ["services"], params: idParam, body: z.object({ confirmName: z.string() }) }, async (req, _r, { params, body }) => {
    const a = await serviceAccess(req, params.id, "service:delete");
    if (body.confirmName !== a.service.name) throw badRequest("Type the service name to confirm");
    await getDb().update(services).set({ deletedAt: new Date() }).where(eq(services.id, params.id));
    await enqueue("maintenance", { task: `teardown-service:${params.id}` });
    await audit(actorOf(req), a.team.id, "service.delete", { type: "service", id: params.id }, { name: a.service.name });
    await publish(`project:${a.service.projectId}`, { type: "service.deleted", serviceId: params.id });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/services/:id/duplicate", tags: ["services"], params: idParam, body: z.object({ name: z.string().trim().min(1).max(48) }) }, async (req, reply, { params, body }) => {
    const a = await serviceAccess(req, params.id, "service:create");
    const vols = await getDb().select().from(volumes).where(eq(volumes.serviceId, params.id));
    const uniqueVols = [...new Map(vols.map((v) => [v.name, { name: v.name, mountPath: v.mountPath, sizeMb: v.sizeMb }])).values()];
    const svc = await createService({ projectId: a.service.projectId, teamId: a.team.id, name: body.name, type: a.service.type as never, source: a.service.source, config: a.service.config, analysis: a.service.analysis, createdBy: req.auth.user!.id, volumes: uniqueVols });
    await audit(actorOf(req), a.team.id, "service.duplicate", { type: "service", id: svc.id }, { from: params.id });
    reply.code(201);
    return { service: serviceView(svc) };
  });

  // ---------------------------------------------------------------------------------- Runtime controls
  const envBody = z.object({ environmentId: z.string().uuid() });
  for (const action of ["restart", "stop", "start"] as const) {
    route(app, { method: "POST", url: `/services/:id/${action}`, tags: ["services"], params: idParam, body: envBody }, async (req, _r, { params, body }) => {
      const a = await serviceAccess(req, params.id, "deploy:create");
      const [inst] = await getDb().select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, params.id), eq(serviceInstances.environmentId, body.environmentId)));
      if (!inst?.liveDeploymentId && action !== "stop") throw badRequest("This service has no live deployment yet");
      await enqueue("maintenance", { task: `${action}:${params.id}:${body.environmentId}` });
      await audit(actorOf(req), a.team.id, `service.${action}`, { type: "service", id: params.id }, { environmentId: body.environmentId });
      return { ok: true };
    });
  }

  route(
    app,
    { method: "POST", url: "/services/:id/canary", tags: ["deployments"], params: idParam, body: z.object({ environmentId: z.string().uuid(), action: z.enum(["set_weight", "promote", "abort"]), weight: z.number().int().min(1).max(99).optional() }) },
    async (req, _r, { params, body }) => {
      const a = await serviceAccess(req, params.id, "deploy:create");
      await assertFeature(a.team.id, "canary");
      const db = getDb();
      const [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, params.id), eq(serviceInstances.environmentId, body.environmentId)));
      if (!inst?.canaryDeploymentId) throw badRequest("There is no canary deployment running");
      if (body.action === "set_weight") {
        if (!body.weight) throw badRequest("weight is required");
        await db.update(serviceInstances).set({ canaryWeight: body.weight }).where(eq(serviceInstances.id, inst.id));
      } else {
        await enqueue("maintenance", { task: `canary-${body.action}:${inst.id}` });
      }
      await enqueue("maintenance", { task: "reconcile-proxy" });
      await audit(actorOf(req), a.team.id, `deployment.canary_${body.action}`, { type: "service", id: params.id }, { weight: body.weight });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------------- Deploy from ZIP
  app.post("/uploads", { schema: { tags: ["uploads"], summary: "Upload a ZIP archive (multipart field 'file')", querystring: { type: "object", properties: { teamId: { type: "string" } } } } }, async (req, reply) => {
    if (!req.auth.user) return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required" } });
    const teamId = (req.query as { teamId?: string }).teamId;
    if (!teamId || !/^[0-9a-f-]{36}$/.test(teamId)) throw badRequest("teamId is required");
    const { teamAccess } = await import("../lib/authz");
    await teamAccess(req, teamId, "service:create");
    const file = await req.file();
    if (!file) throw badRequest("Send the archive in the 'file' field");
    const data = await file.toBuffer();
    const u = await storeUpload(teamId, req.auth.user.id, data);
    await audit(actorOf(req), teamId, "upload.create", { type: "upload", id: u.id }, { sizeBytes: u.sizeBytes });
    reply.code(201);
    return { upload: { id: u.id, sizeBytes: u.sizeBytes, sha256: u.sha256 } };
  });

  app.post("/services/:id/deploy-zip", { schema: { tags: ["deployments"], summary: "Deploy a ZIP archive to a service (multipart field 'file')", params: { type: "object", properties: { id: { type: "string" } } } } }, async (req, reply) => {
    if (!req.auth.user) return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required" } });
    const { id } = idParam.parse(req.params);
    const a = await serviceAccess(req, id, "deploy:create");
    const envId = (req.query as { environmentId?: string }).environmentId;
    const env = envId ? (await environmentAccess(req, envId, "deploy:create")).environment : await productionEnvironment(a.service.projectId);
    if (env.projectId !== a.service.projectId) throw badRequest("Environment of another project");
    const file = await req.file();
    if (!file) throw badRequest("Send the archive in the 'file' field");
    const u = await storeUpload(a.team.id, req.auth.user.id, await file.toBuffer());
    await getDb().update(services).set({ source: { kind: "zip", uploadId: u.id }, updatedAt: new Date() }).where(eq(services.id, id));
    const dep = await createDeployment({ serviceId: id, environmentId: env.id, trigger: req.auth.apiKey ? "cli" : "manual", actor: actorOf(req), sourceRef: { uploadId: u.id } });
    reply.code(201);
    return { deployment: dep };
  });

  // ---------------------------------------------------------------------------------- Volumes
  route(
    app,
    { method: "POST", url: "/services/:id/volumes", tags: ["volumes"], params: idParam, body: z.object({ name: z.string().regex(/^[a-z0-9-]{1,32}$/), mountPath: z.string().regex(/^\/[A-Za-z0-9_./-]*$/).max(200), sizeMb: z.number().int().min(64).max(1_048_576) }) },
    async (req, reply, { params, body }) => {
      const a = await serviceAccess(req, params.id, "service:update");
      if (body.mountPath.includes("..") || ["/", "/proc", "/sys", "/dev", "/etc", "/bin", "/usr"].includes(body.mountPath)) throw badRequest("This mount path is not allowed");
      const db = getDb();
      const envs = await db.select().from(environments).where(and(eq(environments.projectId, a.service.projectId), isNull(environments.deletedAt), eq(environments.isEphemeral, false)));
      await assertQuota(a.team.id, "volumesMb", body.sizeMb * envs.length);
      const existing = await db.select().from(volumes).where(and(eq(volumes.serviceId, params.id), eq(volumes.name, body.name)));
      if (existing.length) throw conflict("A volume with this name already exists");
      const created = [];
      for (const env of envs) {
        const [v] = await db.insert(volumes).values({ serviceId: params.id, environmentId: env.id, name: body.name, mountPath: body.mountPath, sizeMb: body.sizeMb, dockerVolume: `pending-${randomId(10)}` }).returning();
        await db.update(volumes).set({ dockerVolume: names.volume(v!.id) }).where(eq(volumes.id, v!.id));
        created.push(v);
      }
      await audit(actorOf(req), a.team.id, "volume.create", { type: "service", id: params.id }, body);
      reply.code(201);
      return { volumes: created, redeployRequired: true };
    },
  );

  route(app, { method: "DELETE", url: "/volumes/:id", tags: ["volumes"], params: idParam, body: z.object({ confirmName: z.string() }) }, async (req, _r, { params, body }) => {
    const db = getDb();
    const [v] = await db.select().from(volumes).where(eq(volumes.id, params.id));
    if (!v) throw notFound("Volume");
    const a = await serviceAccess(req, v.serviceId, "service:update");
    if (body.confirmName !== v.name) throw badRequest("Type the volume name to confirm");
    await db.delete(volumes).where(eq(volumes.id, v.id));
    await enqueue("maintenance", { task: `delete-volume:${v.dockerVolume}` });
    await audit(actorOf(req), a.team.id, "volume.delete", { type: "volume", id: v.id }, { name: v.name });
    return { ok: true, redeployRequired: true };
  });

  route(app, { method: "POST", url: "/volumes/:id/snapshots", tags: ["volumes"], params: idParam }, async (req, reply, { params }) => {
    const db = getDb();
    const [v] = await db.select().from(volumes).where(eq(volumes.id, params.id));
    if (!v) throw notFound("Volume");
    const a = await serviceAccess(req, v.serviceId, "service:update");
    const [snap] = await db.insert(volumeSnapshots).values({ volumeId: v.id }).returning();
    await enqueue("maintenance", { task: `snapshot-volume:${snap!.id}` });
    await audit(actorOf(req), a.team.id, "volume.snapshot", { type: "volume", id: v.id });
    reply.code(201);
    return { snapshot: snap };
  });

  route(app, { method: "GET", url: "/volumes/:id/snapshots", tags: ["volumes"], params: idParam }, async (req, _r, { params }) => {
    const db = getDb();
    const [v] = await db.select().from(volumes).where(eq(volumes.id, params.id));
    if (!v) throw notFound("Volume");
    await serviceAccess(req, v.serviceId, "service:read");
    return { snapshots: await db.select().from(volumeSnapshots).where(eq(volumeSnapshots.volumeId, v.id)).orderBy(desc(volumeSnapshots.createdAt)) };
  });

  // ---------------------------------------------------------------------------------- One-off jobs & cron
  route(app, { method: "POST", url: "/services/:id/jobs", tags: ["jobs"], params: idParam, body: z.object({ environmentId: z.string().uuid(), command: z.string().min(1).max(2000) }) }, async (req, reply, { params, body }) => {
    const a = await serviceAccess(req, params.id, "shell:access");
    const db = getDb();
    const [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, params.id), eq(serviceInstances.environmentId, body.environmentId)));
    if (!inst?.liveDeploymentId) throw badRequest("Deploy the service once before running jobs (jobs use its image)");
    if (/[\r\n]/.test(body.command)) throw badRequest("Commands must be a single line");
    const [run] = await db.insert(jobRuns).values({ serviceId: params.id, environmentId: body.environmentId, kind: "oneoff", command: body.command, triggeredBy: req.auth.user!.id }).returning();
    await enqueue("job", { jobRunId: run!.id }, { jobId: run!.id });
    await audit(actorOf(req), a.team.id, "job.run", { type: "job", id: run!.id }, { command: body.command });
    reply.code(201);
    return { job: run };
  });

  route(app, { method: "POST", url: "/services/:id/cron/run", tags: ["jobs"], params: idParam, body: z.object({ environmentId: z.string().uuid() }) }, async (req, reply, { params, body }) => {
    const a = await serviceAccess(req, params.id, "deploy:create");
    if (a.service.type !== "cron") throw badRequest("This service is not a cron job");
    const db = getDb();
    const [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, params.id), eq(serviceInstances.environmentId, body.environmentId)));
    if (!inst?.liveDeploymentId) throw badRequest("Deploy the cron job once before running it");
    const [run] = await db.insert(jobRuns).values({ serviceId: params.id, environmentId: body.environmentId, kind: "cron", command: a.service.config.startCommand ?? "(image default)", triggeredBy: req.auth.user!.id }).returning();
    await enqueue("job", { jobRunId: run!.id }, { jobId: run!.id });
    await audit(actorOf(req), a.team.id, "cron.manual_run", { type: "job", id: run!.id });
    reply.code(201);
    return { job: run };
  });

  route(app, { method: "GET", url: "/services/:id/jobs", tags: ["jobs"], params: idParam, query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }) }, async (req, _r, { params, query }) => {
    await serviceAccess(req, params.id, "logs:read");
    return { jobs: await getDb().select().from(jobRuns).where(eq(jobRuns.serviceId, params.id)).orderBy(desc(jobRuns.createdAt)).limit(query.limit) };
  });

  route(app, { method: "GET", url: "/jobs/:id", tags: ["jobs"], params: idParam }, async (req, _r, { params }) => {
    const [job] = await getDb().select().from(jobRuns).where(eq(jobRuns.id, params.id));
    if (!job) throw notFound("Job");
    await serviceAccess(req, job.serviceId, "logs:read");
    return { job };
  });

  route(app, { method: "POST", url: "/services/:id/shell/validate", tags: ["shell"], params: idParam, body: z.object({ command: z.string().max(2000) }) }, async (req, _r, { params, body }) => {
    const a = await serviceAccess(req, params.id, "shell:access");
    try {
      return { ok: true, argv: validateCommand(body.command, a.service.config.runtime) };
    } catch (e) {
      if (e instanceof ShellRejected) return { ok: false, error: e.message };
      throw e;
    }
  });

  void environmentAccess;
}
