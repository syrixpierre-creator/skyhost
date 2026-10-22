import { runMigrations } from "./migrator";

await runMigrations();
console.log("Migrations applied");
