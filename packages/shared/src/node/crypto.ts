import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope format: "v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>"
 * Keys come from SKYHOST_MASTER_KEYS ("k1:<base64 32 bytes>,k2:<...>") and never live in the database.
 * The first key is used for new encryptions; older keys stay readable, which makes rotation possible.
 */
export interface Keyring {
  current: string;
  keys: Map<string, Buffer>;
}

let cached: Keyring | null = null;

export function parseKeyring(spec: string): Keyring {
  const keys = new Map<string, Buffer>();
  let current = "";
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    if (idx <= 0) throw new Error("Invalid SKYHOST_MASTER_KEYS entry (expected id:base64key)");
    const id = part.slice(0, idx);
    const key = Buffer.from(part.slice(idx + 1), "base64");
    if (key.length !== 32) throw new Error(`Master key ${id} must be 32 bytes (base64 encoded)`);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid master key id ${id}`);
    keys.set(id, key);
    if (!current) current = id;
  }
  if (!current) throw new Error("SKYHOST_MASTER_KEYS is empty");
  return { current, keys };
}

export function getKeyring(): Keyring {
  if (cached) return cached;
  const spec = process.env.SKYHOST_MASTER_KEYS;
  if (!spec) throw new Error("SKYHOST_MASTER_KEYS is not configured");
  cached = parseKeyring(spec);
  return cached;
}

export function setKeyring(k: Keyring | null) {
  cached = k;
}

export function encrypt(plaintext: string, ring: Keyring = getKeyring(), aad?: string): string {
  const key = ring.keys.get(ring.current)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", ring.current, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(envelope: string, ring: Keyring = getKeyring(), aad?: string): string {
  const [ver, keyId, ivB64, tagB64, ctB64] = envelope.split(":");
  if (ver !== "v1" || !keyId || ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new Error("Invalid encrypted payload");
  }
  const key = ring.keys.get(keyId);
  if (!key) throw new Error(`Unknown master key id ${keyId}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Re-encrypts a payload with the current key; returns null when it already uses it. */
export function reencrypt(envelope: string, ring: Keyring = getKeyring(), aad?: string): string | null {
  if (envelope.split(":")[1] === ring.current) return null;
  return encrypt(decrypt(envelope, ring, aad), ring, aad);
}

/** Binary encryption for backups / object storage. Layout: magic(4) keyIdLen(1) keyId iv(12) tag(16) ct */
export function encryptBuffer(data: Buffer, ring: Keyring = getKeyring()): Buffer {
  const key = ring.keys.get(ring.current)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const id = Buffer.from(ring.current);
  return Buffer.concat([Buffer.from("SKY1"), Buffer.from([id.length]), id, iv, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(blob: Buffer, ring: Keyring = getKeyring()): Buffer {
  if (blob.subarray(0, 4).toString() !== "SKY1") throw new Error("Not a SKYHOST encrypted blob");
  const idLen = blob[4]!;
  const id = blob.subarray(5, 5 + idLen).toString();
  const key = ring.keys.get(id);
  if (!key) throw new Error(`Unknown master key id ${id}`);
  const off = 5 + idLen;
  const iv = blob.subarray(off, off + 12);
  const tag = blob.subarray(off + 12, off + 28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(off + 28)), decipher.final()]);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Human friendly random string from an unambiguous alphabet. */
export function randomId(len = 8, alphabet = "abcdefghijkmnpqrstuvwxyz23456789"): string {
  const out: string[] = [];
  const buf = randomBytes(len * 2);
  for (let i = 0; out.length < len; i++) {
    const b = buf[i % buf.length]!;
    if (b < 256 - (256 % alphabet.length)) out.push(alphabet[b % alphabet.length]!);
    if (i > len * 8) break;
  }
  while (out.length < len) out.push(alphabet[0]!);
  return out.join("");
}

export function randomPassword(len = 32): string {
  return randomId(len, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789");
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256(secret: string | Buffer, payload: string | Buffer, encoding: "hex" | "base64" = "hex"): string {
  return createHmac("sha256", secret).update(payload).digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Generates a fresh base64 master key. */
export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}
