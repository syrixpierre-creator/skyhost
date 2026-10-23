import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { deployments, domains, getDb, projects, serviceInstances, services, teams, uptimeChecks } from "@skyhost/db";
import { hmacSha256, safeEqual } from "@skyhost/shared/node";
import { buildProxyConfig, enqueue, redis, safeDecrypt, serverConfig } from "@skyhost/core";
import { renderStatusPage, statusPageData } from "./public";

/** Internal endpoints are only reachable from the platform network and require the internal token. */
function internalAuth(req: FastifyRequest): boolean {
  const token = (req.headers["x-skyhost-token"] as string | undefined) ?? (req.query as { token?: string }).token;
  return !!token && safeEqual(token, serverConfig().SKYHOST_INTERNAL_TOKEN);
}

const BOT_UA = /(bot|crawler|spider|scrapy|python-requests|go-http-client|curl|wget|httpclient|libwww|masscan|zgrab|nikto|sqlmap)/i;

function ipMatches(ip: string, entry: string) {
  const toInt = (x: string) => x.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const v4 = ip.replace(/^::ffff:/, "");
  const [base, bits] = entry.split("/");
  if (!bits) return base === v4;
  if (!v4.includes(".")) return false;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(v4) & mask) === (toInt(base!) & mask);
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0b0d10;color:#e6e8eb;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:380px;width:100%;padding:24px;border:1px solid #23272e;border-radius:8px;background:#121418}h1{font-size:18px;margin:0 0 8px}p{color:#9aa1ab;font-size:14px;line-height:1.5}input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #2c313a;background:#0b0d10;color:#e6e8eb;margin:8px 0}button{width:100%;padding:10px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}small{color:#6b7280}</style></head><body><main>${body}<p><small>Protected by SKYHOST</small></p></main></body></html>`;
}

