import { and, eq, isNull } from "drizzle-orm";
import {
  databaseConnections, databases, environments, getDb, gitInstallations, projects, serviceInstances, services, uploads, volumes,
} from "@skyhost/db";
import { DATABASE_VERSIONS, serviceConfigSchema, slugify, DATABASE_ENV_VAR, type DatabaseEngine, type ServiceConfig, type ServiceType } from "@skyhost/shared";
import { randomId, randomPassword } from "@skyhost/shared/node";
import { names } from "@skyhost/engine";
import { assertFeature, assertQuota, badRequest, conflict, encryptDbPassword, enqueue, notFound, providerClient, serverConfig } from "@skyhost/core";

export async function uniqueSubdomain(): Promise<string> {
  for (;;) {
    const s = randomId(6);
    const [x] = await getDb().select({ id: services.id }).from(services).where(eq(services.subdomain, s));
    if (!x) return s;
  }
}

export async function uniqueServiceSlug(projectId: string, name: string): Promise<string> {
  const base = slugify(name, 30);
  const taken = new Set(
    (await getDb().select({ slug: services.slug }).from(services).where(and(eq(services.projectId, projectId), isNull(services.deletedAt)))).map((s) => s.slug),
  );
  const dbNames = new Set((await getDb().select({ name: databases.name }).from(databases).where(and(eq(databases.projectId, projectId), isNull(databases.deletedAt)))).map((d) => d.name));
  let slug = base;
  for (let i = 2; taken.has(slug) || dbNames.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export async function productionEnvironment(projectId: string) {
  const [env] = await getDb().select().from(environments).where(and(eq(environments.projectId, projectId), eq(environments.type, "production"), isNull(environments.deletedAt)));
  if (!env) throw notFound("Production environment");
  return env;
}

export interface NewServiceInput {
  projectId: string;
  teamId: string;
  name: string;
  type: ServiceType;
  source: Record<string, unknown> & { kind: string };
  config: Partial<ServiceConfig>;
  analysis?: Record<string, unknown> | null;
  createdBy: string | null;
  volumes?: Array<{ name: string; mountPath: string; sizeMb: number }>;
}

/** Validates the source belongs to the team (git installation, upload) before creating a service. */
export async function validateSource(teamId: string, source: NewServiceInput["source"]) {
  const db = getDb();
  if (source.kind === "github" || source.kind === "gitlab" || source.kind === "bitbucket") {
    const instId = source.installationId as string | undefined;
    const [inst] = await db
      .select()
      .from(gitInstallations)
      .where(and(eq(gitInstallations.teamId, teamId), eq(gitInstallations.provider, source.kind), instId ? eq(gitInstallations.id, instId) : undefined));
    if (!inst) throw badRequest(`Connect your ${source.kind} account to this team first`);
    // Verify the repository is accessible through this installation (and fetch its default branch).
    const repo = await providerClient(inst).getRepo(String(source.repo));
    return { ...source, installationId: inst.id, branch: (source.branch as string | undefined) || repo.defaultBranch };
  }
  if (source.kind === "zip") {
    const [u] = await db.select().from(uploads).where(and(eq(uploads.id, String(source.uploadId)), eq(uploads.teamId, teamId)));
    if (!u) throw badRequest("Unknown upload");
  }
  if (source.kind === "git") {
    const url = String(source.url);
    if (!url.startsWith("https://") && !(serverConfig().isTest && process.env.SKYHOST_ALLOW_LOCAL_GIT === "1")) throw badRequest("Only https:// Git URLs are supported");
  }
  return source;
}

export async function createService(input: NewServiceInput) {
  const db = getDb();
  await assertQuota(input.teamId, "services");
  if (input.type === "cron") await assertQuota(input.teamId, "cronJobs");
  const config = serviceConfigSchema.parse(input.config);
  if (input.type === "cron" && !config.cron) throw badRequest("Cron jobs need a schedule");
  if (config.resources.cpu || config.resources.memoryMb) {
    await assertQuota(input.teamId, "cpu", config.resources.cpu * config.resources.replicas);
    await assertQuota(input.teamId, "memoryMb", config.resources.memoryMb * config.resources.replicas);
  }
  if (config.protection.mode !== "none") await assertFeature(input.teamId, "accessProtection");
  if (config.waf.enabled) await assertFeature(input.teamId, "waf");
  const [svc] = await db
    .insert(services)
    .values({
      projectId: input.projectId,
      name: input.name,
      slug: await uniqueServiceSlug(input.projectId, input.name),
      type: input.type,
      source: input.source,
      config,
      analysis: input.analysis ?? null,
      subdomain: await uniqueSubdomain(),
      createdBy: input.createdBy,
    })
    .returning();
  const envs = await db.select().from(environments).where(and(eq(environments.projectId, input.projectId), isNull(environments.deletedAt), eq(environments.isEphemeral, false)));
  for (const env of envs) {
    await db.insert(serviceInstances).values({ serviceId: svc!.id, environmentId: env.id }).onConflictDoNothing();
    for (const v of input.volumes ?? []) {
      await assertQuota(input.teamId, "volumesMb", v.sizeMb);
      const [vol] = await db.insert(volumes).values({ serviceId: svc!.id, environmentId: env.id, name: v.name, mountPath: v.mountPath, sizeMb: v.sizeMb, dockerVolume: `pending-${randomId(10)}` }).returning();
      await db.update(volumes).set({ dockerVolume: names.volume(vol!.id) }).where(eq(volumes.id, vol!.id));
    }
  }
  return svc!;
}

export interface NewDatabaseInput {
  teamId: string;
  projectId: string;
  environmentId?: string | null;
  name: string;
  engine: DatabaseEngine;
  version?: string;
  regionId?: string;
  storageMb?: number;
}

export async function createDatabase(input: NewDatabaseInput) {
  const db = getDb();
  await assertQuota(input.teamId, "databases");
  await assertQuota(input.teamId, "storageMb", input.storageMb ?? 1024);
  const slug = slugify(input.name, 40);
  const [dupSvc] = await db.select({ id: services.id }).from(services).where(and(eq(services.projectId, input.projectId), eq(services.slug, slug), isNull(services.deletedAt)));
  const [dupDb] = await db.select({ id: databases.id }).from(databases).where(and(eq(databases.projectId, input.projectId), eq(databases.name, slug), isNull(databases.deletedAt)));
  if (dupSvc || dupDb) throw conflict(`A service or database named "${slug}" already exists in this project`);
  const version = input.version ?? DATABASE_VERSIONS[input.engine][0]!;
  if (!DATABASE_VERSIONS[input.engine].includes(version)) throw badRequest(`Unsupported ${input.engine} version ${version}`);
  const password = randomPassword(32);
  const username = input.engine === "redis" ? "default" : `u_${randomId(8, "abcdefghijklmnopqrstuvwxyz")}`;
  const dbName = input.engine === "redis" ? "0" : slug.replace(/-/g, "_").replace(/^(\d)/, "db_$1");
  const [row] = await db
    .insert(databases)
    .values({
      teamId: input.teamId,
      projectId: input.projectId,
      environmentId: input.environmentId ?? null,
      name: slug,
      engine: input.engine,
      version,
      regionId: input.regionId ?? serverConfig().SKYHOST_REGION,
      containerName: "pending",
      dockerVolume: "pending",
      internalHost: slug,
      port: { postgres: 5432, mariadb: 3306, mongodb: 27017, redis: 6379 }[input.engine],
      dbName,
      username,
      passwordEnc: "pending",
      storageMb: input.storageMb ?? 1024,
    })
    .returning();
  await db
    .update(databases)
    .set({ containerName: names.dbContainer(row!.id), dockerVolume: names.dbVolume(row!.id), passwordEnc: encryptDbPassword(password, row!.id) })
    .where(eq(databases.id, row!.id));
  await enqueue("database", { action: "provision", databaseId: row!.id }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
  return { ...row!, containerName: names.dbContainer(row!.id) };
}

export async function connectDatabase(databaseId: string, serviceId: string, variableName?: string) {
  const db = getDb();
  const [d] = await db.select().from(databases).where(eq(databases.id, databaseId));
  if (!d) throw notFound("Database");
  const [svc] = await db.select().from(services).where(eq(services.id, serviceId));
  if (!svc || svc.projectId !== d.projectId) throw badRequest("Databases can only be connected to services of the same project");
  const name = variableName ?? DATABASE_ENV_VAR[d.engine as DatabaseEngine];
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw badRequest("Invalid variable name");
  await db
    .insert(databaseConnections)
    .values({ databaseId, serviceId, variableName: name })
    .onConflictDoUpdate({ target: [databaseConnections.databaseId, databaseConnections.serviceId], set: { variableName: name } });
  return { variableName: name };
}

export async function ensureProjectEnvironments(projectId: string) {
  const db = getDb();
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw notFound("Project");
  const existing = await db.select().from(environments).where(and(eq(environments.projectId, projectId), isNull(environments.deletedAt)));
  if (!existing.some((e) => e.type === "production")) {
    await db.insert(environments).values({ projectId, name: "production", type: "production" });
  }
}
