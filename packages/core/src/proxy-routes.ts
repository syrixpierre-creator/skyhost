import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { buckets, deployments, domains, environments, getDb, projects, serviceInstances, services, teams } from "@skyhost/db";
import { buildTraefikConfig, names, type Route } from "@skyhost/engine";
import { decrypt } from "@skyhost/shared/node";
import { serverConfig } from "./config";
import { serviceHostname } from "./hostnames";
import { redis } from "./redis";
import { getTeamPlan } from "./quotas";

const PUBLIC_TYPES = new Set(["web", "static", "docker"]);
const htpasswdCache = new Map<string, string>();

/** bcrypt is slow on purpose: cache the hash per credential so the config endpoint stays fast. */
function htpasswd(user: string, password: string) {
  const k = `${user}\0${password}`;
  let h = htpasswdCache.get(k);
  if (!h) {
    h = `${user}:${bcrypt.hashSync(password, 10)}`;
    htpasswdCache.set(k, h);
  }
  return h;
}

export function protectionSecretAad(serviceId: string) {
  return `protection:${serviceId}`;
}

/** Collects every public route from the database and renders the Traefik dynamic configuration. */
export async function buildProxyConfig() {
  const cfg = serverConfig();
  const db = getDb();
  const rows = await db
    .select({ inst: serviceInstances, svc: services, env: environments, project: projects, team: teams })
    .from(serviceInstances)
    .innerJoin(services, eq(services.id, serviceInstances.serviceId))
    .innerJoin(environments, eq(environments.id, serviceInstances.environmentId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(isNotNull(serviceInstances.liveDeploymentId), isNull(services.deletedAt), isNull(environments.deletedAt)));

  const depIds = rows.flatMap((r) => [r.inst.liveDeploymentId!, r.inst.canaryDeploymentId].filter(Boolean) as string[]);
  const deps = depIds.length ? await db.select().from(deployments).where(inArray(deployments.id, depIds)) : [];
  const depById = new Map(deps.map((d) => [d.id, d]));
  const allDomains = rows.length ? await db.select().from(domains).where(inArray(domains.serviceId, rows.map((r) => r.svc.id))) : [];

  const routes: Route[] = [];
  // The dashboard (and the API under /api on the same origin) when Traefik is also the platform's own edge.
  if (cfg.SKYHOST_DASHBOARD_UPSTREAM) {
    routes.push({ id: "sh-dashboard", hosts: [new URL(cfg.SKYHOST_DASHBOARD_URL).hostname], backends: [{ deploymentId: "dashboard", weight: 100, servers: [cfg.SKYHOST_DASHBOARD_UPSTREAM] }], tls: cfg.SKYHOST_TLS, certResolver: cfg.SKYHOST_CERT_RESOLVER });
  }
  for (const { inst, svc, env, team } of rows) {
    if (!PUBLIC_TYPES.has(svc.type)) continue;
    if (team.suspendedAt || inst.status === "paused") continue;
    const live = depById.get(inst.liveDeploymentId!);
    if (!live) continue;
    const port = (live.configSnapshot?.port ?? svc.config.port ?? 3000) as number;
    const servers = (d: typeof live) => (d.containers.length ? d.containers : [names.appContainer(svc.id, d.id)]).map((c) => `http://${c}:${(d.configSnapshot?.port ?? port) as number}`);
    const backends = [{ deploymentId: live.id, weight: 100 - (inst.canaryWeight || 0), servers: servers(live) }];
    const canary = inst.canaryDeploymentId ? depById.get(inst.canaryDeploymentId) : undefined;
    if (canary && canary.status === "live" && inst.canaryWeight > 0) backends.push({ deploymentId: canary.id, weight: inst.canaryWeight, servers: servers(canary) });

    const prot = svc.config.protection;
    const protect = prot && prot.mode !== "none" && (env.type !== "preview" || prot.applyToPreviews !== false);
    const base: Omit<Route, "id" | "hosts" | "certResolver" | "redirectTo"> = {
      backends,
      tls: cfg.SKYHOST_TLS,
      sleeping: inst.sleeping,
      rateLimitPerMinute: svc.config.waf?.enabled ? svc.config.waf.rateLimitPerMinute : 0,
      headers: { "X-Skyhost-Service": svc.slug },
    };
    if (protect && prot.mode === "basic" && prot.basicUser && prot.basicPassword) {
      base.basicAuthUsers = [htpasswd(prot.basicUser, safeDecrypt(prot.basicPassword, svc.id))];
    }
    if (protect && prot.mode === "ip" && prot.ipAllowlist?.length) base.ipAllowlist = prot.ipAllowlist;
    const needsGate = (protect && prot.mode === "password") || (svc.config.waf?.enabled && (svc.config.waf.rules.length > 0 || svc.config.waf.blockBots));
    if (needsGate) base.forwardAuthUrl = `${cfg.SKYHOST_API_INTERNAL_URL}/internal/gate?instance=${inst.id}&token=${encodeURIComponent(cfg.SKYHOST_INTERNAL_TOKEN)}`;

    routes.push({ ...base, id: `i-${inst.id}`, hosts: [serviceHostname(svc, env)], certResolver: cfg.SKYHOST_WILDCARD_CERT_RESOLVER || cfg.SKYHOST_CERT_RESOLVER });
    for (const d of allDomains) {
      if (d.serviceId !== svc.id || (d.environmentId && d.environmentId !== env.id)) continue;
      if (!d.environmentId && env.type !== "production") continue;
      if (d.status !== "verified" && d.status !== "ssl_issued") continue;
      routes.push({ ...base, id: `d-${d.id}`, hosts: [d.hostname], certResolver: cfg.SKYHOST_CERT_RESOLVER, redirectTo: d.redirectTo });
    }
  }

  // Project status pages on custom domains
  const statusDomains = await db.select().from(domains).where(eq(domains.target, "status_page"));
  for (const d of statusDomains) {
    if (d.status !== "verified" && d.status !== "ssl_issued") continue;
    routes.push({ id: `s-${d.id}`, kind: "status", hosts: [d.hostname], backends: [], tls: cfg.SKYHOST_TLS, certResolver: cfg.SKYHOST_CERT_RESOLVER });
  }

  // Object storage buckets
  const bks = await db.select().from(buckets).where(isNull(buckets.deletedAt));
  for (const b of bks) {
    const over = await redis().get(`sh:bucket:over:${b.id}`);
    routes.push({
      id: `b-${b.id}`,
      hosts: [`s3-${b.id.replace(/-/g, "").slice(0, 12)}.${cfg.SKYHOST_BASE_DOMAIN}`],
      backends: [{ deploymentId: b.id, weight: 100, servers: [`http://${names.bucketContainer(b.id)}:9000`] }],
      tls: cfg.SKYHOST_TLS,
      certResolver: cfg.SKYHOST_WILDCARD_CERT_RESOLVER || cfg.SKYHOST_CERT_RESOLVER,
      blockMethods: over === "1" ? ["PUT", "POST"] : undefined,
    });
  }

  return buildTraefikConfig(routes, {
    apiUrl: cfg.SKYHOST_API_INTERNAL_URL,
    httpEntryPoint: "web",
    httpsEntryPoint: "websecure",
    tlsEnabled: cfg.SKYHOST_TLS,
    internalToken: cfg.SKYHOST_INTERNAL_TOKEN,
  });
}

/** Protection passwords are stored encrypted inside the service config. Plain values (legacy) pass through. */
export function safeDecrypt(v: string, serviceId: string) {
  if (!v.startsWith("v1:")) return v;
  try {
    return decrypt(v, undefined, protectionSecretAad(serviceId));
  } catch {
    return "";
  }
}

export async function planAllowsSleep(teamId: string) {
  return (await getTeamPlan(teamId)).features.sleepWhenIdle;
}
