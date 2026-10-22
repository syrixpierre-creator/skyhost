import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export function migrationsFolder(): string {
  if (process.env.SKYHOST_MIGRATIONS_DIR) return process.env.SKYHOST_MIGRATIONS_DIR;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

export async function runMigrations(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not configured");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: migrationsFolder() });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
