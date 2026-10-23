/**
 * Builds Traefik dynamic configuration (served to Traefik by the API through its HTTP provider).
 * Zero-downtime switches happen by changing which container a router points to, after the new one is healthy.
 */

export interface RouteBackend {
  url: string; // http://<container>:<port>
  weight?: number;
}

export interface Route {
  id: string;
  hosts: string[];
  /** Live backends (blue/green: exactly one deployment; canary: two with weights). */
  backends: Array<{ deploymentId: string; weight: number; servers: string[] }>;
  tls: boolean;
  /** Use the ACME resolver for custom domains (wildcard platform domain uses a pre-issued cert or DNS challenge). */
  certResolver?: string | null;
  /** Certificate names to request (one wildcard certificate shared by every platform host instead of one per host). */
  tlsDomains?: Array<{ main: string; sans?: string[] }>;
  basicAuthUsers?: string[];
  ipAllowlist?: string[];
  /** forwardAuth URL for password protection / WAF rules. */
  forwardAuthUrl?: string | null;
  rateLimitPerMinute?: number;
  redirectTo?: string | null;
  /** When sleeping, requests go to the waker which starts the service and shows a waiting page. */
  sleeping?: boolean;
  /** Block writes (used for buckets above quota). */
  blockMethods?: string[];
  headers?: Record<string, string>;
  /** "status": a project status page on a custom domain; "maintenance": the service's maintenance page. Both served by the API. */
  kind?: "app" | "status" | "maintenance";
}

const tlsOf = (r: Route) => (r.certResolver ? { certResolver: r.certResolver, ...(r.tlsDomains?.length ? { domains: r.tlsDomains } : {}) } : {});

export interface ProxyOptions {
  apiUrl: string; // internal URL of the API, e.g. http://api.skyhost-control:4000
  httpEntryPoint: string;
  httpsEntryPoint: string;
  tlsEnabled: boolean;
  internalToken: string;
}

type Obj = Record<string, unknown>;

const key = (id: string) => id.replace(/[^a-zA-Z0-9-]/g, "-");
const hostRule = (hosts: string[]) =>
  hosts
    .map((h) => (h.startsWith("*.") ? `HostRegexp(\`^[a-z0-9-]+\\.${h.slice(2).replace(/\./g, "\\.")}$\`)` : `Host(\`${h}\`)`))
    .join(" || ");

