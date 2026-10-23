import { emailAdmins, redis } from "@skyhost/core";
import { execInContainer, getOffsiteStore } from "@skyhost/engine";

/**
 * Off-site copies: every database backup, plus a daily dump of the SKYHOST database itself, go to an S3 bucket
 * outside this server. If the server is lost, the platform and the customers' data can be restored elsewhere
 * (with the .env file, which holds the encryption keys and must be kept somewhere safe as well).
 */
const STATUS_KEY = "sh:offsite:status";
const retentionDays = () => Number(process.env.OFFSITE_RETENTION_DAYS ?? 14);

export interface OffsiteStatus {
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastPlatformDumpAt: string | null;
}

export async function offsiteStatus(): Promise<OffsiteStatus> {
  const raw = await redis().get(STATUS_KEY);
  return raw ? (JSON.parse(raw) as OffsiteStatus) : { lastSuccessAt: null, lastError: null, lastErrorAt: null, lastPlatformDumpAt: null };
}

async function record(ok: boolean, error?: string, platform = false) {
  const s = await offsiteStatus();
  const now = new Date().toISOString();
  const next = ok ? { ...s, lastSuccessAt: now, ...(platform ? { lastPlatformDumpAt: now } : {}) } : { ...s, lastError: error?.slice(0, 500) ?? "unknown error", lastErrorAt: now };
  await redis().set(STATUS_KEY, JSON.stringify(next));
  if (!ok) {
    await emailAdmins("Off-site backup failed", [`A copy to the off-site storage failed: ${error}`, "The local backups are not affected. Check the OFFSITE_S3_* settings and the bucket."], { cooldownKey: "offsite-failed", cooldownSeconds: 12 * 3600, link: "/admin" });
  }
}

/** Copies a database backup off-site (best effort: the local backup already succeeded). */
export async function copyBackupOffsite(key: string, data: Buffer) {
  const store = getOffsiteStore();
  if (!store) return;
  try {
    await store.put(`databases/${key}`, data);
    await record(true);
  } catch (e) {
    await record(false, (e as Error).message);
  }
}

/** Daily dump of the SKYHOST database (users, teams, projects, settings…) and retention of off-site copies. */
export async function platformBackup() {
  const store = getOffsiteStore();
  if (!store) return;
  try {
    const url = new URL(process.env.DATABASE_URL ?? "postgres://skyhost@postgres/skyhost");
    const container = process.env.SKYHOST_POSTGRES_CONTAINER ?? "skyhost-postgres-1";
    const res = await execInContainer(container, ["pg_dump", "-U", decodeURIComponent(url.username || "skyhost"), "-d", url.pathname.slice(1) || "skyhost", "-Fc"], { timeoutMs: 30 * 60_000 });
    if (res.exitCode !== 0 || !res.stdout.length) throw new Error(`pg_dump failed: ${res.stderr.toString().slice(0, 300) || `exit code ${res.exitCode}`}`);
    const day = new Date().toISOString().slice(0, 10);
    await store.put(`platform/skyhost-${day}.dump`, res.stdout);
    const cutoff = Date.now() - retentionDays() * 86400_000;
    for (const prefix of ["platform/", "databases/"]) {
      for (const o of await store.list(prefix)) if (o.lastModified.getTime() < cutoff) await store.delete(o.key).catch(() => {});
    }
    await record(true, undefined, true);
  } catch (e) {
    await record(false, (e as Error).message);
  }
}
