import { closeDb, getDb } from "./index";
import { seed } from "./seed-data";

await seed(getDb() as never);
await closeDb();
console.log("Seed complete");
