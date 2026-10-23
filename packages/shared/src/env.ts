/** Environment variable helpers shared by the dashboard (table <-> JSON editor) and the API. */

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_KEY = 256;
export const MAX_ENV_VALUE = 32 * 1024;

export interface EnvPair {
  key: string;
  value: string;
}

export interface EnvIssue {
  line?: number;
  key?: string;
  message: string;
}

export function isValidEnvKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_ENV_KEY && ENV_KEY_RE.test(key);
}

/** Parses .env content. Supports comments, `export`, single/double quotes, escaped newlines in double quotes and multiline quoted values. */
export function parseDotenv(content: string): { pairs: EnvPair[]; issues: EnvIssue[] } {
  const pairs: EnvPair[] = [];
  const issues: EnvIssue[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      issues.push({ line: i + 1, message: `Line ${i + 1}: expected KEY=value` });
      continue;
    }
    const key = m[1]!;
    let value = m[2]!;
    const q = value[0];
    if (q === '"' || q === "'" || q === "`") {
      let body = value.slice(1);
      let closed = findClosingQuote(body, q);
      // Multiline quoted value
      while (closed === -1 && i + 1 < lines.length) {
        i++;
        body += "\n" + lines[i]!;
        closed = findClosingQuote(body, q);
      }
      if (closed === -1) {
        issues.push({ line: i + 1, key, message: `Unterminated quote for ${key}` });
        continue;
      }
      value = body.slice(0, closed);
      if (q === '"') {
        const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
        value = value.replace(/\\(.)/g, (m, c: string) => esc[c] ?? m);
      }
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }
    if (!isValidEnvKey(key)) {
      issues.push({ line: i + 1, key, message: `Invalid key "${key}"` });
      continue;
    }
    pairs.push({ key, value });
  }
  const dupes = findDuplicates(pairs.map((p) => p.key));
  for (const d of dupes) issues.push({ key: d, message: `Duplicate key "${d}" (last value wins)` });
  return { pairs: dedupeLastWins(pairs), issues };
}

function findClosingQuote(body: string, q: string): number {
  for (let j = 0; j < body.length; j++) {
    if (q === '"' && body[j] === "\\") {
      j++;
      continue;
    }
    if (body[j] === q) return j;
  }
  return -1;
}

export function serializeDotenv(pairs: EnvPair[]): string {
  return (
    pairs
      .map(({ key, value }) => {
        const needsQuotes = /[\s#"'`\\]|^$/.test(value) || value.includes("\n");
        if (!needsQuotes) return `${key}=${value}`;
        const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
        return `${key}="${escaped}"`;
      })
      .join("\n") + (pairs.length ? "\n" : "")
  );
}

/**
 * Parses the raw JSON editor content: must be a flat object of string keys to string/number/boolean values.
 * Duplicate keys are detected on the raw text, because JSON.parse silently keeps the last one.
 */
export function parseEnvJson(text: string): { pairs: EnvPair[]; issues: EnvIssue[] } {
  const issues: EnvIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch (e) {
    return { pairs: [], issues: [{ message: `Invalid JSON: ${(e as Error).message}` }] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { pairs: [], issues: [{ message: "JSON must be an object like {\"KEY\": \"value\"}" }] };
  }
  const pairs: EnvPair[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidEnvKey(key)) {
      issues.push({ key, message: `Invalid key "${key}" (letters, digits and _ only, cannot start with a digit)` });
      continue;
    }
    if (value === null || typeof value === "object") {
      issues.push({ key, message: `Value of "${key}" must be a string, number or boolean` });
      continue;
    }
    const str = String(value);
    if (str.length > MAX_ENV_VALUE) {
      issues.push({ key, message: `Value of "${key}" is too long` });
      continue;
    }
    pairs.push({ key, value: str });
  }
  for (const d of findDuplicateJsonKeys(text)) issues.push({ key: d, message: `Duplicate key "${d}"` });
  return { pairs, issues };
}

export function toEnvJson(pairs: EnvPair[]): string {
  const obj: Record<string, string> = {};
  for (const p of pairs) obj[p.key] = p.value;
  return JSON.stringify(obj, null, 2);
}

export function findDuplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys) (seen.has(k) ? dup : seen).add(k);
  return [...dup];
}

function dedupeLastWins(pairs: EnvPair[]): EnvPair[] {
  const map = new Map<string, string>();
  for (const p of pairs) {
    map.delete(p.key);
    map.set(p.key, p.value);
  }
  return [...map].map(([key, value]) => ({ key, value }));
}

/** Tokenizes top-level object keys of a JSON string to find duplicates. */
function findDuplicateJsonKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  let expectKey = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "{" || c === "[") {
      depth++;
      expectKey = c === "{" && depth === 1;
      i++;
    } else if (c === "}" || c === "]") {
      depth--;
      i++;
    } else if (c === ",") {
      if (depth === 1) expectKey = true;
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          s += text[j + 1] ?? "";
          j += 2;
        } else s += text[j++];
      }
      if (depth === 1 && expectKey) {
        keys.push(s);
        expectKey = false;
      }
      i = j + 1;
    } else i++;
  }
  return findDuplicates(keys);
}

/** Matches ${{service.KEY}} and ${{shared.KEY}} references. */
export const REFERENCE_RE = /\$\{\{\s*([a-zA-Z0-9_-]+)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface ReferenceTarget {
  service: string;
  key: string;
}

export function extractReferences(value: string): ReferenceTarget[] {
  const out: ReferenceTarget[] = [];
  for (const m of value.matchAll(REFERENCE_RE)) out.push({ service: m[1]!, key: m[2]! });
  return out;
}

/**
 * Resolves references using a lookup of `serviceSlug -> vars`. Unknown references are reported and left empty.
 * References are resolved one level deep at a time, up to 5 levels, which also stops cycles.
 */
export function resolveReferences(
  vars: Record<string, string>,
  lookup: (service: string) => Record<string, string> | undefined,
): { resolved: Record<string, string>; missing: string[] } {
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    let cur = v;
    for (let depth = 0; depth < 5 && REFERENCE_RE.test(cur); depth++) {
      REFERENCE_RE.lastIndex = 0;
      cur = cur.replace(REFERENCE_RE, (_m, svc: string, key: string) => {
        const target = lookup(svc);
        const val = target?.[key];
        if (val === undefined) {
          missing.add(`${svc}.${key}`);
          return "";
        }
        return val;
      });
    }
    REFERENCE_RE.lastIndex = 0;
    resolved[k] = cur;
  }
  return { resolved, missing: [...missing] };
}
