import { hash, verify } from "@node-rs/argon2";

// Argon2id (algorithm 2) with OWASP recommended parameters.
const OPTS = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string) {
  return hash(password, OPTS);
}

export async function verifyPassword(stored: string | null | undefined, password: string) {
  if (!stored) {
    // Constant-ish time for unknown users.
    await hash(password, OPTS).catch(() => {});
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
