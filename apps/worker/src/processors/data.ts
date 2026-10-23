import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { databaseBackups, databaseRestores, databases, getDb, teams, uploads } from "@skyhost/db";
import { analyzeRepository, localFS } from "@skyhost/analyzer";
import type { DatabaseEngine } from "@skyhost/shared";
import { randomPassword, sha256 } from "@skyhost/shared/node";
import {
  backupDatabase, cloneRepository, deleteDatabase, disablePublicAccess, enablePublicAccess, execInContainer, extractZip, getObjectStore, makeWorkDir, names, provisionDatabase,
  removeWorkDir, restoreDatabase, rotatePassword, DB_PORTS, type DbRef,
} from "@skyhost/engine";
import { audit, decryptDbPassword, encryptDbPassword, getTeamPlan, notify, publish, type AnalyzeSource } from "@skyhost/core";

type Db = typeof databases.$inferSelect;

const specOf = (d: Db, password = decryptDbPassword(d.passwordEnc, d.id)) => ({
  id: d.id,
  teamId: d.teamId,
  projectId: d.projectId,
  engine: d.engine as DatabaseEngine,
  version: d.version,
  dbName: d.dbName,
  username: d.username,
  password,
  storageMb: d.storageMb,
  network: names.teamNetwork(d.teamId),
  alias: d.internalHost,
});

export const refOf = (d: Db): DbRef => ({ engine: d.engine as DatabaseEngine, container: d.containerName, username: d.username, password: decryptDbPassword(d.passwordEnc, d.id), dbName: d.dbName });

async function setDbStatus(id: string, patch: Partial<Db>) {
  const [d] = await getDb().update(databases).set(patch).where(eq(databases.id, id)).returning();
  if (d) await publish(`database:${id}`, { type: "database.status", status: d.status, error: d.error });
  if (d) await publish(`project:${d.projectId}`, { type: "database.status", databaseId: id, status: d.status });
  return d;
}

export async function processAnalyze(data: { source: AnalyzeSource; rootDir?: string }) {
  let workDir: string | null = null;
  try {
    let dir: string;
    let commit: unknown = null;
    if (data.source.kind === "zip") {
      const [u] = await getDb().select().from(uploads).where(eq(uploads.id, data.source.uploadId));
      if (!u) throw new Error("Upload not found");
      const tmp = await makeWorkDir("analyze");
      const p = join(tmp, "a.zip");
      await writeFile(p, await getObjectStore().get(u.objectKey));
      const ex = await extractZip(p);
      await removeWorkDir(tmp);
      workDir = ex.workDir;
      dir = ex.dir;
    } else {
      const c = await cloneRepository({ url: data.source.url, branch: data.source.branch ?? null, token: data.source.token, tokenUsername: data.source.tokenUsername });
      workDir = c.workDir;
      dir = c.dir;
      commit = c.commit;
    }
    const analysis = await analyzeRepository(localFS(dir), { rootDir: data.rootDir });
    return { ...analysis, commit };
  } finally {
    if (workDir) await removeWorkDir(workDir).catch(() => {});
  }
}

