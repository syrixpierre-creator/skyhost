import { slugify } from "@skyhost/shared";
import { serverConfig } from "./config";

/** Generated public hostname of a service in an environment. Single label so one wildcard certificate covers all. */
export function serviceHostname(o: { slug: string; subdomain: string; domainLabel?: string | null }, env: { type: string; name: string; prNumber?: number | null }): string {
  const base = serverConfig().SKYHOST_BASE_DOMAIN;
  // Production uses the pretty label (e.g. queen-akuma.skyhost.tech) when the service has one; services created
  // before this feature keep the legacy <slug>-<subdomain> form (domainLabel null), so their URLs never change.
  if (env.type === "production") return `${o.domainLabel || `${o.slug}-${o.subdomain}`}.${base}`;
  if (env.type === "preview" && env.prNumber) return `pr-${env.prNumber}-${o.slug}-${o.subdomain}.${base}`;
  return `${o.slug}-${o.subdomain}-${slugify(env.name, 16)}.${base}`;
}

export function publicUrl(host: string) {
  return `${serverConfig().SKYHOST_PUBLIC_SCHEME}://${host}`;
}

/** Private DNS name of a service inside its team network. */
export function internalHost(slug: string, env: { type: string; id: string }) {
  return env.type === "production" ? slug : `${slug}-${env.id.slice(0, 8)}`;
}
