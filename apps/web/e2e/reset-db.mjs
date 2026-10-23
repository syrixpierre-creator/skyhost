// Gives every UI test run a fresh database and Redis DB: the API re-applies migrations and the seed on start.
import net from "node:net";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379/14");
if (!url || !/skyhost_ui/.test(url) || redisUrl.pathname === "/" || redisUrl.pathname === "/0") {
  console.error("Refusing to reset databases that are not the UI test databases");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
await sql.end();

// Signup limits and rate limits live in Redis: flush the dedicated test DB with a minimal RESP exchange.
await new Promise((resolve, reject) => {
  const s = net.connect(Number(redisUrl.port || 6379), redisUrl.hostname, () => s.write(`SELECT ${redisUrl.pathname.slice(1)}\r\nFLUSHDB\r\n`));
  let buf = "";
  s.on("data", (d) => {
    buf += d;
    if (buf.split("\r\n").filter(Boolean).length >= 2) {
      s.end();
      buf.includes("-ERR") ? reject(new Error(buf)) : resolve();
    }
  });
  s.on("error", reject);
});