export function buildTraefikConfig(routes: Route[], opts: ProxyOptions): Obj {
  const routers: Obj = {};
  const services: Obj = {};
  const middlewares: Obj = {
    "sh-https-redirect": { redirectScheme: { scheme: "https", permanent: true } },
    "sh-security-headers": {
      headers: {
        stsSeconds: 31536000,
        stsIncludeSubdomains: false,
        contentTypeNosniff: true,
        referrerPolicy: "strict-origin-when-cross-origin",
      },
    },
  };
  // Requests handled by the API itself (waker, quota block page, status pages on custom domains) get a path prefix.
  services["sh-api"] = { loadBalancer: { servers: [{ url: opts.apiUrl }], passHostHeader: true } };
  middlewares["sh-wake-prefix"] = { addPrefix: { prefix: "/internal/wake" } };
  middlewares["sh-blocked-prefix"] = { addPrefix: { prefix: "/internal/blocked" } };
  middlewares["sh-status-prefix"] = { addPrefix: { prefix: "/internal/status-page" } };
  middlewares["sh-maintenance-prefix"] = { addPrefix: { prefix: "/internal/maintenance" } };

  for (const r of routes) {
    const k = key(r.id);
    if (!r.hosts.length) continue;
    const rule = hostRule(r.hosts);
    const mws: string[] = ["sh-security-headers"];
    if (r.redirectTo) {
      middlewares[`${k}-redirect`] = { redirectRegex: { regex: "^https?://[^/]+(.*)", replacement: `https://${r.redirectTo}$1`, permanent: true } };
      mws.push(`${k}-redirect`);
    }
    if (r.ipAllowlist?.length) {
      middlewares[`${k}-ip`] = { ipAllowList: { sourceRange: r.ipAllowlist } };
      mws.push(`${k}-ip`);
    }
    if (r.basicAuthUsers?.length) {
      middlewares[`${k}-auth`] = { basicAuth: { users: r.basicAuthUsers, removeHeader: true } };
      mws.push(`${k}-auth`);
    }
    if (r.rateLimitPerMinute && r.rateLimitPerMinute > 0) {
      middlewares[`${k}-rl`] = { rateLimit: { average: r.rateLimitPerMinute, period: "1m", burst: Math.max(10, Math.round(r.rateLimitPerMinute / 4)) } };
      mws.push(`${k}-rl`);
    }
    if (r.forwardAuthUrl) {
      middlewares[`${k}-gate`] = {
        forwardAuth: { address: r.forwardAuthUrl, trustForwardHeader: false, authResponseHeaders: ["Set-Cookie"], authRequestHeaders: ["Cookie", "User-Agent", "X-Forwarded-For", "X-Real-Ip", "CF-IPCountry"] },
      };
      mws.push(`${k}-gate`);
    }
    if (r.headers && Object.keys(r.headers).length) {
      middlewares[`${k}-hdr`] = { headers: { customRequestHeaders: r.headers } };
      mws.push(`${k}-hdr`);
    }

    let serviceName: string;
    if (r.kind === "maintenance") {
      middlewares[`${k}-route`] = { headers: { customRequestHeaders: { "X-Skyhost-Route": r.id, "X-Skyhost-Token": opts.internalToken } } };
      mws.push(`${k}-route`, "sh-maintenance-prefix");
      serviceName = "sh-api";
    } else if (r.kind === "status") {
      middlewares[`${k}-route`] = { headers: { customRequestHeaders: { "X-Skyhost-Route": r.id, "X-Skyhost-Token": opts.internalToken } } };
      mws.push(`${k}-route`, "sh-status-prefix");
      serviceName = "sh-api";
    } else if (r.sleeping) {
      middlewares[`${k}-route`] = { headers: { customRequestHeaders: { "X-Skyhost-Route": r.id, "X-Skyhost-Token": opts.internalToken } } };
      mws.push(`${k}-route`, "sh-wake-prefix");
      serviceName = "sh-api";
    } else if (r.backends.length === 1) {
      serviceName = `${k}-svc`;
      services[serviceName] = lb(r.backends[0]!.servers);
    } else if (r.backends.length > 1) {
      serviceName = `${k}-svc`;
      const weighted: Array<{ name: string; weight: number }> = [];
      for (const b of r.backends) {
        const name = `${k}-${key(b.deploymentId).slice(0, 12)}`;
        services[name] = lb(b.servers);
        weighted.push({ name, weight: b.weight });
      }
      services[serviceName] = { weighted: { services: weighted, sticky: { cookie: { name: `sh_canary_${k.slice(0, 8)}`, httpOnly: true, secure: opts.tlsEnabled } } } };
    } else continue;

    if (opts.tlsEnabled && r.tls) {
      routers[`${k}-http`] = { rule, entryPoints: [opts.httpEntryPoint], middlewares: ["sh-https-redirect"], service: serviceName, priority: 10 };
      routers[k] = { rule, entryPoints: [opts.httpsEntryPoint], middlewares: mws, service: serviceName, tls: tlsOf(r), priority: 10 };
    } else {
      routers[k] = { rule, entryPoints: [opts.httpEntryPoint], middlewares: mws, service: serviceName, priority: 10 };
    }
    if (r.blockMethods?.length) {
      const methodRule = `(${rule}) && Method(${r.blockMethods.map((m) => `\`${m}\``).join(", ")})`;
      routers[`${k}-blocked`] = {
        rule: methodRule,
        entryPoints: [opts.tlsEnabled && r.tls ? opts.httpsEntryPoint : opts.httpEntryPoint],
        service: "sh-api",
        middlewares: ["sh-blocked-prefix"],
        priority: 100,
        ...(opts.tlsEnabled && r.tls ? { tls: tlsOf(r) } : {}),
      };
    }
  }
  return { http: { routers, services, middlewares } };
}

function lb(servers: string[]) {
  return {
    loadBalancer: {
      servers: servers.map((url) => ({ url })),
      passHostHeader: true,
      responseForwarding: { flushInterval: "100ms" },
    },
  };
}
