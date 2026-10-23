import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  databaseConnections, databases, environments, getDb, services, variableGroupItems, variableGroupLinks, variableGroups, variables,
} from "@skyhost/db";
import { resolveReferences, type DatabaseEngine } from "@skyhost/shared";
import { decrypt, encrypt } from "@skyhost/shared/node";
import { databaseVariables, DB_PORTS } from "@skyhost/engine";
import { internalHost, publicUrl, serviceHostname } from "./hostnames";

/** Variables are encrypted with their scope as additional authenticated data, so ciphertexts cannot be moved. */
const aad = (environmentId: string, serviceId: string | null, key: string) => `${environmentId}:${serviceId ?? "*"}:${key}`;

export function encryptVariable(environmentId: string, serviceId: string | null, key: string, value: string) {
  return encrypt(value, undefined, aad(environmentId, serviceId, key));
}

export function decryptVariable(row: { environmentId: string; serviceId: string | null; key: string; valueEnc: string }) {
  return decrypt(row.valueEnc, undefined, aad(row.environmentId, row.serviceId, row.key));
}

export interface ResolvedEnv {
  env: Record<string, string>;
  /** Values that must be redacted from logs. */
  secrets: string[];
  missingReferences: string[];
}

async function groupVariables(projectId: string, serviceId: string, envType: string): Promise<{ vars: Record<string, string>; secrets: string[] }> {
  const db = getDb();
  const links = await db
    .select()
    .from(variableGroupLinks)
    .where(and(or(eq(variableGroupLinks.projectId, projectId), eq(variableGroupLinks.serviceId, serviceId)), or(isNull(variableGroupLinks.environmentType), eq(variableGroupLinks.environmentType, envType))));
  const vars: Record<string, string> = {};
  const secrets: string[] = [];
  // Project-level links apply first, then service-level links override them.
  const ordered = [...links.filter((l) => !l.serviceId), ...links.filter((l) => l.serviceId)];
  for (const link of ordered) {
    // Resolve the inheritance chain: root parent first, child overrides.
    const chain: string[] = [];
    let current: string | null = link.groupId;
    for (let i = 0; current && i < 10 && !chain.includes(current); i++) {
      chain.unshift(current);
      const [g]: Array<{ parentId: string | null }> = await db.select({ parentId: variableGroups.parentId }).from(variableGroups).where(eq(variableGroups.id, current));
      current = g?.parentId ?? null;
    }
    for (const gid of chain) {
      for (const item of await db.select().from(variableGroupItems).where(eq(variableGroupItems.groupId, gid))) {
        const value = decrypt(item.valueEnc, undefined, `group:${gid}:${item.key}`);
        vars[item.key] = value;
        if (item.isSecret) secrets.push(value);
      }
    }
  }
  return { vars, secrets };
}

/** Raw (unresolved) variables of a service: shared environment variables overridden by service variables. */
async function ownVariables(environmentId: string, serviceId: string): Promise<{ vars: Record<string, string>; secrets: string[] }> {
  const rows = await getDb()
    .select()
    .from(variables)
    .where(and(eq(variables.environmentId, environmentId), or(isNull(variables.serviceId), eq(variables.serviceId, serviceId))));
  const vars: Record<string, string> = {};
  const secrets: string[] = [];
  for (const r of rows.sort((a, b) => (a.serviceId ? 1 : 0) - (b.serviceId ? 1 : 0))) {
    const v = decryptVariable(r);
    vars[r.key] = v;
    if (r.isSecret || r.isSealed) secrets.push(v);
  }
  return { vars, secrets };
}

export function decryptDbPassword(enc: string, databaseId: string) {
  return decrypt(enc, undefined, `database:${databaseId}`);
}

export function encryptDbPassword(password: string, databaseId: string) {
  return encrypt(password, undefined, `database:${databaseId}`);
}

/**
 * Computes the final environment of a service in an environment, in increasing precedence:
 * variable groups < shared variables < service variables < platform variables (PORT, SKYHOST_*).
 * ${{service.KEY}} / ${{database.KEY}} references are then resolved against sibling services and databases.
 */
