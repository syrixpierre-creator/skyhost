import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import yazl from "yazl";
import { createWriteStream } from "node:fs";
import { generateMasterKey, parseKeyring, setKeyring } from "@skyhost/shared/node";
import { buildTraefikConfig, extractZip, FsObjectStore, gitEnv, parseCommand, safeArchivePath, setEngineConfig, validateCommand, serializeBuildEnv } from "../src";

beforeAll(async () => {
  setKeyring(parseKeyring(`k1:${generateMasterKey()}`));
  setEngineConfig({ workDir: await mkdtemp(join(tmpdir(), "sh-engine-")) });
});

function makeZip(entries: Array<{ name: string; data?: Buffer; symlink?: boolean; compress?: boolean }>): Promise<string> {
  return new Promise(async (resolve) => {
    const dir = await mkdtemp(join(tmpdir(), "sh-zip-"));
    const path = join(dir, "a.zip");
    const z = new yazl.ZipFile();
    for (const e of entries) {
      if (e.symlink) z.addBuffer(e.data ?? Buffer.from("/etc/passwd"), e.name, { mode: 0o120777 });
      else z.addBuffer(e.data ?? Buffer.from("x"), e.name, { compress: e.compress ?? true });
    }
    z.end();
    z.outputStream.pipe(createWriteStream(path)).on("close", () => resolve(path));
  });
}

