import type { AnalysisResult } from "./types";

export interface BuildPlanInput {
  runtime: AnalysisResult["runtime"];
  version?: string | null;
  packageManager?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
  rootDir?: string;
  workspaceRoot?: string | null;
  serviceType: "web" | "static" | "worker" | "cron" | "private" | "job" | "docker";
  port?: number | null;
  spaFallback?: boolean;
  /** Isolates BuildKit cache mounts per service so tenants never share caches. */
  cacheKey: string;
}

export interface BuildPlan {
  dockerfile: string;
  /** Extra files written into the build context under .skyhost/ */
  files: Record<string, string>;
  /** Directory (relative to the repository) used as the Docker build context. */
  context: string;
  /** Port the resulting image listens on. */
  port: number | null;
}

export class BuildPlanError extends Error {}

/** Commands are embedded in exec-form JSON, so they can never inject Dockerfile instructions. */
function run(cmd: string, mounts: string[] = []): string {
  if (/[\r\n]/.test(cmd)) throw new BuildPlanError("Commands must be a single line");
  const m = mounts.map((x) => `--mount=${x} `).join("");
  return `RUN ${m}${JSON.stringify(["/bin/sh", "-c", cmd])}`;
}

/**
 * User commands (install/build) get the service variables through a BuildKit secret mount: values are available
 * while the command runs but are never written into an image layer.
 */
export const BUILD_ENV_SECRET = "skyhost_env";
function runUser(cmd: string, mounts: string[] = []): string {
  const withEnv = `if [ -f /run/secrets/${BUILD_ENV_SECRET} ]; then set -a; . /run/secrets/${BUILD_ENV_SECRET}; set +a; fi; ${cmd}`;
  return run(withEnv, [`type=secret,id=${BUILD_ENV_SECRET},required=false`, ...mounts]);
}

function cmdLine(cmd: string): string {
  if (/[\r\n]/.test(cmd)) throw new BuildPlanError("Start command must be a single line");
  return `CMD ${JSON.stringify(["/bin/sh", "-c", `exec ${cmd}`])}`;
}

