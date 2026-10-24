import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local + cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    if (/^f[cd]/.test(lower)) return true; // unique local
    if (/^fe[89ab]/.test(lower)) return true; // link-local
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("fd00:ec2")) return true;
    return false;
  }
  return true;
}

export class SsrfError extends Error {}

/**
 * Validates that a URL targets a public host. Returns the resolved addresses so callers can pin them.
 * `allowHosts` lets internal callers (e.g. the screenshot worker) reach a specific known service host.
 */
export async function assertPublicUrl(raw: string, opts: { allowHosts?: string[]; protocols?: string[] } = {}) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  const protocols = opts.protocols ?? ["http:", "https:"];
  if (!protocols.includes(url.protocol)) throw new SsrfError(`Protocol ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new SsrfError("Credentials in URLs are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (opts.allowHosts?.includes(host)) return { url, addresses: [] as string[] };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new SsrfError("Internal hostnames are not allowed");
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0) throw new SsrfError("Host did not resolve");
  for (const a of addresses) {
    if (isPrivateAddress(a)) throw new SsrfError("Target resolves to a private or reserved address");
  }
  return { url, addresses };
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: () => string;
}

/**
 * fetch for untrusted, user-supplied URLs (outgoing webhooks, notification channels, uptime checks). It validates
 * the URL with assertPublicUrl AND pins the TCP connection to the validated public address, so DNS cannot rebind to
 * a private one between the check and the request. The Host header and the TLS server name stay the original
 * hostname, so HTTPS certificate validation is unaffected. Redirects are never followed.
 */
export async function safeFetch(
  raw: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number; allowHosts?: string[]; protocols?: string[] } = {},
): Promise<SafeFetchResult> {
  const { method = "GET", headers = {}, body, timeoutMs = 10_000, maxBytes = 2 * 1024 * 1024, allowHosts, protocols } = init;
  const { url, addresses } = await assertPublicUrl(raw, { allowHosts, protocols });
  // addresses is empty only for an allowHosts bypass (a fixed, trusted host like api.telegram.org): there we let the
  // resolver run normally; otherwise we connect only to an address we just validated as public.
  const pinned = addresses[0];
  const pinnedFamily = pinned ? isIP(pinned) : 0;
  const customLookup = pinned
    ? (_host: string, options: { all?: boolean } | ((err: Error | null, addr: string, family: number) => void), cb?: (err: Error | null, addr: string | Array<{ address: string; family: number }>, family?: number) => void) => {
        const callback = (typeof options === "function" ? options : cb) as (err: Error | null, addr: string | Array<{ address: string; family: number }>, family?: number) => void;
        const all = typeof options === "object" && options.all;
        if (all) return callback(null, [{ address: pinned, family: pinnedFamily }]);
        return callback(null, pinned, pinnedFamily);
      }
    : undefined;

  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<SafeFetchResult>((resolve, reject) => {
    const req = transport(
      url,
      // lookup is passed through to net.connect; pinning it to a validated address prevents DNS rebinding.
      { method, headers, timeout: timeoutMs, lookup: customLookup },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total <= maxBytes) chunks.push(c);
          else res.destroy();
        });
        res.on("end", () =>
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: () => Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new SsrfError("Request timed out")));
    if (body != null) req.write(body);
    req.end();
  });
}
