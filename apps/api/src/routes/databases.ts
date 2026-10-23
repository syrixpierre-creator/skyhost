import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import { databaseBackups, databaseConnections, databaseRestores, databases, environments, getDb, metricSamples, projects, services } from "@skyhost/db";
import { createDatabaseSchema, DATABASE_VERSIONS, type DatabaseEngine } from "@skyhost/shared";
import { Redactor } from "@skyhost/shared/node";
import { connectionUrl, DB_PORTS, getObjectStore, listTables, queryMongo, querySql, redisCommand, tailLogs, parseCommand } from "@skyhost/engine";
import { assertFeature, audit, badRequest, conflict, decryptDbPassword, enqueue, notFound, serverConfig, validateCron } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { databaseAccess, projectAccess, serviceAccess, teamAccess } from "../lib/authz";
import { uniqueProjectSlug } from "./projects";
import { idParam, route } from "../lib/http";
import { connectDatabase, createDatabase } from "../lib/provisioning";

function dbView(d: typeof databases.$inferSelect) {
  return {
    id: d.id,
    teamId: d.teamId,
    projectId: d.projectId,
    environmentId: d.environmentId,
    name: d.name,
    engine: d.engine,
    version: d.version,
    regionId: d.regionId,
    status: d.status,
    internalHost: `${d.internalHost}.internal`,
    port: d.port,
    dbName: d.dbName,
    username: d.username,
    storageMb: d.storageMb,
    publicAccess: d.publicAccess,
    publicPort: d.publicPort,
    ipAllowlist: d.ipAllowlist,
    deletionProtection: d.deletionProtection,
    backupSchedule: d.backupSchedule,
    backupRetentionDays: d.backupRetentionDays,
    backupsEnabled: d.backupsEnabled,
    error: d.error,
    readyAt: d.readyAt,
    createdAt: d.createdAt,
  };
}

const refOf = (d: typeof databases.$inferSelect) => ({ engine: d.engine as DatabaseEngine, container: d.containerName, username: d.username, password: decryptDbPassword(d.passwordEnc, d.id), dbName: d.dbName });

