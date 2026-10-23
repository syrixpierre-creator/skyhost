import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { environments, getDb, services, variableGroupItems, variableGroupLinks, variableGroups, variables } from "@skyhost/db";
import { bulkVariablesSchema, ENVIRONMENT_TYPES, ENV_KEY_RE, nameSchema, parseDotenv, parseEnvJson, serializeDotenv, toEnvJson } from "@skyhost/shared";
import { decrypt, encrypt } from "@skyhost/shared/node";
import { audit, badRequest, copyVariables, groupItemAad, listVariables, notFound, resolveServiceEnv, upsertVariables } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { environmentAccess, serviceAccess, teamAccess } from "../lib/authz";
import { idParam, queryBool, route } from "../lib/http";

export default async function variableRoutes(app: FastifyInstance) {
  route(
    app,
    { method: "GET", url: "/environments/:id/variables", tags: ["variables"], params: idParam, query: z.object({ serviceId: z.string().uuid().optional(), reveal: queryBool() }) },
    async (req, _r, { params, query }) => {
      const a = await environmentAccess(req, params.id, "env:read");
      if (query.serviceId) {
        const [s] = await getDb().select().from(services).where(and(eq(services.id, query.serviceId), eq(services.projectId, a.project.id)));
        if (!s) throw notFound("Service");
      }
      const reveal = query.reveal && a.permissions.has("env:read_secret");
      return { variables: await listVariables(params.id, query.serviceId ?? null, reveal), canRevealSecrets: a.permissions.has("env:read_secret") };
    },
  );

  route(app, { method: "PUT", url: "/environments/:id/variables", tags: ["variables"], params: idParam, body: bulkVariablesSchema.omit({ environmentId: true }) }, async (req, _r, { params, body }) => {
    const a = await environmentAccess(req, params.id, "env:write");
    if (body.serviceId) {
      const [s] = await getDb().select().from(services).where(and(eq(services.id, body.serviceId), eq(services.projectId, a.project.id)));
      if (!s) throw notFound("Service");
    }
    const keys = body.variables.map((v) => v.key);
    if (new Set(keys).size !== keys.length) throw badRequest("Duplicate keys in the request");
    const res = await upsertVariables(a.project.id, params.id, body.serviceId, body.variables, body.replace, req.auth.user!.id);
    // Only keys are audited, never values.
    await audit(actorOf(req), a.team.id, "variables.update", { type: "environment", id: params.id }, { serviceId: body.serviceId, changed: res.changed, removed: res.removed });
    return { ...res, redeployRequired: res.changed.length + res.removed.length > 0 };
  });

  route(app, { method: "DELETE", url: "/variables/:id", tags: ["variables"], params: idParam }, async (req, _r, { params }) => {
    const db = getDb();
    const [v] = await db.select().from(variables).where(eq(variables.id, params.id));
    if (!v) throw notFound("Variable");
    const a = await environmentAccess(req, v.environmentId, "env:write");
    if (v.managedBy) throw badRequest("This variable is managed by SKYHOST (database connection). Disconnect the database instead.");
    await db.delete(variables).where(eq(variables.id, v.id));
    await audit(actorOf(req), a.team.id, "variables.delete", { type: "environment", id: v.environmentId }, { key: v.key, serviceId: v.serviceId });
    return { ok: true, redeployRequired: true };
  });

  route(
    app,
    { method: "GET", url: "/environments/:id/variables/export", tags: ["variables"], params: idParam, query: z.object({ serviceId: z.string().uuid().optional(), format: z.enum(["env", "json"]).default("env") }) },
    async (req, reply, { params, query }) => {
      const a = await environmentAccess(req, params.id, "env:read");
      const withSecrets = a.permissions.has("env:read_secret");
      const vars = await listVariables(params.id, query.serviceId ?? null, withSecrets);
      // Sealed variables can never be exported; masked secrets are exported empty.
      const pairs = vars.filter((v) => !v.isSealed).map((v) => ({ key: v.key, value: v.value ?? "" }));
      await audit(actorOf(req), a.team.id, "variables.export", { type: "environment", id: params.id }, { serviceId: query.serviceId, secrets: withSecrets });
      if (query.format === "json") return reply.header("Content-Type", "application/json").send(toEnvJson(pairs));
      return reply.header("Content-Type", "text/plain; charset=utf-8").header("Content-Disposition", 'attachment; filename=".env"').send(serializeDotenv(pairs));
    },
  );

  route(
    app,
    { method: "POST", url: "/environments/:id/variables/import", tags: ["variables"], params: idParam, body: z.object({ serviceId: z.string().uuid().nullable().default(null), format: z.enum(["env", "json"]), content: z.string().max(512 * 1024), secret: z.boolean().default(false) }) },
    async (req, _r, { params, body }) => {
      const a = await environmentAccess(req, params.id, "env:write");
      if (body.serviceId) {
        const [s] = await getDb().select().from(services).where(and(eq(services.id, body.serviceId), eq(services.projectId, a.project.id)));
        if (!s) throw notFound("Service");
      }
      const parsed = body.format === "env" ? parseDotenv(body.content) : parseEnvJson(body.content);
      const blocking = parsed.issues.filter((i) => !/Duplicate/.test(i.message));
      if (blocking.length) throw badRequest(blocking[0]!.message, parsed.issues);
      const res = await upsertVariables(a.project.id, params.id, body.serviceId, parsed.pairs.map((p) => ({ ...p, secret: body.secret })), false, req.auth.user!.id);
      await audit(actorOf(req), a.team.id, "variables.import", { type: "environment", id: params.id }, { count: parsed.pairs.length, serviceId: body.serviceId });
      return { ...res, warnings: parsed.issues, redeployRequired: res.changed.length > 0 };
    },
  );

  route(
    app,
    { method: "POST", url: "/environments/:id/variables/copy", tags: ["variables"], params: idParam, body: z.object({ toEnvironmentId: z.string().uuid(), includeSecrets: z.boolean().default(false) }) },
    async (req, _r, { params, body }) => {
      const from = await environmentAccess(req, params.id, body.includeSecrets ? "env:read_secret" : "env:read");
      const to = await environmentAccess(req, body.toEnvironmentId, "env:write");
      if (from.project.id !== to.project.id) throw badRequest("Variables can only be copied between environments of the same project");
      // Copying into a preview environment never brings production secrets along.
      const includeSecrets = body.includeSecrets && !(from.environment.type === "production" && to.environment.type === "preview");
      const copied = await copyVariables(params.id, body.toEnvironmentId, from.project.id, { includeSecrets });
      await audit(actorOf(req), from.team.id, "variables.copy", { type: "environment", id: body.toEnvironmentId }, { from: params.id, copied, includeSecrets });
      return { copied };
    },
  );

  /** Variables detected by the analyzer (.env.example, README, code) that are not defined yet. */
  route(app, { method: "GET", url: "/services/:id/variables/suggested", tags: ["variables"], params: idParam, query: z.object({ environmentId: z.string().uuid() }) }, async (req, _r, { params, query }) => {
    const a = await serviceAccess(req, params.id, "env:read");
    const detected = ((a.service.analysis?.environmentVariables as Array<{ key: string; defaultValue?: string; required: boolean; source: string }>) ?? []).filter((v) => ENV_KEY_RE.test(v.key));
    const existing = new Set([...(await listVariables(query.environmentId, params.id, false)), ...(await listVariables(query.environmentId, null, false))].map((v) => v.key));
    return { suggestions: detected.filter((v) => !existing.has(v.key)) };
  });

  /** Final environment as the container will see it (values of secrets masked). */
  route(app, { method: "GET", url: "/services/:id/variables/resolved", tags: ["variables"], params: idParam, query: z.object({ environmentId: z.string().uuid() }) }, async (req, _r, { params, query }) => {
    const a = await serviceAccess(req, params.id, "env:read");
    const e = await environmentAccess(req, query.environmentId, "env:read");
    if (e.project.id !== a.service.projectId) throw badRequest("Environment of another project");
    const r = await resolveServiceEnv(params.id, query.environmentId);
    const secrets = new Set(r.secrets);
    const reveal = a.permissions.has("env:read_secret");
    return {
      variables: Object.entries(r.env)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([key, value]) => ({ key, value: secrets.has(value) && !reveal ? null : secrets.has(value) && value ? "••••••••" : value, secret: secrets.has(value) })),
      missingReferences: r.missingReferences,
    };
  });

  // ---------------------------------------------------------------------------------- Shared variable groups
  route(app, { method: "GET", url: "/teams/:teamId/variable-groups", tags: ["variables"], params: z.object({ teamId: z.string().uuid() }) }, async (req, _r, { params }) => {
    const a = await teamAccess(req, params.teamId, "env:read");
    const db = getDb();
    const groups = await db.select().from(variableGroups).where(eq(variableGroups.teamId, params.teamId));
    const ids = groups.map((g) => g.id);
    const items = ids.length ? await db.select().from(variableGroupItems).where(inArray(variableGroupItems.groupId, ids)) : [];
    const links = ids.length ? await db.select().from(variableGroupLinks).where(inArray(variableGroupLinks.groupId, ids)) : [];
    const reveal = a.permissions.has("env:read_secret");
    return {
      groups: groups.map((g) => ({
        ...g,
        items: items.filter((i) => i.groupId === g.id).map((i) => ({ id: i.id, key: i.key, isSecret: i.isSecret, value: i.isSecret && !reveal ? null : decrypt(i.valueEnc, undefined, groupItemAad(g.id, i.key)) })),
        links: links.filter((l) => l.groupId === g.id),
      })),
    };
  });

  route(app, { method: "POST", url: "/teams/:teamId/variable-groups", tags: ["variables"], params: z.object({ teamId: z.string().uuid() }), body: z.object({ name: nameSchema, description: z.string().max(300).optional(), parentId: z.string().uuid().optional() }) }, async (req, reply, { params, body }) => {
    await teamAccess(req, params.teamId, "env:write");
    const db = getDb();
    if (body.parentId) {
      const [p] = await db.select().from(variableGroups).where(and(eq(variableGroups.id, body.parentId), eq(variableGroups.teamId, params.teamId)));
      if (!p) throw badRequest("Unknown parent group");
    }
    const [g] = await db.insert(variableGroups).values({ teamId: params.teamId, name: body.name, description: body.description, parentId: body.parentId ?? null }).returning();
    await audit(actorOf(req), params.teamId, "variable_group.create", { type: "variable_group", id: g!.id }, { name: body.name });
    reply.code(201);
    return { group: g };
  });

  async function groupAccess(req: Parameters<typeof teamAccess>[0], id: string, perm: "env:read" | "env:write") {
    const [g] = await getDb().select().from(variableGroups).where(eq(variableGroups.id, id));
    if (!g) throw notFound("Variable group");
    await teamAccess(req, g.teamId, perm);
    return g;
  }

  route(
    app,
    { method: "PUT", url: "/variable-groups/:id/items", tags: ["variables"], params: idParam, body: z.object({ items: z.array(z.object({ key: z.string().regex(ENV_KEY_RE), value: z.string().max(32 * 1024), secret: z.boolean().default(false) })).max(300) }) },
    async (req, _r, { params, body }) => {
      const g = await groupAccess(req, params.id, "env:write");
      const db = getDb();
      const existing = await db.select().from(variableGroupItems).where(eq(variableGroupItems.groupId, g.id));
      const keep = new Set(body.items.map((i) => i.key));
      const del = existing.filter((e) => !keep.has(e.key));
      if (del.length) await db.delete(variableGroupItems).where(inArray(variableGroupItems.id, del.map((d) => d.id)));
      for (const it of body.items) {
        const prev = existing.find((e) => e.key === it.key);
        // A secret left empty by the editor keeps its stored value.
        if (prev?.isSecret && it.value === "") continue;
        const valueEnc = encrypt(it.value, undefined, groupItemAad(g.id, it.key));
        await db.insert(variableGroupItems).values({ groupId: g.id, key: it.key, valueEnc, isSecret: it.secret }).onConflictDoUpdate({ target: [variableGroupItems.groupId, variableGroupItems.key], set: { valueEnc, isSecret: it.secret } });
      }
      await audit(actorOf(req), g.teamId, "variable_group.update", { type: "variable_group", id: g.id }, { keys: [...keep], removed: del.map((d) => d.key) });
      return { ok: true };
    },
  );

  route(
    app,
    { method: "POST", url: "/variable-groups/:id/links", tags: ["variables"], params: idParam, body: z.object({ projectId: z.string().uuid().optional(), serviceId: z.string().uuid().optional(), environmentType: z.enum(ENVIRONMENT_TYPES).optional() }) },
    async (req, reply, { params, body }) => {
      const g = await groupAccess(req, params.id, "env:write");
      if (!body.projectId && !body.serviceId) throw badRequest("Link the group to a project or a service");
      const db = getDb();
      if (body.serviceId) {
        const a = await serviceAccess(req, body.serviceId, "env:write");
        if (a.team.id !== g.teamId) throw notFound("Service");
      }
      if (body.projectId) {
        const { projectAccess } = await import("../lib/authz");
        const a = await projectAccess(req, body.projectId, "env:write");
        if (a.team.id !== g.teamId) throw notFound("Project");
      }
      const [l] = await db.insert(variableGroupLinks).values({ groupId: g.id, projectId: body.projectId ?? null, serviceId: body.serviceId ?? null, environmentType: body.environmentType ?? null }).returning();
      await audit(actorOf(req), g.teamId, "variable_group.link", { type: "variable_group", id: g.id }, body);
      reply.code(201);
      return { link: l };
    },
  );

  route(app, { method: "DELETE", url: "/variable-groups/:id/links/:linkId", tags: ["variables"], params: idParam.extend({ linkId: z.string().uuid() }) }, async (req, _r, { params }) => {
    const g = await groupAccess(req, params.id, "env:write");
    await getDb().delete(variableGroupLinks).where(and(eq(variableGroupLinks.id, params.linkId), eq(variableGroupLinks.groupId, g.id)));
    return { ok: true };
  });

  route(app, { method: "DELETE", url: "/variable-groups/:id", tags: ["variables"], params: idParam }, async (req, _r, { params }) => {
    const g = await groupAccess(req, params.id, "env:write");
    const db = getDb();
    const children = await db.select().from(variableGroups).where(eq(variableGroups.parentId, g.id));
    if (children.length) throw badRequest("Other groups inherit from this group");
    await db.delete(variableGroups).where(eq(variableGroups.id, g.id));
    await audit(actorOf(req), g.teamId, "variable_group.delete", { type: "variable_group", id: g.id });
    return { ok: true };
  });

  void environments;
  void isNull;
}