export async function resolveServiceEnv(serviceId: string, environmentId: string, opts: { port?: number | null; deploymentId?: string; commitSha?: string | null } = {}): Promise<ResolvedEnv> {
  const db = getDb();
  const [svc] = await db.select().from(services).where(eq(services.id, serviceId));
  const [env] = await db.select().from(environments).where(eq(environments.id, environmentId));
  if (!svc || !env) throw new Error("Service or environment not found");

  const groups = await groupVariables(svc.projectId, svc.id, env.type);
  const own = await ownVariables(environmentId, serviceId);
  const merged: Record<string, string> = { ...groups.vars, ...own.vars };
  const secrets = [...groups.secrets, ...own.secrets];

  const port = opts.port ?? svc.config.port ?? null;
  const host = serviceHostname(svc, env);
  const platform: Record<string, string> = {
    SKYHOST: "true",
    SKYHOST_SERVICE: svc.slug,
    SKYHOST_SERVICE_ID: svc.id,
    SKYHOST_PROJECT_ID: svc.projectId,
    SKYHOST_ENVIRONMENT: env.name,
    SKYHOST_PUBLIC_DOMAIN: host,
    SKYHOST_PUBLIC_URL: publicUrl(host),
    SKYHOST_PRIVATE_DOMAIN: `${internalHost(svc.slug, env)}.internal`,
    ...(opts.deploymentId ? { SKYHOST_DEPLOYMENT_ID: opts.deploymentId } : {}),
    ...(opts.commitSha ? { SKYHOST_GIT_COMMIT_SHA: opts.commitSha } : {}),
  };
  if (port && svc.type !== "worker" && svc.type !== "cron" && svc.type !== "job") platform.PORT = String(port);

  // Reference targets: sibling services (raw own vars + platform info) and project databases.
  const siblings = await db.select().from(services).where(and(eq(services.projectId, svc.projectId), isNull(services.deletedAt)));
  const dbs = await db.select().from(databases).where(and(eq(databases.projectId, svc.projectId), isNull(databases.deletedAt), or(isNull(databases.environmentId), eq(databases.environmentId, environmentId))));
  const cache = new Map<string, Record<string, string>>();
  const lookup = (name: string): Record<string, string> | undefined => {
    if (cache.has(name)) return cache.get(name);
    return undefined;
  };
  for (const d of dbs) {
    const password = decryptDbPassword(d.passwordEnc, d.id);
    secrets.push(password);
    cache.set(d.name, databaseVariables(d.engine as DatabaseEngine, { host: d.internalHost, port: DB_PORTS[d.engine as DatabaseEngine] ?? d.port, username: d.username, password, dbName: d.dbName }));
  }
  for (const s of siblings) {
    if (cache.has(s.slug)) continue;
    const sv = s.id === svc.id ? { vars: merged, secrets: [] } : await ownVariables(environmentId, s.id);
    const sHost = serviceHostname(s, env);
    const iHost = `${internalHost(s.slug, env)}.internal`;
    cache.set(s.slug, {
      ...sv.vars,
      ...(s.config.port ? { PORT: String(s.config.port) } : {}),
      SKYHOST_PUBLIC_DOMAIN: sHost,
      SKYHOST_PUBLIC_URL: publicUrl(sHost),
      SKYHOST_PRIVATE_DOMAIN: iHost,
      SKYHOST_PRIVATE_URL: `http://${iHost}${s.config.port ? `:${s.config.port}` : ""}`,
    });
  }
  // Database connections inject their URL under the configured variable name unless the user overrode it.
  const conns = await db.select().from(databaseConnections).where(eq(databaseConnections.serviceId, svc.id));
  for (const c of conns) {
    const d = dbs.find((x) => x.id === c.databaseId);
    if (!d) continue;
    const vars = cache.get(d.name)!;
    const main = d.engine === "mongodb" ? "MONGODB_URI" : d.engine === "redis" ? "REDIS_URL" : "DATABASE_URL";
    if (!(c.variableName in merged)) merged[c.variableName] = vars[main]!;
  }

  const { resolved, missing } = resolveReferences({ ...merged, ...platform }, lookup);
  return { env: resolved, secrets: secrets.filter(Boolean), missingReferences: missing };
}