describe("ZIP upload safety", () => {
  it("normalizes safe paths and rejects traversal", () => {
    expect(safeArchivePath("a/./b/c.txt")).toBe("a/b/c.txt");
    expect(safeArchivePath("../etc/passwd")).toBeNull();
    expect(safeArchivePath("a/../../x")).toBeNull();
    expect(safeArchivePath("/abs")).toBeNull();
    expect(safeArchivePath("C:\\windows")).toBeNull();
  });

  it("extracts a normal archive and unwraps a single top folder", async () => {
    const zip = await makeZip([{ name: "proj/package.json", data: Buffer.from("{}") }, { name: "proj/src/index.js" }]);
    const r = await extractZip(zip);
    expect(r.files).toBe(2);
    expect(await readFile(join(r.dir, "package.json"), "utf8")).toBe("{}");
  });

  it("rejects path traversal entries", async () => {
    const zip = await makeZip([{ name: "ok.txt" }]);
    // yazl refuses "../" names, so patch the stored name in the archive bytes (same length).
    const buf = await readFile(zip);
    const patched = Buffer.from(buf.toString("latin1").replaceAll("ok.txt", "../a.t"), "latin1");
    await writeFile(zip, patched);
    await expect(extractZip(zip)).rejects.toThrow(/Unsafe path/);
  });

  it("rejects symlinks", async () => {
    const zip = await makeZip([{ name: "link", symlink: true }]);
    await expect(extractZip(zip)).rejects.toThrow(/Symbolic links/);
  });

  it("stops zip bombs by ratio and by total inflated size", async () => {
    const bomb = await makeZip([{ name: "big.bin", data: Buffer.alloc(20 * 1024 * 1024) }]);
    await expect(extractZip(bomb)).rejects.toThrow(/zip bomb/);
    const many = await makeZip([{ name: "a.bin", data: Buffer.alloc(3 * 1024 * 1024, 1), compress: false }, { name: "b.bin", data: Buffer.alloc(3 * 1024 * 1024, 2), compress: false }]);
    await expect(extractZip(many, { maxCompressedBytes: 1e9, maxUncompressedBytes: 5 * 1024 * 1024, maxFiles: 100, maxRatio: 100, maxFileBytes: 1e9 })).rejects.toThrow(/allowed size/);
  });

  it("limits the number of files", async () => {
    const zip = await makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}` })));
    await expect(extractZip(zip, { maxCompressedBytes: 1e9, maxUncompressedBytes: 1e9, maxFiles: 3, maxRatio: 100, maxFileBytes: 1e9 })).rejects.toThrow(/more than 3 files/);
  });
});

describe("secure shell", () => {
  it("parses quotes and rejects metacharacters", () => {
    expect(parseCommand(`ls -la "my dir" 'x y'`)).toEqual(["ls", "-la", "my dir", "x y"]);
    for (const bad of ["ls; rm -rf /", "cat a | sh", "echo $(id)", "ls && id", "echo `id`", "cat > x", "ls\nid"]) {
      expect(() => parseCommand(bad), bad).toThrow();
    }
  });
  it("enforces the allowlist per runtime", () => {
    expect(validateCommand("node --version", "node")).toEqual(["node", "--version"]);
    expect(validateCommand("npm run build", "node")).toEqual(["npm", "run", "build"]);
    expect(validateCommand("python manage.py migrate", "python")).toEqual(["python", "manage.py", "migrate"]);
    expect(() => validateCommand("rm -rf /", "node")).toThrow(/not in the allowed/);
    expect(() => validateCommand("/bin/sh", "node")).toThrow();
    expect(() => validateCommand("npm publish", "node")).toThrow();
    expect(() => validateCommand("curl http://169.254.169.254/latest/meta-data", "node")).toThrow(/metadata/);
    expect(() => validateCommand("find / -exec id", "node")).toThrow();
    expect(() => validateCommand("python -c 1", "node")).toThrow();
  });
});

describe("proxy config", () => {
  const opts = { apiUrl: "http://api:4000", httpEntryPoint: "web", httpsEntryPoint: "websecure", tlsEnabled: true, internalToken: "t" };
  it("routes to the live deployment with https redirect and middlewares", () => {
    const cfg = buildTraefikConfig(
      [{ id: "svc1", hosts: ["app-x.skyhost.app", "example.com"], backends: [{ deploymentId: "d1", weight: 100, servers: ["http://c1:3000"] }], tls: true, certResolver: "le", basicAuthUsers: ["u:$2y$hash"], ipAllowlist: ["1.2.3.4/32"], rateLimitPerMinute: 600 }],
      opts,
    ) as { http: { routers: Record<string, { rule: string; middlewares: string[]; tls?: unknown; service: string }>; services: Record<string, unknown>; middlewares: Record<string, unknown> } };
    const r = cfg.http.routers.svc1!;
    expect(r.rule).toBe("Host(`app-x.skyhost.app`) || Host(`example.com`)");
    expect(r.middlewares).toEqual(["sh-security-headers", "svc1-ip", "svc1-auth", "svc1-rl"]);
    expect(r.tls).toEqual({ certResolver: "le" });
    expect(cfg.http.routers["svc1-http"]!.middlewares).toEqual(["sh-https-redirect"]);
    expect(cfg.http.services["svc1-svc"]).toMatchObject({ loadBalancer: { servers: [{ url: "http://c1:3000" }] } });
  });
  it("splits canary traffic with weights and routes sleeping services to the waker", () => {
    const cfg = buildTraefikConfig(
      [
        { id: "a", hosts: ["a.x"], backends: [{ deploymentId: "old", weight: 90, servers: ["http://o:1"] }, { deploymentId: "new", weight: 10, servers: ["http://n:1"] }], tls: false },
        { id: "b", hosts: ["b.x"], backends: [], tls: false, sleeping: true },
      ],
      { ...opts, tlsEnabled: false },
    ) as { http: { routers: Record<string, { service: string }>; services: Record<string, { weighted?: { services: Array<{ weight: number }> } }> } };
    expect(cfg.http.services["a-svc"]!.weighted!.services.map((s) => s.weight)).toEqual([90, 10]);
    expect(cfg.http.routers.b!.service).toBe("sh-api");
  });
  it("sends a service in maintenance to the API maintenance page, even with live backends", () => {
    const cfg = buildTraefikConfig(
      [{ id: "m", hosts: ["m.x"], backends: [{ deploymentId: "d", weight: 100, servers: ["http://c:1"] }], tls: false, kind: "maintenance", headers: { "X-Skyhost-Service-Id": "s1" } }],
      { ...opts, tlsEnabled: false },
    ) as { http: { routers: Record<string, { service: string; middlewares: string[] }>; middlewares: Record<string, { addPrefix?: { prefix: string }; headers?: { customRequestHeaders: Record<string, string> } }> } };
    const r = cfg.http.routers.m!;
    expect(r.service).toBe("sh-api");
    expect(r.middlewares).toEqual(["sh-security-headers", "m-hdr", "m-route", "sh-maintenance-prefix"]);
    expect(cfg.http.middlewares["sh-maintenance-prefix"]!.addPrefix!.prefix).toBe("/internal/maintenance");
    expect(cfg.http.middlewares["m-route"]!.headers!.customRequestHeaders["X-Skyhost-Token"]).toBe("t");
  });
});

describe("object store", () => {
  it("encrypts objects at rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "sh-obj-"));
    const s = new FsObjectStore(root);
    await s.put("backups/a.dump", Buffer.from("PLAINTEXT-DATA"));
    expect((await readFile(join(root, "backups/a.dump"))).includes("PLAINTEXT-DATA")).toBe(false);
    expect((await s.get("backups/a.dump")).toString()).toBe("PLAINTEXT-DATA");
    await expect(s.put("../escape", Buffer.from("x"))).rejects.toThrow();
  });
});

describe("build env", () => {
  it("quotes values safely for the BuildKit secret file", () => {
    expect(serializeBuildEnv({ A: "it's", "BAD-KEY": "x", B: "$(id)" })).toBe("A='it'\\''s'\nB='$(id)'\n");
  });
});

describe("git environment", () => {
  // An empty GIT_SSL_CAINFO is not "unset" for git: it fails every HTTPS clone with "Problem with the SSL CA cert".
  it("passes optional TLS and proxy settings only when they are set", () => {
    const env = gitEnv({ PATH: "/usr/bin", HOME: "/home/node", GIT_SSL_CAINFO: "", HTTPS_PROXY: "" });
    expect(env).not.toHaveProperty("GIT_SSL_CAINFO");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(env).toMatchObject({ PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" });
    expect(gitEnv({ PATH: "/usr/bin", GIT_SSL_CAINFO: "/etc/ssl/ca.pem" }).GIT_SSL_CAINFO).toBe("/etc/ssl/ca.pem");
  });

});

describe("wildcard certificate", () => {
  it("routes can ask for one shared base + *.base certificate", () => {
    const cfg = buildTraefikConfig(
      [{ id: "a", hosts: ["web-1.skyhost.tech"], backends: [{ deploymentId: "d", weight: 100, servers: ["http://c:80"] }], tls: true, certResolver: "letsencrypt-dns", tlsDomains: [{ main: "skyhost.tech", sans: ["*.skyhost.tech"] }] }],
      { apiUrl: "http://api:4000", httpEntryPoint: "web", httpsEntryPoint: "websecure", tlsEnabled: true, internalToken: "t" },
    );
    expect((cfg as { http: { routers: Record<string, { tls: unknown }> } }).http.routers.a!.tls).toEqual({ certResolver: "letsencrypt-dns", domains: [{ main: "skyhost.tech", sans: ["*.skyhost.tech"] }] });
  });
});
