import { runMigrations, seed, getDb } from "@skyhost/db";
import { serverConfig } from "@skyhost/core";
import { buildApp } from "./app";

const cfg = serverConfig();
if (process.env.SKYHOST_MIGRATE_ON_START !== "0") {
  await runMigrations();
  await seed(getDb() as never);
}
const app = await buildApp();
const port = Number(process.env.PORT ?? 4000);
await app.listen({ host: process.env.HOST ?? "0.0.0.0", port });
app.log.info(`SKYHOST API listening on :${port} (${cfg.NODE_ENV})`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