export default async function internalRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/internal/status-page") || req.url.startsWith("/internal/blocked")) return;
    if (!internalAuth(req)) return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
  });

  /** Traefik HTTP provider endpoint: the full dynamic routing configuration. */
  app.get("/proxy/traefik", { config: { public: true, rateLimit: false } }, async () => buildProxyConfig());

  /**
   * forwardAuth gate for password protection and WAF rules. Traefik forwards the original request headers;
   * a 2xx lets the request through, anything else is returned to the visitor as is.
   */
  app.get("/gate", { config: { public: true, rateLimit: false } }, async (req, reply) => {
    const instanceId = (req.query as { instance?: string }).instance ?? "";
    const db = getDb();
    const [row] = await db.select({ inst: serviceInstances, svc: services }).from(serviceInstances).innerJoin(services, eq(services.id, serviceInstances.serviceId)).where(eq(serviceInstances.id, instanceId));
    if (!row) return reply.code(404).send("Not found");
    const cfg = row.svc.config;
    const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() || String(req.headers["x-real-ip"] ?? "");
    const ua = String(req.headers["user-agent"] ?? "");
    const uri = String(req.headers["x-forwarded-uri"] ?? "/");
    const country = String(req.headers["cf-ipcountry"] ?? "").toUpperCase();

    if (cfg.waf?.enabled) {
      for (const rule of cfg.waf.rules ?? []) {
        const m = rule.match;
        const hit =
          (!m.ip?.length || m.ip.some((e) => ipMatches(ip, e))) &&
          (!m.country?.length || m.country.map((c) => c.toUpperCase()).includes(country)) &&
          (!m.pathPrefix || uri.startsWith(m.pathPrefix)) &&
          (!m.userAgentContains || ua.toLowerCase().includes(m.userAgentContains.toLowerCase())) &&
          !!(m.ip?.length || m.country?.length || m.pathPrefix || m.userAgentContains);
        if (hit && rule.action === "block") return reply.code(403).type("text/plain").send("Forbidden by the site's firewall rules");
        if (hit && rule.action === "allow") break;
      }
      if (cfg.waf.blockBots && (!ua || BOT_UA.test(ua))) return reply.code(403).type("text/plain").send("Automated traffic is not allowed");
    }

    const prot = cfg.protection;
    if (prot?.mode === "password" && prot.password) {
      const secret = safeDecrypt(prot.password, row.svc.id);
      const cookieName = `sh_gate_${instanceId.slice(0, 8)}`;
      const expected = hmacSha256(serverConfig().SKYHOST_SESSION_SECRET, `${instanceId}:${secret}`).slice(0, 40);
      const cookies = Object.fromEntries(String(req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2) as Array<[string, string]>);
      if (cookies[cookieName] && safeEqual(cookies[cookieName]!, expected)) return reply.code(200).send("ok");
      const url = new URL(uri, "http://x");
      const attempt = url.searchParams.get("__skyhost_password");
      if (attempt !== null) {
        const key = `sh:gate:fail:${instanceId}:${ip}`;
        const fails = Number((await redis().get(key)) ?? 0);
        if (fails >= 10) return reply.code(429).type("text/html").send(page("Too many attempts", "<h1>Too many attempts</h1><p>Try again in 15 minutes.</p>"));
        if (safeEqual(attempt, secret)) {
          url.searchParams.delete("__skyhost_password");
          const secure = serverConfig().SKYHOST_PUBLIC_SCHEME === "https" ? "; Secure" : "";
          reply.header("Set-Cookie", `${cookieName}=${expected}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
          return reply.code(302).header("Location", url.pathname + (url.search || "")).send();
        }
        await redis().multi().incr(key).expire(key, 900).exec();
      }
      const wrong = attempt !== null ? '<p style="color:#f87171">Incorrect password.</p>' : "";
      return reply
        .code(401)
        .type("text/html")
        .send(page("Protected", `<h1>This site is protected</h1><p>Enter the password to continue.</p>${wrong}<form method="get"><input type="password" name="__skyhost_password" placeholder="Password" autofocus required><button type="submit">Continue</button></form>`));
    }
    return reply.code(200).send("ok");
  });

  /** Sleeping services: the first request wakes them up and shows a short waiting page. */
  app.all("/wake/*", { config: { public: true, rateLimit: false } }, async (req, reply) => {
    const route = String(req.headers["x-skyhost-route"] ?? "");
    const instanceId = route.replace(/^[id]-/, "");
    const db = getDb();
    let inst;
    if (route.startsWith("d-")) {
      const [d] = await db.select().from(domains).where(eq(domains.id, instanceId));
      if (d?.serviceId) [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, d.serviceId), d.environmentId ? eq(serviceInstances.environmentId, d.environmentId) : undefined));
    } else [inst] = await db.select().from(serviceInstances).where(eq(serviceInstances.id, instanceId));
    if (!inst) return reply.code(404).send("Unknown service");
    if (await redis().set(`sh:waking:${inst.id}`, "1", "EX", 60, "NX")) {
      await enqueue("maintenance", { task: `wake:${inst.serviceId}:${inst.environmentId}` });
    }
    await db.update(serviceInstances).set({ lastRequestAt: new Date() }).where(eq(serviceInstances.id, inst.id));
    return reply
      .code(503)
      .header("Retry-After", "3")
      .header("Cache-Control", "no-store")
      .type("text/html")
      .send(page("Waking up", `<meta http-equiv="refresh" content="3"><h1>Waking up…</h1><p>This app was asleep to save resources. It will be ready in a few seconds; this page refreshes automatically.</p>`));
  });

  app.all("/blocked/*", { config: { public: true, rateLimit: false } }, async (_req, reply: FastifyReply) =>
    reply.code(507).type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?><Error><Code>QuotaExceeded</Code><Message>The storage quota of this bucket is exceeded. Upgrade the plan or delete objects.</Message></Error>'),
  );

  /** Project status pages served on custom domains. */
  app.get("/status-page/*", { config: { public: true } }, async (req, reply) => {
    if (!internalAuth(req)) return reply.code(404).send("Not found");
    const route = String(req.headers["x-skyhost-route"] ?? "");
    const [d] = await getDb().select().from(domains).where(eq(domains.id, route.replace(/^s-/, "")));
    if (!d?.projectId) return reply.code(404).send("Not found");
    const [p] = await getDb().select().from(projects).where(and(eq(projects.id, d.projectId), isNull(projects.deletedAt)));
    if (!p?.statusPageEnabled) return reply.code(404).send("Not found");
    return reply.type("text/html").send(renderStatusPage(await statusPageData(p)));
  });

  /** Prometheus metrics for the control plane. */
  app.get("/metrics", { config: { public: true, rateLimit: false } }, async (_req, reply) => {
    const db = getDb();
    const byStatus = await db.select({ status: deployments.status, c: count() }).from(deployments).groupBy(deployments.status);
    const insts = await db.select({ status: serviceInstances.status, c: count() }).from(serviceInstances).groupBy(serviceInstances.status);
    const [t] = await db.select({ c: count() }).from(teams).where(isNull(teams.deletedAt));
    const [u] = await db.select({ c: count() }).from(uptimeChecks).where(inArray(uptimeChecks.lastStatus, ["down"]));
    const lines = [
      "# HELP skyhost_deployments_total Deployments by status",
      "# TYPE skyhost_deployments_total gauge",
      ...byStatus.map((r) => `skyhost_deployments_total{status="${r.status}"} ${r.c}`),
      "# HELP skyhost_service_instances Service instances by status",
      "# TYPE skyhost_service_instances gauge",
      ...insts.map((r) => `skyhost_service_instances{status="${r.status}"} ${r.c}`),
      "# TYPE skyhost_teams gauge",
      `skyhost_teams ${t?.c ?? 0}`,
      "# TYPE skyhost_uptime_checks_down gauge",
      `skyhost_uptime_checks_down ${u?.c ?? 0}`,
    ];
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });
}
