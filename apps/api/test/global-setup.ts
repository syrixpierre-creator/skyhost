import postgres from "postgres";
import { Redis } from "ioredis";
import { TEST_ENV } from "./env";

/** Fresh schema for every run: migrations and seed are applied exactly like production. */
export default async function setup() {
  Object.assign(process.env, TEST_ENV);
  const sql = postgres(TEST_ENV.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await sql.end();
  const { runMigrations, seed, getDb, closeDb } = await import("@skyhost/db");
  await runMigrations(TEST_ENV.DATABASE_URL);
  await seed(getDb(TEST_ENV.DATABASE_URL) as never);
  await closeDb();
  const r = new Redis(TEST_ENV.REDIS_URL!);
  await r.flushdb();
  await r.quit();
}
