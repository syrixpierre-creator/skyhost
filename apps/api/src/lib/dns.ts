import { Resolver } from "node:dns/promises";
import { serverConfig } from "@skyhost/core";

const resolver = new Resolver({ timeout: 4000, tries: 2 });
if (process.env.SKYHOST_DNS_SERVERS) resolver.setServers(process.env.SKYHOST_DNS_SERVERS.split(","));

export const CHALLENGE_PREFIX = "_skyhost-challenge";

export interface DnsInstructions {
  records: Array<{ type: "TXT" | "CNAME" | "A" | "AAAA"; name: string; value: string; purpose: string }>;
}

export function isApex(hostname: string) {
  return hostname.replace(/^\*\./, "").split(".").length === 2;
}

export function dnsInstructions(hostname: string, target: string, token: string): DnsInstructions {
  const bare = hostname.replace(/^\*\./, "");
  const records: DnsInstructions["records"] = [{ type: "TXT", name: `${CHALLENGE_PREFIX}.${bare}`, value: token, purpose: "Proves you own the domain (required)" }];
  const ipv4 = process.env.SKYHOST_PUBLIC_IPV4;
  const ipv6 = process.env.SKYHOST_PUBLIC_IPV6;
  if (isApex(hostname)) {
    if (ipv4) records.push({ type: "A", name: hostname, value: ipv4, purpose: "Routes traffic to SKYHOST" });
    if (ipv6) records.push({ type: "AAAA", name: hostname, value: ipv6, purpose: "Routes IPv6 traffic to SKYHOST" });
    if (!ipv4 && !ipv6) records.push({ type: "CNAME", name: hostname, value: target, purpose: "Use CNAME flattening / ALIAS at your DNS provider" });
  } else {
    records.push({ type: "CNAME", name: hostname, value: target, purpose: "Routes traffic to SKYHOST" });
  }
  return { records };
}

export interface VerificationResult {
  ownership: boolean;
  routing: boolean;
  details: string[];
}

/** Checks the ownership TXT record and that traffic is routed to SKYHOST (CNAME to our host or A/AAAA to our IPs). */
export async function verifyDomain(hostname: string, target: string, token: string): Promise<VerificationResult> {
  const bare = hostname.replace(/^\*\./, "");
  const details: string[] = [];
  let ownership = false;
  try {
    const txt = (await resolver.resolveTxt(`${CHALLENGE_PREFIX}.${bare}`)).map((r) => r.join(""));
    ownership = txt.includes(token);
    details.push(ownership ? "TXT record found" : `TXT record found but value does not match (${txt.join(", ").slice(0, 80)})`);
  } catch {
    details.push(`TXT record ${CHALLENGE_PREFIX}.${bare} not found yet`);
  }
  let routing = false;
  const probe = hostname.startsWith("*.") ? `skyhost-check.${bare}` : hostname;
  try {
    const cname = await resolver.resolveCname(probe);
    routing = cname.some((c) => c.replace(/\.$/, "") === target || c.endsWith(`.${serverConfig().SKYHOST_BASE_DOMAIN}`));
    details.push(routing ? "CNAME points to SKYHOST" : `CNAME points to ${cname.join(", ")}`);
  } catch {
    const ours = [process.env.SKYHOST_PUBLIC_IPV4, process.env.SKYHOST_PUBLIC_IPV6].filter(Boolean) as string[];
    try {
      const ips = [...(await resolver.resolve4(probe).catch(() => [])), ...(await resolver.resolve6(probe).catch(() => []))];
      routing = ips.some((ip) => ours.includes(ip));
      details.push(routing ? "A/AAAA records point to SKYHOST" : ips.length ? `Domain resolves to ${ips.join(", ")}` : "No A/AAAA/CNAME record yet");
    } catch {
      details.push("No routing record found yet");
    }
  }
  return { ownership, routing, details };
}