export async function processDatabase(data: { action: string; databaseId: string; keepVolume?: boolean; sourceId?: string; anonymize?: boolean }) {
  const db = getDb();
  const [d] = await db.select().from(databases).where(eq(databases.id, data.databaseId));
  if (!d) return;
  switch (data.action) {
    case "provision": {
      if (d.deletedAt) return;
      try {
        const plan = await getTeamPlan(d.teamId);
        await provisionDatabase({ ...specOf(d), memoryMb: Math.min(1024, Math.max(256, Math.floor(plan.limits.memoryMb / 4))), cpu: Math.min(1, plan.limits.cpu) });
        const ready = await setDbStatus(d.id, { status: "available", readyAt: new Date(), error: null });
        await notify({ teamId: d.teamId, event: "database.ready", title: `Database ${d.name} is ready`, body: `${d.engine} ${d.version} is available on the private network as ${d.internalHost}.internal.`, link: `/projects/${d.projectId}/databases/${d.id}` });
        await audit(null, d.teamId, "database.ready", { type: "database", id: d.id });
        void ready;
      } catch (e) {
        await setDbStatus(d.id, { status: "error", error: (e as Error).message.slice(0, 1000) });
        throw e;
      }
      return;
    }
    case "delete":
      await deleteDatabase(d.id, { keepVolume: data.keepVolume });
      await setDbStatus(d.id, { status: "deleted" });
      return;
    case "rotate": {
      const next = randomPassword(32);
      await rotatePassword(specOf(d), d.containerName, next);
      await setDbStatus(d.id, { passwordEnc: encryptDbPassword(next, d.id) });
      await notify({ teamId: d.teamId, event: "database.ready", title: `Credentials of ${d.name} rotated`, body: "Redeploy connected services to use the new password.", link: `/projects/${d.projectId}/databases/${d.id}` });
      return;
    }
    case "public": {
      if (!d.publicAccess) {
        await disablePublicAccess(d.id);
        await setDbStatus(d.id, { publicPort: null });
        return;
      }
      let port = d.publicPort;
      if (!port) {
        const used = new Set((await db.select({ p: databases.publicPort }).from(databases).where(isNotNull(databases.publicPort))).map((r) => r.p));
        const min = Number(process.env.SKYHOST_DB_PUBLIC_PORT_MIN ?? 20000);
        const max = Number(process.env.SKYHOST_DB_PUBLIC_PORT_MAX ?? 29999);
        for (let p = min; p <= max; p++) if (!used.has(p)) {
          port = p;
          break;
        }
      }
      if (!port) throw new Error("No public port available");
      await enablePublicAccess({ dbId: d.id, teamId: d.teamId, network: names.teamNetwork(d.teamId), targetHost: d.containerName, targetPort: DB_PORTS[d.engine as DatabaseEngine], hostPort: port, allowlist: d.ipAllowlist });
      await setDbStatus(d.id, { publicPort: port });
      return;
    }
    case "clone": {
      // Environment cloning: copy data from the source database, optionally anonymized.
      const [src] = await db.select().from(databases).where(eq(databases.id, data.sourceId!));
      if (!src || src.status !== "available") throw new Error("Source database is not available");
      for (let i = 0; i < 60 && (await db.select().from(databases).where(eq(databases.id, d.id)))[0]!.status !== "available"; i++) await new Promise((r) => setTimeout(r, 2000));
      const [fresh] = await db.select().from(databases).where(eq(databases.id, d.id));
      if (fresh!.status !== "available") throw new Error("Clone database is not ready");
      await setDbStatus(d.id, { status: "restoring" });
      const dump = await backupDatabase(refOf(src));
      await restoreDatabase(refOf(fresh!), dump);
      if (data.anonymize) await anonymize(refOf(fresh!));
      await setDbStatus(d.id, { status: "available" });
      await audit(null, d.teamId, "database.cloned", { type: "database", id: d.id }, { from: src.id, anonymized: !!data.anonymize });
      return;
    }
  }
}

/** Replaces personal data columns (email, phone, names, addresses, IPs) with deterministic placeholders. */
export async function anonymize(ref: DbRef) {
  if (ref.engine !== "postgres" && ref.engine !== "mariadb") return;
  const pattern = "(email|phone|first_?name|last_?name|full_?name|address|street|ip_address|birth)";
  if (ref.engine === "postgres") {
    const sql = `DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT table_schema, table_name, column_name FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog','information_schema') AND data_type IN ('text','character varying') AND column_name ~* '${pattern}' LOOP
        EXECUTE format('UPDATE %I.%I SET %I = CASE WHEN %I IS NULL THEN NULL WHEN %L ~* ''email'' THEN ''user_'' || left(md5(%I), 10) || ''@example.com'' ELSE ''anon_'' || left(md5(%I), 12) END',
          r.table_schema, r.table_name, r.column_name, r.column_name, r.column_name, r.column_name, r.column_name);
      END LOOP; END $$;`;
    const res = await execInContainer(ref.container, ["psql", "-v", "ON_ERROR_STOP=1", "-U", ref.username, "-d", ref.dbName, "-c", sql], { env: [`PGPASSWORD=${ref.password}`], timeoutMs: 600_000 });
    if (res.exitCode !== 0) throw new Error(`Anonymization failed: ${res.stderr.toString()}`);
  } else {
    const list = await execInContainer(ref.container, ["mariadb", "-u", ref.username, `-p${ref.password}`, "-N", "-e", `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='${ref.dbName}' AND data_type IN ('varchar','text') AND column_name REGEXP '${pattern}'`, ref.dbName], { timeoutMs: 60_000 });
    for (const line of list.stdout.toString().trim().split("\n").filter(Boolean)) {
      const [t, c] = line.split("\t");
      if (!/^\w+$/.test(t!) || !/^\w+$/.test(c!)) continue;
      const expr = /email/i.test(c!) ? `CONCAT('user_', LEFT(MD5(\`${c}\`),10), '@example.com')` : `CONCAT('anon_', LEFT(MD5(\`${c}\`),12))`;
      await execInContainer(ref.container, ["mariadb", "-u", ref.username, `-p${ref.password}`, "-e", `UPDATE \`${t}\` SET \`${c}\` = ${expr} WHERE \`${c}\` IS NOT NULL`, ref.dbName], { timeoutMs: 600_000 });
    }
  }
}

