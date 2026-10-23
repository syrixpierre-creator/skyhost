import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Client as MinioClient } from "minio";
import { decryptBuffer, encryptBuffer } from "@skyhost/shared/node";

/**
 * Object storage for platform artifacts (source archives, backups, screenshots, invoices).
 * Every object is encrypted with the platform master key before it leaves the process.
 */
export interface ObjectStore {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function checkKey(key: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,500}$/.test(key) || key.includes("..")) throw new Error(`Invalid object key: ${key}`);
}

export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}
  private path(key: string) {
    checkKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error("Invalid object key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, encryptBuffer(data), { mode: 0o600 });
  }
  async get(key: string) {
    return decryptBuffer(await readFile(this.path(key)));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async exists(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}

export class S3ObjectStore implements ObjectStore {
  private client: MinioClient;
  private ready: Promise<void> | null = null;
  constructor(
    endpoint: string,
    accessKey: string,
    secretKey: string,
    private readonly bucket: string,
    region = "us-east-1",
  ) {
    const u = new URL(endpoint);
    this.client = new MinioClient({
      endPoint: u.hostname,
      port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
      useSSL: u.protocol === "https:",
      accessKey,
      secretKey,
      region,
    });
  }
  private ensure() {
    this.ready ??= (async () => {
      if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
    })();
    return this.ready;
  }
  async put(key: string, data: Buffer, contentType = "application/octet-stream") {
    checkKey(key);
    await this.ensure();
    const enc = encryptBuffer(data);
    await this.client.putObject(this.bucket, key, enc, enc.length, { "Content-Type": contentType, "x-amz-meta-skyhost-encrypted": "1" });
  }
  async get(key: string) {
    checkKey(key);
    await this.ensure();
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return decryptBuffer(Buffer.concat(chunks));
  }
  async delete(key: string) {
    checkKey(key);
    await this.ensure();
    await this.client.removeObject(this.bucket, key);
  }
  /** Keys under a prefix with their last modification date (retention of off-site copies). */
  async list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>> {
    await this.ensure();
    const out: Array<{ key: string; lastModified: Date }> = [];
    const stream = this.client.listObjectsV2(this.bucket, prefix, true);
    for await (const o of stream as AsyncIterable<{ name?: string; lastModified?: Date }>) if (o.name) out.push({ key: o.name, lastModified: o.lastModified ?? new Date(0) });
    return out;
  }
  async exists(key: string) {
    checkKey(key);
    await this.ensure();
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch {
      return false;
    }
  }
}

let store: ObjectStore | null = null;

export function getObjectStore(): ObjectStore {
  if (store) return store;
  const env = process.env;
  if ((env.STORAGE_DRIVER || "fs") === "s3") {
    if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) throw new Error("STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY");
    store = new S3ObjectStore(env.S3_ENDPOINT, env.S3_ACCESS_KEY, env.S3_SECRET_KEY, env.S3_BUCKET || "skyhost", env.S3_REGION || undefined);
  } else {
    store = new FsObjectStore(env.STORAGE_FS_ROOT || join(env.SKYHOST_DATA_DIR || "/var/lib/skyhost", "objects"));
  }
  return store;
}

/**
 * Off-site copies (backups of databases and of SKYHOST itself) on an S3-compatible service outside this server:
 * Cloudflare R2, Backblaze B2, AWS S3… Encrypted with the master key like every other object. Null when not set.
 */
let offsite: S3ObjectStore | null | undefined;
export function getOffsiteStore(): S3ObjectStore | null {
  if (offsite !== undefined) return offsite;
  const env = process.env;
  offsite = env.OFFSITE_S3_ENDPOINT && env.OFFSITE_S3_ACCESS_KEY && env.OFFSITE_S3_SECRET_KEY
    ? new S3ObjectStore(env.OFFSITE_S3_ENDPOINT, env.OFFSITE_S3_ACCESS_KEY, env.OFFSITE_S3_SECRET_KEY, env.OFFSITE_S3_BUCKET || "skyhost-backups", env.OFFSITE_S3_REGION || "auto")
    : null;
  return offsite;
}

export function setObjectStore(s: ObjectStore | null) {
  store = s;
}
