import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { RepoFS } from "./types";

const MAX_FILE = 512 * 1024;

/** RepoFS backed by a local directory. Refuses paths escaping the root and never follows symlinks out of it. */
export function localFS(root: string): RepoFS {
  const base = resolve(root);
  const safe = (p: string) => {
    const full = resolve(base, normalize(p).replace(/^([/\\])+/, ""));
    if (full !== base && !full.startsWith(base + sep)) throw new Error("Path escapes repository root");
    return full;
  };
  return {
    async readFile(p) {
      try {
        const full = safe(p);
        const st = await lstat(full);
        if (!st.isFile() || st.size > MAX_FILE) return null;
        return await readFile(full, "utf8");
      } catch {
        return null;
      }
    },
    async exists(p) {
      try {
        await stat(safe(p));
        return true;
      } catch {
        return false;
      }
    },
    async list(dir) {
      try {
        const entries = await readdir(safe(dir), { withFileTypes: true });
        return entries.filter((e) => !e.isSymbolicLink()).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      } catch {
        return [];
      }
    },
  };
}

/** In-memory RepoFS, handy for tests and for analyzing files fetched from a provider API. */
export function memoryFS(files: Record<string, string>): RepoFS {
  const norm = (p: string) => (p === "." ? "" : p.replace(/^\.?\/+/, "").replace(/\/+$/, ""));
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    async readFile(p) {
      return map.get(norm(p)) ?? null;
    },
    async exists(p) {
      const n = norm(p);
      if (map.has(n)) return true;
      for (const k of map.keys()) if (n === "" || k.startsWith(n + "/")) return true;
      return false;
    },
    async list(dir) {
      const d = norm(dir);
      const out = new Set<string>();
      for (const k of map.keys()) {
        if (d && !k.startsWith(d + "/")) continue;
        const rest = d ? k.slice(d.length + 1) : k;
        const [head, ...tail] = rest.split("/");
        out.add(tail.length ? `${head}/` : head!);
      }
      return [...out];
    },
  };
}

/** Scoped view of a RepoFS rooted at a sub directory (used for monorepo packages). */
export function subFS(fs: RepoFS, dir: string): RepoFS {
  const d = dir.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (!d || d === ".") return fs;
  const j = (p: string) => join(d, p.replace(/^\/+/, ""));
  return {
    readFile: (p) => fs.readFile(j(p)),
    exists: (p) => fs.exists(j(p)),
    list: (p) => fs.list(j(p)),
  };
}

export const IGNORED_DIRS = new Set([
  "node_modules/", ".git/", "vendor/", "dist/", "build/", "target/", ".next/", ".nuxt/", "out/", "__pycache__/",
  ".venv/", "venv/", "env/", ".idea/", ".vscode/", "coverage/", ".turbo/", ".cache/", "storage/", "bin/", "obj/",
]);

/** Walks source files (bounded) for code scanning. */
export async function walkSources(fs: RepoFS, exts: string[], limit = 400, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<[string, number]> = [["", 0]];
  while (queue.length && out.length < limit) {
    const [dir, depth] = queue.shift()!;
    const entries = await fs.list(dir || ".");
    for (const e of entries.sort()) {
      if (e.endsWith("/")) {
        if (!IGNORED_DIRS.has(e) && !e.startsWith(".") && depth < maxDepth) queue.push([dir ? `${dir}/${e.slice(0, -1)}` : e.slice(0, -1), depth + 1]);
      } else if (exts.some((x) => e.endsWith(x))) {
        out.push(dir ? `${dir}/${e}` : e);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}