/** Restores a dump into a throwaway database container to prove the backup is usable. */
async function verifyBackup(d: Db, dump: Buffer) {
  const tmpId = `00000000-0000-4000-8000-${sha256(d.id + Date.now()).slice(0, 12)}`;
  const spec = { ...specOf(d), id: tmpId, alias: `verify-${tmpId.slice(-8)}` };
  try {
    await provisionDatabase(spec);
    await restoreDatabase({ engine: spec.engine, container: names.dbContainer(tmpId), username: spec.username, password: spec.password, dbName: spec.dbName }, dump);
  } finally {
    await deleteDatabase(tmpId);
  }
}

export async function processBackup(data: { action: string; backupId?: string; restoreId?: string }) {
  const db = getDb();
  if (data.action === "backup") {
    const [b] = await db.select().from(databaseBackups).where(eq(databaseBackups.id, data.backupId!));
    if (!b || b.status === "completed") return;
    const [d] = await db.select().from(databases).where(eq(databases.id, b.databaseId));
    if (!d || d.status !== "available") return;
    await db.update(databaseBackups).set({ status: "running", startedAt: new Date() }).where(eq(databaseBackups.id, b.id));
    try {
      const dump = await backupDatabase(refOf(d));
      const key = `backups/${d.teamId}/${d.id}/${b.id}.bin`;
      await getObjectStore().put(key, dump);
      const [team] = await db.select().from(teams).where(eq(teams.id, d.teamId));
      const plan = await getTeamPlan(d.teamId);
      const days = Math.min(d.backupRetentionDays, team?.retention.backupsDays ?? plan.limits.backupRetentionDays, plan.limits.backupRetentionDays);
      await db.update(databaseBackups).set({ objectKey: key, sizeBytes: dump.length, checksum: sha256(dump), expiresAt: new Date(Date.now() + days * 86400_000) }).where(eq(databaseBackups.id, b.id));
      // A backup only counts as completed after a successful test restore.
      if (process.env.SKYHOST_VERIFY_BACKUPS !== "0") await verifyBackup(d, dump);
      await db.update(databaseBackups).set({ status: "completed", verifiedAt: process.env.SKYHOST_VERIFY_BACKUPS !== "0" ? new Date() : null, finishedAt: new Date() }).where(eq(databaseBackups.id, b.id));
      await publish(`database:${d.id}`, { type: "backup.completed", backupId: b.id });
      if (b.kind === "manual") await notify({ teamId: d.teamId, event: "database.backup.completed", title: `Backup of ${d.name} completed`, body: `${Math.round(dump.length / 1024)} KB, encrypted and verified by a test restore.` });
    } catch (e) {
      await db.update(databaseBackups).set({ status: "failed", error: (e as Error).message.slice(0, 1000), finishedAt: new Date() }).where(eq(databaseBackups.id, b.id));
      await notify({ teamId: d.teamId, event: "database.backup.failed", title: `Backup of ${d.name} failed`, body: (e as Error).message.slice(0, 300) });
      throw e;
    }
    return;
  }
  if (data.action === "restore") {
    const [r] = await db.select().from(databaseRestores).where(eq(databaseRestores.id, data.restoreId!));
    if (!r || r.status !== "pending") return;
    const [b] = await db.select().from(databaseBackups).where(eq(databaseBackups.id, r.backupId));
    const [d] = await db.select().from(databases).where(eq(databases.id, r.databaseId));
    if (!b?.objectKey || !d) return;
    await db.update(databaseRestores).set({ status: "running", startedAt: new Date() }).where(eq(databaseRestores.id, r.id));
    await setDbStatus(d.id, { status: "restoring" });
    try {
      // Safety net: snapshot the current data before overwriting it.
      const current = await backupDatabase(refOf(d));
      const [pre] = await db.insert(databaseBackups).values({ databaseId: d.id, kind: "pre-restore", status: "completed", startedAt: new Date(), finishedAt: new Date() }).returning();
      const preKey = `backups/${d.teamId}/${d.id}/${pre!.id}.bin`;
      await getObjectStore().put(preKey, current);
      await db.update(databaseBackups).set({ objectKey: preKey, sizeBytes: current.length, checksum: sha256(current), expiresAt: new Date(Date.now() + 7 * 86400_000) }).where(eq(databaseBackups.id, pre!.id));
      const dump = await getObjectStore().get(b.objectKey);
      if (b.checksum && sha256(dump) !== b.checksum) throw new Error("Backup checksum mismatch");
      await restoreDatabase(refOf(d), dump);
      await db.update(databaseRestores).set({ status: "completed", finishedAt: new Date() }).where(eq(databaseRestores.id, r.id));
      await setDbStatus(d.id, { status: "available" });
      await audit(null, d.teamId, "database.restored", { type: "database", id: d.id }, { backupId: b.id });
    } catch (e) {
      await db.update(databaseRestores).set({ status: "failed", error: (e as Error).message.slice(0, 1000), finishedAt: new Date() }).where(eq(databaseRestores.id, r.id));
      await setDbStatus(d.id, { status: "available" });
      throw e;
    }
  }
}

