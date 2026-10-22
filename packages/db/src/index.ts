import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";
export * from "./schema";
export { seed } from "./seed-data";
export { runMigrations } from "./migrator";

export type Database = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql | null = null;
let db: Database | null = null;

export function getDb(url = process.env.DATABASE_URL): Database {
  if (db) return db;
  if (!url) throw new Error("DATABASE_URL is not configured");
  client = postgres(url, { max: Number(process.env.DATABASE_POOL_SIZE ?? 10), onnotice: () => {} });
  db = drizzle(client, { schema });
  return db;
}

export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = null;
  db = null;
}

export function rawClient(): postgres.Sql {
  if (!client) getDb();
  return client!;
}