export default async function databaseRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/database-engines", public: true, tags: ["databases"] }, async () => ({ engines: DATABASE_VERSIONS }));

  route(app, { method: "POST", url: "/databases", tags: ["databases"], body: createDatabaseSchema.extend({ environmentId: z.string().uuid().optional(), connectServiceIds: z.array(z.string().uuid()).max(20).default([]) }) }, async (req, reply, { body }) => {
    const a = await projectAccess(req, body.projectId, "database:create");
    const d = await createDatabase({ teamId: a.team.id, projectId: body.projectId, environmentId: body.environmentId ?? null, name: body.name, engine: body.engine, version: body.version, regionId: body.region, storageMb: body.storageMb });
    for (const sid of body.connectServiceIds) {
      await serviceAccess(req, sid, "service:update");
      await connectDatabase(d.id, sid);
    }
    await audit(actorOf(req), a.team.id, "database.create", { type: "database", id: d.id }, { name: d.name, engine: d.engine, version: d.version });
    reply.code(201);
    const [row] = await getDb().select().from(databases).where(eq(databases.id, d.id));
    return { database: dbView(row!) };
  });

  // Standalone database, like Render: no app to create. It lives in the team's "Databases" project, which does not
  // count as a project in the plan, and any service of the team can connect to it.
  route(
    app,
    { method: "POST", url: "/teams/:teamId/databases", tags: ["databases"], params: z.object({ teamId: z.string().uuid() }), body: createDatabaseSchema.omit({ projectId: true }) },
    async (req, reply, { params, body }) => {
      const a = await teamAccess(req, params.teamId, "database:create");
      const db = getDb();
      let [home] = await db.select().from(projects).where(and(eq(projects.teamId, params.teamId), eq(projects.kind, "databases"), isNull(projects.deletedAt)));
      if (!home) {
        [home] = await db.insert(projects).values({ teamId: params.teamId, name: "Databases", slug: await uniqueProjectSlug(params.teamId, "databases"), description: "Standalone databases", kind: "databases", regionId: serverConfig().SKYHOST_REGION }).returning();
        await db.insert(environments).values({ projectId: home!.id, name: "production", type: "production" });
      }
      const d = await createDatabase({ teamId: params.teamId, projectId: home!.id, environmentId: null, name: body.name, engine: body.engine, version: body.version, regionId: body.region, storageMb: body.storageMb });
      await audit(actorOf(req), a.team.id, "database.create", { type: "database", id: d.id }, { name: d.name, engine: d.engine, version: d.version, standalone: true });
      reply.code(201);
      const [row] = await db.select().from(databases).where(eq(databases.id, d.id));
      return { database: dbView(row!) };
    },
  );

  route(app, { method: "GET", url: "/projects/:id/databases", tags: ["databases"], params: idParam }, async (req, _r, { params }) => {
    await projectAccess(req, params.id, "database:read");
    const rows = await getDb().select().from(databases).where(and(eq(databases.projectId, params.id), isNull(databases.deletedAt)));
    return { databases: rows.map(dbView) };
  });

  route(app, { method: "GET", url: "/databases/:id", tags: ["databases"], params: idParam }, async (req, _r, { params }) => {
    const a = await databaseAccess(req, params.id, "database:read");
    const db = getDb();
    const conns = await db.select({ c: databaseConnections, s: services }).from(databaseConnections).innerJoin(services, eq(services.id, databaseConnections.serviceId)).where(eq(databaseConnections.databaseId, params.id));
    return { database: dbView(a.database), connections: conns.map(({ c, s }) => ({ serviceId: s.id, serviceName: s.name, variableName: c.variableName })), permissions: [...a.permissions] };
  });

  route(app, { method: "GET", url: "/databases/:id/credentials", tags: ["databases"], params: idParam }, async (req, _r, { params }) => {
    const a = await databaseAccess(req, params.id, "database:credentials");
    const d = a.database;
    const password = decryptDbPassword(d.passwordEnc, d.id);
    const engine = d.engine as DatabaseEngine;
    const internal = { host: `${d.internalHost}.internal`, port: DB_PORTS[engine], username: d.username, password, dbName: d.dbName };
    const publicHost = process.env.SKYHOST_DATABASE_PUBLIC_HOST ?? `db.${serverConfig().SKYHOST_BASE_DOMAIN}`;
    await audit(actorOf(req), a.team.id, "database.credentials_viewed", { type: "database", id: d.id });
    return {
      credentials: {
        ...internal,
        connectionUrl: connectionUrl(engine, internal),
        internalUrl: connectionUrl(engine, internal),
        publicUrl: d.publicAccess && d.publicPort ? connectionUrl(engine, { ...internal, host: publicHost, port: d.publicPort }) : null,
      },
    };
  });

  route(app, { method: "POST", url: "/databases/:id/rotate-credentials", tags: ["databases"], params: idParam }, async (req, _r, { params }) => {
    const a = await databaseAccess(req, params.id, "database:credentials");
    if (a.database.status !== "available") throw conflict("The database must be available to rotate credentials");
    await enqueue("database", { action: "rotate", databaseId: params.id });
    await audit(actorOf(req), a.team.id, "database.credentials_rotated", { type: "database", id: params.id });
    return { ok: true, redeployRequired: true };
  });

  route(
    app,
    {
      method: "PATCH",
      url: "/databases/:id",
      tags: ["databases"],
      params: idParam,
      body: z.object({
        deletionProtection: z.boolean().optional(),
        backupsEnabled: z.boolean().optional(),
        backupSchedule: z.string().max(120).optional(),
        backupRetentionDays: z.number().int().min(1).max(365).optional(),
        publicAccess: z.boolean().optional(),
        ipAllowlist: z.array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/)).max(50).optional(),
      }),
    },
    async (req, _r, { params, body }) => {
      const a = await databaseAccess(req, params.id, "database:backup");
      if (body.backupSchedule) {
        const v = validateCron(body.backupSchedule);
        if (!v.ok) throw badRequest(`Invalid backup schedule: ${v.error}`);
      }
      if (body.publicAccess) {
        await assertFeature(a.team.id, "publicDatabaseAccess");
        const list = body.ipAllowlist ?? a.database.ipAllowlist;
        if (!list.length) throw badRequest("Add at least one IP address to the allowlist before enabling public access");
      }
      if (body.backupRetentionDays) {
        const { getTeamPlan } = await import("@skyhost/core");
        const plan = await getTeamPlan(a.team.id);
        if (body.backupRetentionDays > plan.limits.backupRetentionDays) throw badRequest(`Your plan keeps backups for at most ${plan.limits.backupRetentionDays} days`);
      }
      const [d] = await getDb().update(databases).set(body).where(eq(databases.id, params.id)).returning();
      if (body.publicAccess !== undefined || body.ipAllowlist) await enqueue("database", { action: "public", databaseId: params.id });
      await audit(actorOf(req), a.team.id, "database.update", { type: "database", id: params.id }, body);
      return { database: dbView(d!) };
    },
  );

  route(app, { method: "GET", url: "/databases/:id/connectable-services", tags: ["databases"], params: idParam }, async (req, _r, { params }) => {
    const a = await databaseAccess(req, params.id, "database:read");
    const rows = await getDb()
      .select({ id: services.id, name: services.name, projectId: projects.id, projectName: projects.name })
      .from(services)
      .innerJoin(projects, eq(projects.id, services.projectId))
      .where(and(eq(projects.teamId, a.team.id), isNull(projects.deletedAt), isNull(services.deletedAt)));
    return { services: rows };
  });

  route(app, { method: "POST", url: "/databases/:id/connections", tags: ["databases"], params: idParam, body: z.object({ serviceId: z.string().uuid(), variableName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(64).optional() }) }, async (req, reply, { params, body }) => {
    const a = await databaseAccess(req, params.id, "database:read");
    await serviceAccess(req, body.serviceId, "env:write");
    const res = await connectDatabase(params.id, body.serviceId, body.variableName);
    await audit(actorOf(req), a.team.id, "database.connect", { type: "database", id: params.id }, { serviceId: body.serviceId, variable: res.variableName });
    reply.code(201);
    return { ...res, redeployRequired: true };
  });

  route(app, { method: "DELETE", url: "/databases/:id/connections/:serviceId", tags: ["databases"], params: idParam.extend({ serviceId: z.string().uuid() }) }, async (req, _r, { params }) => {
    const a = await databaseAccess(req, params.id, "database:read");
    await serviceAccess(req, params.serviceId, "env:write");
    await getDb().delete(databaseConnections).where(and(eq(databaseConnections.databaseId, params.id), eq(databaseConnections.serviceId, params.serviceId)));
    await audit(actorOf(req), a.team.id, "database.disconnect", { type: "database", id: params.id }, { serviceId: params.serviceId });
    return { ok: true, redeployRequired: true };
  });

  // ---------------------------------------------------------------------------------- Data browser
  route(app, { method: "GET", url: "/databases/:id/tables", tags: ["databases"], params: idParam }, async (req, _r, { params }) => {
    const a = await databaseAccess(req, params.id, "database:query");
    if (a.database.status !== "available") throw conflict("The database is not available");
    return { tables: await listTables(refOf(a.database)) };
  });

  route(
    app,
    {
      method: "POST",
      url: "/databases/:id/query",
      tags: ["databases"],
      params: idParam,
      body: z.object({ sql: z.string().max(20_000).optional(), collection: z.string().max(120).optional(), filter: z.string().max(10_000).optional(), command: z.string().max(1000).optional(), limit: z.number().int().min(1).max(500).default(100) }),
      rateLimit: { max: 60, timeWindow: "1 minute" },
    },
    async (req, _r, { params, body }) => {
      const a = await databaseAccess(req, params.id, "database:query");
      const d = a.database;
      if (d.status !== "available") throw conflict("The database is not available");
      const ref = refOf(d);
      const redactor = new Redactor().add(ref.password);
      await audit(actorOf(req), a.team.id, "database.query", { type: "database", id: d.id }, { kind: d.engine, query: (body.sql ?? body.command ?? body.collection ?? "").slice(0, 500) });
      try {
        if (d.engine === "postgres" || d.engine === "mariadb") {
          if (!body.sql) throw badRequest("sql is required");
          return { result: await querySql(ref, body.sql) };
        }
        if (d.engine === "mongodb") {
          if (!body.collection) throw badRequest("collection is required");
          try {
            JSON.parse(body.filter || "{}");
          } catch {
            throw badRequest("filter must be valid JSON");
          }
          return { documents: await queryMongo(ref, body.collection, body.filter ?? "{}", body.limit) };
        }
        if (!body.command) throw badRequest("command is required");
        const argv = parseCommand(body.command);
        return { output: redactor.apply(await redisCommand(ref, argv)) };
      } catch (e) {
        if ((e as { status?: number }).status) throw e;
        throw badRequest(redactor.apply((e as Error).message));
      }
    },
  );

  // ---------------------------------------------------------------------------------- Backups
  route(app, { method: "GET", url: "/databases/:id/backups", tags: ["backups"], params: idParam }, async (req, _r, { params }) => {
    await databaseAccess(req, params.id, "database:read");
    const db = getDb();
    const backups = await db.select().from(databaseBackups).where(eq(databaseBackups.databaseId, params.id)).orderBy(desc(databaseBackups.createdAt)).limit(200);
    const restores = await db.select().from(databaseRestores).where(eq(databaseRestores.databaseId, params.id)).orderBy(desc(databaseRestores.createdAt)).limit(50);
    return { backups: backups.map(({ objectKey: _k, ...b }) => b), restores };
  });

  route(app, { method: "POST", url: "/databases/:id/backups", tags: ["backups"], params: idParam }, async (req, reply, { params }) => {
    const a = await databaseAccess(req, params.id, "database:backup");
    if (a.database.status !== "available") throw conflict("The database is not available");
    const [b] = await getDb().insert(databaseBackups).values({ databaseId: params.id, kind: "manual", createdBy: req.auth.user!.id }).returning();
    await enqueue("backup", { action: "backup", backupId: b!.id }, { jobId: b!.id });
    await audit(actorOf(req), a.team.id, "database.backup", { type: "database", id: params.id }, { backupId: b!.id });
    reply.code(201);
    return { backup: b };
  });

  route(app, { method: "POST", url: "/backups/:id/restore", tags: ["backups"], params: idParam, body: z.object({ confirmName: z.string() }) }, async (req, reply, { params, body }) => {
    const db = getDb();
    const [b] = await db.select().from(databaseBackups).where(eq(databaseBackups.id, params.id));
    if (!b) throw notFound("Backup");
    const a = await databaseAccess(req, b.databaseId, "database:backup");
    if (body.confirmName !== a.database.name) throw badRequest("Type the database name to confirm the restore");
    if (b.status !== "completed") throw conflict("Only completed backups can be restored");
    const [r] = await db.insert(databaseRestores).values({ databaseId: b.databaseId, backupId: b.id, createdBy: req.auth.user!.id }).returning();
    await enqueue("backup", { action: "restore", restoreId: r!.id }, { jobId: r!.id });
    await audit(actorOf(req), a.team.id, "database.restore", { type: "database", id: b.databaseId }, { backupId: b.id });
    reply.code(201);
    return { restore: r };
  });

  route(app, { method: "GET", url: "/backups/:id/download", tags: ["backups"], params: idParam }, async (req, reply, { params }) => {
    const [b] = await getDb().select().from(databaseBackups).where(eq(databaseBackups.id, params.id));
    if (!b?.objectKey) throw notFound("Backup");
    const a = await databaseAccess(req, b.databaseId, "database:credentials");
    const data = await getObjectStore().get(b.objectKey);
    await audit(actorOf(req), a.team.id, "database.backup_downloaded", { type: "database", id: b.databaseId }, { backupId: b.id });
    const ext = { postgres: "dump", mariadb: "sql", mongodb: "archive.gz", redis: "rdb" }[a.database.engine] ?? "bin";
    reply.header("Content-Type", "application/octet-stream").header("Content-Disposition", `attachment; filename="${a.database.name}-${b.createdAt.toISOString().slice(0, 19).replace(/:/g, "")}.${ext}"`);
    return reply.send(data);
  });

  // ---------------------------------------------------------------------------------- Metrics & logs
  route(app, { method: "GET", url: "/databases/:id/metrics", tags: ["metrics"], params: idParam, query: z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) }) }, async (req, _r, { params, query }) => {
    const a = await databaseAccess(req, params.id, "metrics:read");
    const since = new Date(Date.now() - query.hours * 3600_000);
    const rows = await getDb().select().from(metricSamples).where(and(eq(metricSamples.databaseId, params.id), gte(metricSamples.createdAt, since))).orderBy(metricSamples.createdAt).limit(5000);
    const up = rows.length ? rows.filter((r) => r.up).length / rows.length : null;
    return { samples: rows, uptimePercent: up === null ? null : Math.round(up * 10000) / 100, readyAt: a.database.readyAt };
  });

  route(app, { method: "GET", url: "/databases/:id/logs", tags: ["logs"], params: idParam, query: z.object({ lines: z.coerce.number().int().min(10).max(2000).default(300) }) }, async (req, _r, { params, query }) => {
    const a = await databaseAccess(req, params.id, "logs:read");
    const redactor = new Redactor().add(decryptDbPassword(a.database.passwordEnc, a.database.id));
    const text = await tailLogs(a.database.containerName, query.lines);
    return { lines: text.split("\n").filter(Boolean).map((l) => redactor.apply(l)) };
  });

  // ---------------------------------------------------------------------------------- Danger zone
  route(app, { method: "DELETE", url: "/databases/:id", tags: ["databases"], params: idParam, body: z.object({ confirmName: z.string(), keepBackups: z.boolean().default(false) }) }, async (req, _r, { params, body }) => {
    const a = await databaseAccess(req, params.id, "database:delete");
    if (a.database.deletionProtection) throw conflict("Deletion protection is enabled for this database. Disable it first.");
    if (body.confirmName !== a.database.name) throw badRequest("Type the database name to confirm");
    await getDb().update(databases).set({ deletedAt: new Date(), status: "deleting" }).where(eq(databases.id, params.id));
    await enqueue("database", { action: "delete", databaseId: params.id, keepBackups: body.keepBackups });
    await audit(actorOf(req), a.team.id, "database.delete", { type: "database", id: params.id }, { name: a.database.name, keepBackups: body.keepBackups });
    return { ok: true };
  });
}
