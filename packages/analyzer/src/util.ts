import type { AnalysisResult, RepoFS } from "./types";

export function emptyResult(rootDir = "."): AnalysisResult {
  return {
    rootDir,
    runtime: "unknown",
    framework: null,
    packageManager: null,
    version: null,
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    testCommand: null,
    port: null,
    outputDirectory: null,
    serviceType: "web",
    dockerDetected: false,
    docker: null,
    databaseDetected: [],
    environmentVariables: [],
    monorepo: null,
    workspaceRoot: null,
    compose: null,
    confidence: "low",
    reasons: [],
    warnings: [],
    suggestions: [],
  };
}

export async function readJson<T = Record<string, unknown>>(fs: RepoFS, path: string): Promise<T | null> {
  const raw = await fs.readFile(path);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function firstExisting(fs: RepoFS, paths: string[]): Promise<string | null> {
  for (const p of paths) if (await fs.exists(p)) return p;
  return null;
}

/** Finds a TCP port number in common listen patterns. Returns the first plausible match. */
export function findPortInCode(code: string): number | null {
  const patterns = [
    /PORT["'\])]*\s*(?:\|\||\?\?|or)\s*["']?(\d{2,5})/, // process.env.PORT || 3000 / os.getenv("PORT") or 8000
    /getenv\(\s*["']PORT["']\s*,\s*["']?(\d{2,5})/i, // os.getenv("PORT", "8000")
    /\.listen\(\s*(\d{2,5})/, // app.listen(3000)
    /port\s*[:=]\s*(\d{2,5})\b/i, // port: 8080 / port=5000
    /["'](?:0\.0\.0\.0|127\.0\.0\.1|localhost)?:(\d{2,5})["']/, // ":8080" / "0.0.0.0:3000"
    /(?:0\.0\.0\.0|127\.0\.0\.1|localhost)[:,]\s*(\d{2,5})/, // ([0, 0, 0, 0], 3000) style or host:port
    /SocketAddr::from\(\(\[[\d,\s]+\],\s*(\d{2,5})\)\)/,
  ];
  for (const re of patterns) {
    const m = re.exec(code);
    if (m) {
      const n = Number(m[1]);
      if (n >= 80 && n <= 65535) return n;
    }
  }
  return null;
}

/** Detects code binding only on loopback, which is unreachable from the proxy. */
export function findLoopbackBind(code: string): string | null {
  const m =
    /\.listen\([^)]*["'](localhost|127\.0\.0\.1)["']/.exec(code) ??
    /host\s*=\s*["'](localhost|127\.0\.0\.1)["']/.exec(code) ??
    /["'](127\.0\.0\.1|localhost):\d{2,5}["']/.exec(code) ??
    /--host[ =](127\.0\.0\.1|localhost)\b/.exec(code);
  return m ? m[1]! : null;
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