export interface VariableView {
  id: string;
  key: string;
  value: string | null;
  isSecret: boolean;
  isSealed: boolean;
  serviceId: string | null;
  managedBy: string | null;
  updatedAt: Date;
}

/** Lists variables. Secrets are masked unless `revealSecrets`; sealed variables are never returned. */
export async function listVariables(environmentId: string, serviceId: string | null, revealSecrets: boolean): Promise<VariableView[]> {
  const rows = await getDb()
    .select()
    .from(variables)
    .where(and(eq(variables.environmentId, environmentId), serviceId ? eq(variables.serviceId, serviceId) : isNull(variables.serviceId)))
    .orderBy(variables.key);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: r.isSealed ? null : r.isSecret && !revealSecrets ? null : decryptVariable(r),
    isSecret: r.isSecret,
    isSealed: r.isSealed,
    serviceId: r.serviceId,
    managedBy: r.managedBy,
    updatedAt: r.updatedAt,
  }));
}

export interface VariableInput {
  key: string;
  value: string;
  secret?: boolean;
  sealed?: boolean;
}

/**
 * Upserts variables of a scope. With `replace`, keys absent from the input are deleted (the editor sends the
 * whole set). Sealed variables keep their stored value when the input value is empty (they cannot be read back).
 */
export async function upsertVariables(projectId: string, environmentId: string, serviceId: string | null, input: VariableInput[], replace: boolean, userId: string | null) {
  const db = getDb();
  const existing = await db
    .select()
    .from(variables)
    .where(and(eq(variables.environmentId, environmentId), serviceId ? eq(variables.serviceId, serviceId) : isNull(variables.serviceId)));
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const seen = new Set<string>();
  const changed: string[] = [];
  for (const v of input) {
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    const prev = byKey.get(v.key);
    if (prev?.isSealed && v.value === "") continue; // keep sealed value
    const valueEnc = encryptVariable(environmentId, serviceId, v.key, v.value);
    if (prev) {
      if (!prev.isSealed && decryptVariable(prev) === v.value && prev.isSecret === !!v.secret && prev.isSealed === !!v.sealed) continue;
      await db
        .update(variables)
        .set({ valueEnc, isSecret: !!v.secret || !!v.sealed || prev.isSealed, isSealed: !!v.sealed || prev.isSealed, updatedAt: new Date(), updatedBy: userId })
        .where(eq(variables.id, prev.id));
    } else {
      await db.insert(variables).values({ projectId, environmentId, serviceId, key: v.key, valueEnc, isSecret: !!v.secret || !!v.sealed, isSealed: !!v.sealed, updatedBy: userId });
    }
    changed.push(v.key);
  }
  const removed: string[] = [];
  if (replace) {
    const toDelete = existing.filter((e) => !seen.has(e.key) && !e.managedBy);
    if (toDelete.length) {
      await db.delete(variables).where(inArray(variables.id, toDelete.map((d) => d.id)));
      removed.push(...toDelete.map((d) => d.key));
    }
  }
  return { changed, removed };
}

export async function copyVariables(fromEnvironmentId: string, toEnvironmentId: string, projectId: string, opts: { includeSecrets: boolean }) {
  const db = getDb();
  const rows = await db.select().from(variables).where(eq(variables.environmentId, fromEnvironmentId));
  let copied = 0;
  for (const r of rows) {
    if ((r.isSecret || r.isSealed) && !opts.includeSecrets) continue;
    const value = decryptVariable(r);
    await db
      .insert(variables)
      .values({ projectId, environmentId: toEnvironmentId, serviceId: r.serviceId, key: r.key, valueEnc: encryptVariable(toEnvironmentId, r.serviceId, r.key, value), isSecret: r.isSecret, isSealed: r.isSealed })
      .onConflictDoNothing();
    copied++;
  }
  return copied;
}

export function groupItemAad(groupId: string, key: string) {
  return `group:${groupId}:${key}`;
}

