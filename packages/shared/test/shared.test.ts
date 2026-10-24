import { describe, expect, it } from "vitest";
import { parseDotenv, parseEnvJson, resolveReferences, serializeDotenv, toEnvJson } from "../src/env";
import { can, permissionsFor, scopeAllows } from "../src/rbac";
import { decrypt, decryptBuffer, encrypt, encryptBuffer, generateMasterKey, parseKeyring, reencrypt } from "../src/node/crypto";
import { isPrivateAddress, assertPublicUrl, safeFetch } from "../src/node/ssrf";
import { redact, REDACTED } from "../src/node/redact";
import { slugify } from "../src/format";

describe("dotenv", () => {
  it("parses comments, quotes, export and multiline values", () => {
    const { pairs, issues } = parseDotenv(`# comment
export A=1
B="hello world" # trailing
C='single'
D="line1\\nline2"
E="multi
line"
F=unquoted # comment
1BAD=x
`);
    expect(issues.map((i) => i.key)).toEqual(["1BAD"]);
    expect(Object.fromEntries(pairs.map((p) => [p.key, p.value]))).toEqual({
      A: "1",
      B: "hello world",
      C: "single",
      D: "line1\nline2",
      E: "multi\nline",
      F: "unquoted",
    });
  });

  it("round-trips through serialize", () => {
    const pairs = [
      { key: "A", value: "plain" },
      { key: "B", value: 'with "quotes" and spaces' },
      { key: "C", value: "multi\nline" },
      { key: "D", value: "" },
    ];
    expect(parseDotenv(serializeDotenv(pairs)).pairs).toEqual(pairs);
  });

  it("reports duplicates and keeps the last value", () => {
    const { pairs, issues } = parseDotenv("A=1\nA=2\n");
    expect(pairs).toEqual([{ key: "A", value: "2" }]);
    expect(issues[0]!.message).toMatch(/Duplicate/);
  });
});

describe("env JSON editor", () => {
  it("detects duplicate keys that JSON.parse would hide", () => {
    const { issues } = parseEnvJson('{"A":"1","B":{"A":2},"A":"3"}');
    expect(issues.some((i) => i.message === 'Duplicate key "A"')).toBe(true);
    expect(issues.some((i) => i.key === "B")).toBe(true);
  });

  it("rejects invalid keys and non-objects", () => {
    expect(parseEnvJson('["x"]').issues).toHaveLength(1);
    expect(parseEnvJson('{"bad-key":"x"}').issues[0]!.key).toBe("bad-key");
    expect(parseEnvJson("{nope").issues[0]!.message).toMatch(/Invalid JSON/);
  });

  it("converts table -> JSON -> table without loss", () => {
    const pairs = [
      { key: "PORT", value: "3000" },
      { key: "MSG", value: 'quote " and \\ backslash\nnewline' },
    ];
    expect(parseEnvJson(toEnvJson(pairs)).pairs).toEqual(pairs);
  });
});

describe("references", () => {
  it("resolves service references and reports missing ones", () => {
    const { resolved, missing } = resolveReferences(
      { URL: "${{db.DATABASE_URL}}", P: "${{ api.PORT }}", X: "${{nope.KEY}}", PLAIN: "x" },
      (s) => (({ db: { DATABASE_URL: "postgres://x" }, api: { PORT: "3000" } }) as Record<string, Record<string, string>>)[s],
    );
    expect(resolved).toEqual({ URL: "postgres://x", P: "3000", X: "", PLAIN: "x" });
    expect(missing).toEqual(["nope.KEY"]);
  });
});

describe("rbac", () => {
  it("applies role defaults", () => {
    expect(can("owner", "team:delete")).toBe(true);
    expect(can("admin", "team:delete")).toBe(false);
    expect(can("viewer", "deploy:create")).toBe(false);
    expect(can("viewer", "project:read")).toBe(true);
    expect(can("member", "env:read_secret")).toBe(false);
    expect(can("developer", "shell:access")).toBe(true);
  });
  it("applies team overrides but never grants ownership powers", () => {
    const perms = permissionsFor("viewer", { viewer: { grant: ["deploy:create", "team:delete"] } });
    expect(perms.has("deploy:create")).toBe(true);
    expect(perms.has("team:delete")).toBe(false);
    expect(permissionsFor("owner", { owner: { revoke: ["team:delete"] } }).has("team:delete")).toBe(true);
  });
  it("limits api key scopes", () => {
    expect(scopeAllows(["read"], "deploy:create")).toBe(false);
    expect(scopeAllows(["deploy"], "deploy:create")).toBe(true);
    expect(scopeAllows(["deploy"], "env:write")).toBe(false);
  });
});

describe("crypto", () => {
  const ring = parseKeyring(`k1:${generateMasterKey()}`);
  it("encrypts with AES-256-GCM and detects tampering", () => {
    const env = encrypt("s3cret", ring);
    expect(env.startsWith("v1:k1:")).toBe(true);
    expect(decrypt(env, ring)).toBe("s3cret");
    const parts = env.split(":");
    parts[4] = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(parts.join(":"), ring)).toThrow();
  });
  it("supports key rotation", () => {
    const old = encrypt("value", ring);
    const rotated = parseKeyring(`k2:${generateMasterKey()},k1:${Buffer.from(ring.keys.get("k1")!).toString("base64")}`);
    expect(decrypt(old, rotated)).toBe("value");
    const re = reencrypt(old, rotated)!;
    expect(re.split(":")[1]).toBe("k2");
    expect(decrypt(re, rotated)).toBe("value");
  });
  it("encrypts buffers", () => {
    const data = Buffer.from("backup-bytes".repeat(1000));
    expect(decryptBuffer(encryptBuffer(data, ring), ring).equals(data)).toBe(true);
  });
});

describe("ssrf", () => {
  it("flags private and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("rejects internal URLs", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost:3000")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("http://user:pass@8.8.8.8/")).rejects.toThrow();
    await expect(assertPublicUrl("http://8.8.8.8/")).resolves.toBeTruthy();
  });

  it("safeFetch blocks private targets, never follows redirects, and reads the body", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      // A user-supplied URL pointing at a private address is refused outright.
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      // allowHosts reaches a known host (here the loopback test server); the body is returned.
      const ok = await safeFetch(`http://localhost:${port}/`, { allowHosts: ["localhost"] });
      expect(ok.status).toBe(200);
      expect(ok.text()).toBe("hello");
      // A redirect to an internal address is returned as-is, not followed.
      const red = await safeFetch(`http://localhost:${port}/redirect`, { allowHosts: ["localhost"] });
      expect(red.status).toBe(302);
      expect(red.ok).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("redaction", () => {
  it("removes known secrets and credential patterns", () => {
    const line = "connect postgres://app:hunter22@db:5432/x token=abcdef123456 Bearer abcdefghijklmnop MYSECRETVALUE";
    const out = redact(line, ["MYSECRETVALUE"]);
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("MYSECRETVALUE");
    expect(out).toContain(REDACTED);
    expect(redact("normal task_runner output")).toBe("normal task_runner output");
  });
});

describe("format", () => {
  it("slugifies", () => {
    expect(slugify("Mon Projet Été!")).toBe("mon-projet-ete");
    expect(slugify("---")).toBe("app");
  });
});
