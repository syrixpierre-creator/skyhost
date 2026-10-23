import { execInContainer } from "./docker";

/**
 * Secure shell: every command is parsed into argv (no shell interpretation), checked against an allowlist
 * that depends on the service runtime, and executed inside the service container as its non-root user.
 */

const BASE = ["ls", "cat", "head", "tail", "pwd", "env", "whoami", "id", "df", "du", "ps", "uptime", "date", "echo", "find", "grep", "wc", "stat", "which", "free", "top", "printenv", "curl", "wget", "nslookup", "ping"];

const BY_RUNTIME: Record<string, string[]> = {
  node: ["node", "npm", "npx", "pnpm", "yarn", "bun", "bunx"],
  python: ["python", "python3", "pip", "pip3", "poetry", "uv", "alembic", "flask", "django-admin", "celery"],
  go: ["go"],
  rust: ["cargo"],
  php: ["php", "composer"],
  java: ["java", "mvn", "gradle"],
};

/** Sub-commands allowed for package managers (anything that does not touch the host and is useful for debugging). */
const SUBCOMMANDS: Record<string, string[]> = {
  npm: ["--version", "-v", "install", "ci", "run", "ls", "list", "outdated", "view", "test", "start", "exec", "rebuild", "prune", "config"],
  pnpm: ["--version", "-v", "install", "run", "ls", "list", "outdated", "exec", "test", "start", "why"],
  yarn: ["--version", "-v", "install", "run", "list", "why", "test", "start"],
  pip: ["--version", "install", "list", "show", "freeze", "check"],
  pip3: ["--version", "install", "list", "show", "freeze", "check"],
};

const ALWAYS_ALLOWED_PAIRS = [/^python3? manage\.py (migrate|showmigrations|check|collectstatic|createsuperuser|shell)\b/, /^php artisan (migrate|cache:clear|config:cache|route:list|queue:work|db:seed|tinker)\b/, /^npx (prisma|drizzle-kit|sequelize|knex|typeorm) /];

const FORBIDDEN_CHARS = /[;&|`$<>\\\n\r(){}]/;

export class ShellRejected extends Error {}

/** Splits a command line into arguments, honouring single and double quotes. Rejects shell metacharacters. */
export function parseCommand(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) throw new ShellRejected("Empty command");
  if (trimmed.length > 2000) throw new ShellRejected("Command is too long");
  const args: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (FORBIDDEN_CHARS.test(ch)) throw new ShellRejected(`Character "${ch}" is not allowed (pipes, redirections and command chaining are disabled)`);
    if (/\s/.test(ch)) {
      if (hasToken) args.push(cur);
      cur = "";
      hasToken = false;
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (quote) throw new ShellRejected("Unterminated quote");
  if (hasToken) args.push(cur);
  return args;
}

export function allowedCommands(runtime: string | null | undefined): string[] {
  return [...BASE, ...(BY_RUNTIME[runtime ?? ""] ?? Object.values(BY_RUNTIME).flat())];
}

export function validateCommand(line: string, runtime: string | null | undefined): string[] {
  const argv = parseCommand(line);
  const bin = argv[0]!;
  if (bin.includes("/")) throw new ShellRejected("Use command names, not paths");
  const joined = argv.join(" ");
  if (ALWAYS_ALLOWED_PAIRS.some((re) => re.test(joined))) return argv;
  if (!allowedCommands(runtime).includes(bin)) throw new ShellRejected(`"${bin}" is not in the allowed command list for this service`);
  const subs = SUBCOMMANDS[bin];
  if (subs && argv[1] && !subs.includes(argv[1])) throw new ShellRejected(`"${bin} ${argv[1]}" is not allowed`);
  if ((bin === "curl" || bin === "wget") && argv.some((a) => /169\.254\.|metadata\.google|100\.100\.100\.200/.test(a))) throw new ShellRejected("Access to cloud metadata endpoints is blocked");
  if (bin === "env" && argv.length > 1) throw new ShellRejected("env only prints variables here");
  if (bin === "find" && argv.some((a) => a === "-exec" || a === "-execdir" || a === "-delete" || a === "-ok")) throw new ShellRejected("find actions are disabled");
  return argv;
}

export async function runShellCommand(container: string, line: string, runtime: string | null | undefined, opts: { timeoutMs?: number; cwd?: string } = {}) {
  const argv = validateCommand(line, runtime);
  return execInContainer(container, argv, { timeoutMs: opts.timeoutMs ?? 120_000, workingDir: opts.cwd, maxOutput: 2 * 1024 * 1024 });
}
