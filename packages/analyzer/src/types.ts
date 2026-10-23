export type Runtime = "node" | "python" | "go" | "rust" | "php" | "java" | "docker" | "static" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface DetectedDatabase {
  engine: "postgres" | "mariadb" | "mongodb" | "redis";
  reason: string;
  /** Variable the code expects, when known (e.g. DATABASE_URL). */
  variable?: string;
}

export interface DetectedVariable {
  key: string;
  defaultValue?: string;
  required: boolean;
  source: string;
}

export interface DockerInfo {
  path: string;
  from: string[];
  expose: number[];
  cmd?: string;
  entrypoint?: string;
  env: Record<string, string>;
  user?: string;
}

export interface ComposeService {
  name: string;
  image?: string;
  build?: { context: string; dockerfile?: string };
  ports: number[];
  environment: Record<string, string>;
  dependsOn: string[];
  /** Set when the image looks like a database SKYHOST can provide as a managed database. */
  managedDatabase?: DetectedDatabase["engine"];
  command?: string;
}

export interface AnalysisResult {
  rootDir: string;
  runtime: Runtime;
  framework: string | null;
  packageManager: string | null;
  version: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  testCommand: string | null;
  port: number | null;
  outputDirectory: string | null;
  serviceType: "web" | "static" | "worker";
  dockerDetected: boolean;
  docker: DockerInfo | null;
  databaseDetected: DetectedDatabase[];
  environmentVariables: DetectedVariable[];
  monorepo: MonorepoInfo | null;
  /** For JS workspaces: dependencies are installed from this directory (the repo root), then commands run in rootDir. */
  workspaceRoot: string | null;
  compose: ComposeService[] | null;
  confidence: Confidence;
  /** Plain-language explanation, one sentence per decision. */
  reasons: string[];
  warnings: string[];
  /** Suggested code changes (e.g. bind on 0.0.0.0). */
  suggestions: Array<{ file: string; message: string; find?: string; replace?: string }>;
}

export interface MonorepoInfo {
  tool: string;
  packages: Array<{ path: string; name: string; deployable: boolean; analysis?: AnalysisResult }>;
}

/** Minimal read-only filesystem abstraction so the analyzer can run on a clone, an extracted ZIP or an API listing. */
export interface RepoFS {
  readFile(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Lists entry names of a directory (files and dirs). Directories end with "/". */
  list(dir: string): Promise<string[]>;
}
