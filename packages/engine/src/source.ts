import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl from "yauzl";
import { assertPublicUrl, redact } from "@skyhost/shared/node";
import { engineConfig } from "./config";

export class SourceError extends Error {}

export async function makeWorkDir(prefix: string): Promise<string> {
  const base = engineConfig().workDir;
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, `${prefix.replace(/[^a-z0-9-]/gi, "")}-`));
}

export async function removeWorkDir(dir: string) {
  const base = resolve(engineConfig().workDir);
  const target = resolve(dir);
  // Never delete anything outside the engine work directory.
  if (!target.startsWith(base + sep)) throw new Error("Refusing to delete outside the work directory");
  await rm(target, { recursive: true, force: true });
}

export interface CommitInfo {
  sha: string;
  author: string;
  message: string;
}

/**
 * Minimal environment for git. Optional settings are passed only when set: an empty GIT_SSL_CAINFO makes git look
 * for a CA bundle at an empty path ("Problem with the SSL CA cert") instead of using the system certificates.
 */
export function gitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: source.PATH, HOME: source.HOME ?? "/tmp", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "GIT_SSL_CAINFO", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (source[k]) env[k] = source[k];
  }
  return env;
}

function runGit(args: string[], opts: { cwd?: string; timeoutMs?: number; secrets?: string[]; onLine?: (l: string) => void } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SourceError("git timed out"));
    }, opts.timeoutMs ?? 300_000);
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString();
      err += s;
      for (const l of s.split(/\r?\n|\r/)) if (l.trim()) opts.onLine?.(redact(l, opts.secrets));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new SourceError(redact(err.trim().split("\n").slice(-3).join("\n") || `git exited with ${code}`, opts.secrets)));
    });
  });
}

export function authenticatedUrl(url: string, token?: string | null, username = "x-access-token"): string {
  if (!token) return url;
  const u = new URL(url);
  u.username = username;
  u.password = token;
  return u.toString();
}

/**
 * Shallow clones a repository into a fresh work directory. Symlinks are checked out as plain files so that a
 * malicious repository cannot make SKYHOST read files outside the checkout.
 */
export async function cloneRepository(opts: {
  url: string;
  branch?: string | null;
  commit?: string | null;
  token?: string | null;
  tokenUsername?: string;
  onLine?: (l: string) => void;
  depth?: number;
}): Promise<{ dir: string; workDir: string; commit: CommitInfo }> {
  const cfg = engineConfig();
  const isLocal = /^(file:|\/)/.test(opts.url) || opts.url.startsWith("git://127.0.0.1");
  if (isLocal) {
    if (!cfg.allowLocalGit) throw new SourceError("Local repositories are not allowed");
  } else {
    await assertPublicUrl(opts.url, { protocols: ["https:"] }).catch((e) => {
      throw new SourceError(`Repository URL rejected: ${(e as Error).message}`);
    });
  }
  const dir = await makeWorkDir("src");
  const checkout = join(dir, "repo");
  const url = authenticatedUrl(opts.url, opts.token, opts.tokenUsername);
  const secrets = opts.token ? [opts.token] : [];
  const base = ["-c", "core.symlinks=false", "-c", "submodule.recurse=false", "-c", "advice.detachedHead=false", "-c", `protocol.file.allow=${isLocal ? "always" : "never"}`];
  try {
    opts.onLine?.(`Cloning ${redact(opts.url, secrets)}${opts.branch ? ` (branch ${opts.branch})` : ""}`);
    const args = [...base, "clone", "--no-tags", "--single-branch", `--depth=${opts.commit ? 50 : (opts.depth ?? 1)}`];
    if (opts.branch) args.push("--branch", opts.branch);
    args.push("--", url, checkout);
    await runGit(args, { secrets, onLine: opts.onLine });
    if (opts.commit) {
      if (!/^[0-9a-f]{7,40}$/i.test(opts.commit)) throw new SourceError("Invalid commit SHA");
      try {
        await runGit([...base, "checkout", "--quiet", opts.commit], { cwd: checkout, secrets });
      } catch {
        await runGit([...base, "fetch", "--depth=1", "origin", opts.commit], { cwd: checkout, secrets, onLine: opts.onLine });
        await runGit([...base, "checkout", "--quiet", "FETCH_HEAD"], { cwd: checkout, secrets });
      }
    }
    const log = await runGit(["log", "-1", "--format=%H%n%an%n%s"], { cwd: checkout });
    const [sha = "", author = "", message = ""] = log.trim().split("\n");
    // Remove credentials from the stored remote.
    await runGit(["remote", "set-url", "origin", opts.url.startsWith("/") ? opts.url : redactCreds(opts.url)], { cwd: checkout }).catch(() => {});
    opts.onLine?.(`Checked out ${sha.slice(0, 7)} by ${author}: ${message}`);
    return { dir: checkout, workDir: dir, commit: { sha, author, message } };
  } catch (e) {
    await removeWorkDir(dir).catch(() => {});
    throw e instanceof SourceError ? e : new SourceError((e as Error).message);
  }
}