const safeTag = (v: string | null | undefined, fallback: string) => (v && /^[0-9][0-9a-z.\-]*$/i.test(v) ? v : fallback);
const safePath = (p: string | null | undefined) => {
  const n = (p ?? ".").replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "") || ".";
  if (n.split("/").includes("..") || /["'$`\s]/.test(n)) throw new BuildPlanError(`Invalid path: ${p}`);
  return n;
};

export function nginxConfig(spaFallback: boolean): string {
  return `server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    server_tokens off;
    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    add_header X-Content-Type-Options nosniff always;

    location ~* \\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|wasm)$ {
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ ${spaFallback ? "/index.html" : "=404"};
    }
}
`;
}

function staticStage(from: string, outDir: string, spa: boolean): string[] {
  return [
    "FROM nginxinc/nginx-unprivileged:1.27-alpine",
    "COPY .skyhost/nginx.conf /etc/nginx/conf.d/default.conf",
    `COPY --from=${from} /app/${outDir === "." ? "" : outDir + "/"} /usr/share/nginx/html/`,
    "EXPOSE 8080",
    spa ? "# SPA fallback enabled" : "# SPA fallback disabled",
  ];
}

export function generateBuildPlan(input: BuildPlanInput): BuildPlan {
  const root = safePath(input.rootDir);
  const wsRoot = input.workspaceRoot != null ? safePath(input.workspaceRoot) : null;
  const k = input.cacheKey.replace(/[^a-zA-Z0-9_-]/g, "");
  const isStatic = input.serviceType === "static";
  const spa = input.spaFallback ?? true;
  const files: Record<string, string> = {};
  const lines: string[] = [];
  let port: number | null = input.port ?? null;
  // With a workspace root, the context is the whole repo and commands run in the package directory.
  const context = wsRoot ?? root;
  const appDir = wsRoot ? (root === "." ? "/app" : `/app/${root}`) : "/app";
  const outRel = (out: string) => {
    const o = safePath(out);
    const rel = wsRoot && root !== "." ? `${root}/${o}` : o;
    return rel === "." ? "." : rel;
  };

  switch (input.runtime) {
    case "node": {
      const v = safeTag(input.version, "22");
      const bun = input.packageManager === "bun";
      lines.push(bun ? "FROM oven/bun:1 AS build" : `FROM node:${v}-bookworm-slim AS build`, "WORKDIR /app", "ENV CI=true NEXT_TELEMETRY_DISABLED=1");
      if (input.packageManager === "pnpm" || input.packageManager === "yarn") lines.push(run("corepack enable"));
      lines.push("COPY . .");
      const cacheTarget = bun ? "/root/.bun/install/cache" : input.packageManager === "pnpm" ? "/root/.local/share/pnpm/store" : input.packageManager === "yarn" ? "/usr/local/share/.cache/yarn" : "/root/.npm";
      if (input.installCommand) lines.push(runUser(input.installCommand, [`type=cache,id=${k}-node,target=${cacheTarget}`]));
      if (appDir !== "/app") lines.push(`WORKDIR ${appDir}`);
      if (input.buildCommand) lines.push(runUser(input.buildCommand, [`type=cache,id=${k}-nodebuild,target=${appDir}/node_modules/.cache`]));
      if (isStatic) {
        lines.push("", ...staticStage("build", outRel(input.outputDirectory ?? "dist"), spa));
        files["nginx.conf"] = nginxConfig(spa);
        port = 8080;
      } else {
        if (!input.startCommand) throw new BuildPlanError("A start command is required for Node.js services");
        lines.push(
          "",
          bun ? "FROM oven/bun:1" : `FROM node:${v}-bookworm-slim`,
          "WORKDIR /app",
          "ENV NODE_ENV=production",
          "COPY --from=build --chown=1000:1000 /app /app",
          `WORKDIR ${appDir}`,
          "USER 1000",
        );
        if (input.packageManager === "pnpm" || input.packageManager === "yarn") lines.splice(lines.length - 1, 0, run("corepack enable"));
        if (port) lines.push(`ENV PORT=${port}`, `EXPOSE ${port}`);
        lines.push(cmdLine(input.startCommand));
      }
      break;
    }
    case "python": {
      const v = safeTag(input.version, "3.12");
      lines.push(
        `FROM python:${v}-slim`,
        "ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1",
        "WORKDIR /app",
        run("apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev && rm -rf /var/lib/apt/lists/*"),
        "COPY . .",
      );
      const pipCache = `type=cache,id=${k}-pip,target=/root/.cache/pip`;
      if (input.installCommand) lines.push(runUser(input.installCommand, [pipCache]));
      const start = input.startCommand ?? "";
      const servers = ["gunicorn", "uvicorn"].filter((s) => start.startsWith(s));
      if (servers.length) lines.push(run(`python -c "import ${servers[0]}" 2>/dev/null || pip install ${servers.join(" ")}`, [pipCache]));
      if (input.buildCommand) lines.push(runUser(input.buildCommand));
      if (isStatic) {
        lines.splice(0, 1, `FROM python:${v}-slim AS build`);
        lines.push("", ...staticStage("build", outRel(input.outputDirectory ?? "."), spa));
        files["nginx.conf"] = nginxConfig(spa);
        port = 8080;
        break;
      }
      lines.push(run("useradd --create-home --uid 1000 app && chown -R app:app /app"), "USER 1000");
      if (port) lines.push(`ENV PORT=${port}`, `EXPOSE ${port}`);
      if (!start) throw new BuildPlanError("A start command is required for Python services");
      lines.push(cmdLine(start));
      break;
    }
    case "go": {
      const v = safeTag(input.version, "1.23");
      lines.push(
        `FROM golang:${v}-alpine AS build`,
        "WORKDIR /src",
        "COPY . .",
        runUser(input.installCommand ?? "go mod download", [`type=cache,id=${k}-gomod,target=/go/pkg/mod`]),
        runUser(input.buildCommand ?? "CGO_ENABLED=0 go build -o /app/server .", [`type=cache,id=${k}-gomod,target=/go/pkg/mod`, `type=cache,id=${k}-gobuild,target=/root/.cache/go-build`]),
        "",
        "FROM alpine:3.20",
        run("apk add --no-cache ca-certificates tzdata && adduser -D -u 1000 app"),
        "WORKDIR /app",
        "COPY --from=build /app /app",
        "USER 1000",
      );
      if (port) lines.push(`ENV PORT=${port}`, `EXPOSE ${port}`);
      lines.push(cmdLine(input.startCommand ?? "/app/server"));
      break;
    }
    case "rust": {
      const v = safeTag(input.version, "1.83");
      const bin = (input.startCommand ?? "").match(/target\/release\/([\w-]+)/)?.[1] ?? "app";
      lines.push(
        `FROM rust:${v}-slim-bookworm AS build`,
        run("apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*"),
        "WORKDIR /src",
        "COPY . .",
        runUser(`${input.buildCommand ?? "cargo build --release"} && mkdir -p /out && cp target/release/${bin} /out/`, [
          `type=cache,id=${k}-cargo,target=/usr/local/cargo/registry`,
          `type=cache,id=${k}-target,target=/src/target`,
        ]),
        "",
        "FROM debian:bookworm-slim",
        run("apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/* && useradd -u 1000 app"),
        "WORKDIR /app",
        `COPY --from=build /out/${bin} /app/${bin}`,
        "USER 1000",
      );
      if (port) lines.push(`ENV PORT=${port}`, `EXPOSE ${port}`);
      lines.push(cmdLine(`/app/${bin}`));
      break;
    }
    case "php": {
      const v = safeTag(input.version, "8.3");
      lines.push(
        `FROM php:${v}-cli`,
        run("apt-get update && apt-get install -y --no-install-recommends git unzip libpq-dev libzip-dev && docker-php-ext-install pdo_mysql pdo_pgsql zip && rm -rf /var/lib/apt/lists/*"),
        "COPY --from=composer:2 /usr/bin/composer /usr/bin/composer",
        "WORKDIR /app",
        "COPY . .",
      );
      if (input.installCommand) lines.push(runUser(input.installCommand, [`type=cache,id=${k}-composer,target=/root/.composer/cache`]));
      if (input.buildCommand) {
        lines.push(run("apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*"));
        lines.push(runUser(input.buildCommand));
      }
      lines.push(run("useradd -u 1000 -m app && chown -R app:app /app"), "USER 1000");
      if (port) lines.push(`ENV PORT=${port}`, `EXPOSE ${port}`);
      lines.push(cmdLine(input.startCommand ?? "php -S 0.0.0.0:$PORT -t public"));
      break;
    }
    case "java": {
      const v = safeTag(input.version, "21");
      const maven = input.packageManager !== "gradle";
      lines.push(
        maven ? `FROM maven:3-eclipse-temurin-${v} AS build` : `FROM gradle:8-jdk${v} AS build`,
        "WORKDIR /src",
        "COPY . .",
        runUser(`${input.buildCommand ?? (maven ? "mvn -B -DskipTests package" : "gradle build -x test --no-daemon")} && mkdir -p /out && find ${maven ? "target" : "build/libs"} -maxdepth 1 -name '*.jar' ! -name '*-plain.jar' ! -name '*-sources.jar' ! -name 'original-*' | head -n 1 | xargs -I{} cp {} /out/app.jar`, [
          maven ? `type=cache,id=${k}-m2,target=/root/.m2` : `type=cache,id=${k}-gradle,target=/home/gradle/.gradle`,
        ]),
        "",
        `FROM eclipse-temurin:${v}-jre`,
        "WORKDIR /app",
        "COPY --from=build /out/app.jar /app/app.jar",
        run("useradd -u 1001 app || true"),
        "USER 1001",
      );
      if (port) lines.push(`ENV PORT=${port}`, `EXPOSE ${port}`);
      lines.push(cmdLine(input.startCommand ?? "java -Dserver.port=$PORT -jar app.jar"));
      break;
    }
    case "static": {
      lines.push("FROM busybox:1.36 AS build", "WORKDIR /app", "COPY . .", "", ...staticStage("build", outRel(input.outputDirectory ?? "."), spa));
      files["nginx.conf"] = nginxConfig(spa);
      port = 8080;
      break;
    }
    default:
      throw new BuildPlanError("SKYHOST could not determine how to build this project. Add a Dockerfile or set the commands manually.");
  }

  return { dockerfile: lines.join("\n") + "\n", files, context, port };
}

export const DEFAULT_DOCKERIGNORE = `.git
node_modules
.next
.nuxt
dist
target
__pycache__
.venv
venv
.env
.env.*
!.env.example
*.log
.DS_Store
`;
