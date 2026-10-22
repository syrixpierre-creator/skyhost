const PATTERNS: RegExp[] = [
  // URLs with credentials: scheme://user:pass@host
  /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
  // Common secret-looking assignments
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*["']?)([^\s"',;]+)/gi,
  // Bearer tokens
  /(bearer\s+)([a-z0-9._~+/-]{12,}=*)/gi,
  // GitHub tokens
  /()(\bgh[pousr]_[A-Za-z0-9]{20,})/g,
  // SKYHOST API keys (sky_<prefix>_<secret>)
  /()(\bsky_[A-Za-z0-9_-]{16,})/g,
  // Stripe keys
  /()(\b(?:sk|rk|pk|whsec)_(?:live_|test_)?[A-Za-z0-9]{16,})/g,
  // PEM blocks
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g,
];

export const REDACTED = "[REDACTED]";

/**
 * Removes secret values from a log line. Known secret values (env secrets, DB passwords) are removed verbatim,
 * then generic patterns catch anything else that looks like a credential.
 */
export function redact(line: string, knownSecrets: Iterable<string> = []): string {
  let out = line;
  const secrets = [...knownSecrets].filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (_m, pre: string, _secret: string, post?: string) => `${pre}${REDACTED}${typeof post === "string" ? post : ""}`);
  }
  return out;
}

export class Redactor {
  private secrets = new Set<string>();
  add(...values: Array<string | undefined | null>) {
    for (const v of values) if (v && v.length >= 4) this.secrets.add(v);
    return this;
  }
  apply(line: string) {
    return redact(line, this.secrets);
  }
}