function redactCreds(url: string) {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** Lists remote branches (used when the provider API is not available, e.g. plain git URLs). */
export async function listRemoteBranches(url: string, token?: string | null): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const local = url.startsWith("/") || url.startsWith("file:");
  if (!(local && engineConfig().allowLocalGit)) await assertPublicUrl(url, { protocols: ["https:"] });
  const out = await runGit(["ls-remote", "--symref", authenticatedUrl(url, token), "HEAD", "refs/heads/*"], { secrets: token ? [token] : [], timeoutMs: 30_000 });
  const defaultBranch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(out)?.[1] ?? null;
  const branches = [...out.matchAll(/^[0-9a-f]+\s+refs\/heads\/(\S+)$/gm)].map((m) => m[1]!);
  return { branches, defaultBranch };
}

// ---------------------------------------------------------------------------------------------------------------
// ZIP uploads
// ---------------------------------------------------------------------------------------------------------------

export interface ZipLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxFiles: number;
  maxRatio: number;
  maxFileBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxCompressedBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 500 * 1024 * 1024,
  maxFiles: 20_000,
  maxRatio: 100,
  maxFileBytes: 100 * 1024 * 1024,
};

export class ZipError extends SourceError {}

/** Validates a path from an archive: relative, normalized, no traversal, no absolute or drive paths. */
export function safeArchivePath(name: string): string | null {
  if (name.includes("\0")) return null;
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  if (parts[0] === "__MACOSX") return null;
  return parts.join("/");
}

/**
 * Extracts a ZIP into a fresh directory with zip bomb protection (entry count, per-file size, total size and
 * compression ratio enforced on the actual inflated bytes), path traversal protection and no symlinks.
 * If every file sits in a single top-level folder, that folder becomes the root.
 */
export async function extractZip(zipPath: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<{ dir: string; workDir: string; files: number; bytes: number }> {
  const st = await stat(zipPath);
  if (st.size > limits.maxCompressedBytes) throw new ZipError(`Archive is larger than ${Math.round(limits.maxCompressedBytes / 1048576)} MB`);
  const workDir = await makeWorkDir("zip");
  const root = join(workDir, "repo");
  await mkdir(root, { recursive: true });
  let files = 0;
  let total = 0;
  try {
    await new Promise<void>((resolveP, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
        if (err || !zip) return reject(new ZipError(`Invalid ZIP archive: ${err?.message ?? "unknown"}`));
        const fail = (e: Error) => {
          zip.close();
          reject(e);
        };
        zip.on("error", (e: Error) => fail(new ZipError(/relative path|absolute path|invalid characters/.test(e.message) ? `Unsafe path in archive: ${e.message}` : e.message)));
        zip.on("end", () => resolveP());
        zip.on("entry", (entry: yauzl.Entry) => {
          const rel = safeArchivePath(entry.fileName);
          if (rel === null) return fail(new ZipError(`Unsafe path in archive: ${entry.fileName}`));
          if (!rel) return zip.readEntry();
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) return fail(new ZipError(`Symbolic links are not allowed: ${entry.fileName}`));
          const target = resolve(root, normalize(rel));
          if (target !== root && !target.startsWith(root + sep)) return fail(new ZipError(`Path escapes archive root: ${entry.fileName}`));
          if (/\/$/.test(entry.fileName)) {
            mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
            return;
          }
          files++;
          if (files > limits.maxFiles) return fail(new ZipError(`Archive contains more than ${limits.maxFiles} files`));
          if (entry.uncompressedSize > limits.maxFileBytes) return fail(new ZipError(`File too large: ${rel}`));
          if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxRatio && entry.uncompressedSize > 1024 * 1024) {
            return fail(new ZipError(`Suspicious compression ratio for ${rel} (possible zip bomb)`));
          }
          zip.openReadStream(entry, async (e2, rs) => {
            if (e2 || !rs) return fail(new ZipError(e2?.message ?? "read error"));
            let entryBytes = 0;
            const counter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                entryBytes += chunk.length;
                total += chunk.length;
                if (entryBytes > limits.maxFileBytes) return cb(new ZipError(`File too large: ${rel}`));
                if (total > limits.maxUncompressedBytes) return cb(new ZipError("Archive expands beyond the allowed size (possible zip bomb)"));
                cb(null, chunk);
              },
            });
            try {
              await mkdir(dirname(target), { recursive: true });
              await pipeline(rs, counter, createWriteStream(target, { mode: 0o644, flags: "wx" }));
              zip.readEntry();
            } catch (e3) {
              fail(e3 instanceof ZipError ? e3 : new ZipError((e3 as Error).message));
            }
          });
        });
        zip.readEntry();
      });
    });
  } catch (e) {
    await removeWorkDir(workDir).catch(() => {});
    throw e;
  }
  // GitHub style archives wrap everything in one folder: use it as the root.
  const top = (await readdir(root, { withFileTypes: true })).filter((e) => e.name !== ".DS_Store");
  const dir = top.length === 1 && top[0]!.isDirectory() ? join(root, top[0]!.name) : root;
  return { dir, workDir, files, bytes: total };
}
