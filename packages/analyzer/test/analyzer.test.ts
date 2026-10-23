import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRepository, explainAnalysis, generateBuildPlan, localFS, memoryFS } from "../src";

const fx = (name: string) => localFS(join(__dirname, "fixtures", name));
const analyze = (name: string) => analyzeRepository(fx(name));

describe("ProjectAnalyzer corpus", () => {
  it("Express", async () => {
    const r = await analyze("express");
    expect(r).toMatchObject({ runtime: "node", framework: "express", packageManager: "npm", installCommand: "npm ci", startCommand: "npm run start", port: 3000, serviceType: "web", version: "20" });
    expect(r.databaseDetected.map((d) => d.engine)).toEqual(["postgres"]);
    expect(r.suggestions[0]).toMatchObject({ file: "server.js", find: "localhost", replace: "0.0.0.0" });
    const vars = Object.fromEntries(r.environmentVariables.map((v) => [v.key, v]));
    expect(vars.DATABASE_URL!.required).toBe(true);
    expect(vars.SESSION_SECRET!.defaultValue).toBeUndefined(); // "changeme" is a placeholder
    expect(vars.LOG_LEVEL!.defaultValue).toBe("info");
    expect(vars.PORT).toBeUndefined();
    expect(r.confidence).toBe("high");
  });

  it("Next.js", async () => {
    const r = await analyze("nextjs");
    expect(r).toMatchObject({ runtime: "node", framework: "nextjs", packageManager: "pnpm", installCommand: "pnpm install --frozen-lockfile", buildCommand: "pnpm run build", startCommand: "pnpm run start", port: 3000, version: "20" });
    expect(r.databaseDetected).toEqual([{ engine: "postgres", reason: "Prisma datasource provider is postgresql", variable: "DATABASE_URL" }]);
    expect(r.environmentVariables.map((v) => v.key)).toEqual(expect.arrayContaining(["NEXT_PUBLIC_SITE_NAME", "STRIPE_SECRET_KEY"]));
    expect(r.confidence).toBe("high");
  });

  it("Vite React (static)", async () => {
    const r = await analyze("vite-react");
    expect(r).toMatchObject({ runtime: "node", framework: "vite-react", packageManager: "yarn", serviceType: "static", outputDirectory: "dist", buildCommand: "yarn run build", startCommand: null, port: null, confidence: "high" });
    expect(r.environmentVariables.map((v) => v.key)).toContain("VITE_API_URL");
  });

  it("Django", async () => {
    const r = await analyze("django");
    expect(r).toMatchObject({ runtime: "python", framework: "django", version: "3.12", port: 8000, startCommand: "gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT" });
    expect(r.databaseDetected[0]!.engine).toBe("postgres");
    const keys = r.environmentVariables.map((v) => v.key);
    expect(keys).toContain("DJANGO_SECRET_KEY");
    expect(r.environmentVariables.find((v) => v.key === "DEBUG")!.required).toBe(false);
  });

  it("FastAPI", async () => {
    const r = await analyze("fastapi");
    expect(r).toMatchObject({ runtime: "python", framework: "fastapi", startCommand: "uvicorn app.main:app --host 0.0.0.0 --port $PORT", port: 8000, confidence: "high" });
    expect(r.databaseDetected.map((d) => d.engine)).toEqual(["redis"]);
    expect(r.environmentVariables.find((v) => v.key === "REDIS_URL")!.required).toBe(true);
    expect(r.environmentVariables.find((v) => v.key === "GREETING")!.required).toBe(false);
  });

  it("Flask", async () => {
    const r = await analyze("flask");
    expect(r).toMatchObject({ runtime: "python", framework: "flask", startCommand: "gunicorn app:app --bind 0.0.0.0:$PORT", port: 5000 });
    expect(r.databaseDetected.map((d) => d.engine)).toEqual(["mongodb"]);
    expect(r.suggestions.some((s) => s.find === "127.0.0.1")).toBe(true);
    expect(r.warnings.some((w) => w.includes("gunicorn"))).toBe(true);
  });

  it("Laravel", async () => {
    const r = await analyze("laravel");
    expect(r).toMatchObject({ runtime: "php", framework: "laravel", version: "8.2", packageManager: "composer", startCommand: "php artisan serve --host=0.0.0.0 --port=$PORT" });
    expect(r.databaseDetected.map((d) => d.engine).sort()).toEqual(["postgres", "redis"]);
    expect(r.environmentVariables.find((v) => v.key === "APP_KEY")!.required).toBe(true);
  });

  it("Go net/http", async () => {
    const r = await analyze("go-nethttp");
    expect(r).toMatchObject({ runtime: "go", framework: "net/http", version: "1.23", port: 8080, startCommand: "/app/server", confidence: "high" });
    expect(r.databaseDetected.map((d) => d.engine)).toEqual(["postgres"]);
    expect(r.environmentVariables.map((v) => v.key)).toContain("APP_GREETING");
  });

  it("Rust Axum", async () => {
    const r = await analyze("rust-axum");
    expect(r).toMatchObject({ runtime: "rust", framework: "axum", startCommand: "./target/release/axum-hello", port: 3000, confidence: "high" });
    expect(r.databaseDetected.map((d) => d.engine)).toEqual(["postgres"]);
  });

  it("Spring Boot", async () => {
    const r = await analyze("spring-boot");
    expect(r).toMatchObject({ runtime: "java", framework: "spring-boot", packageManager: "maven", version: "21", buildCommand: "./mvnw -B -DskipTests package", port: 8081 });
    expect(r.databaseDetected.map((d) => d.engine)).toEqual(["postgres"]);
    expect(r.environmentVariables.map((v) => v.key)).toContain("FEATURE_FLAG");
  });

  it("Dockerfile is authoritative", async () => {
    const r = await analyze("dockerfile");
    expect(r).toMatchObject({ dockerDetected: true, port: 4000, installCommand: null, startCommand: null, confidence: "high" });
    expect(r.docker).toMatchObject({ from: ["node:22-alpine"], expose: [4000], user: "node", env: { NODE_ENV: "production", PORT: "4000" } });
  });

  it("docker-compose services and databases", async () => {
    const r = await analyze("compose");
    expect(r.compose!.map((s) => s.name)).toEqual(["web", "db", "cache", "admin"]);
    expect(r.compose![0]).toMatchObject({ build: { context: "./web" }, ports: [8000], dependsOn: ["db", "cache"] });
    expect(r.compose!.find((s) => s.name === "db")!.managedDatabase).toBe("postgres");
    expect(r.databaseDetected.map((d) => d.engine).sort()).toEqual(["postgres", "redis"]);
    expect(r.warnings.some((w) => w.includes("host-level access"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("docker.sock"))).toBe(true);
  });

  it("pnpm/turborepo monorepo", async () => {
    const r = await analyze("monorepo");
    expect(r.monorepo!.tool).toBe("turborepo");
    const pk = Object.fromEntries(r.monorepo!.packages.map((p) => [p.path, p.deployable]));
    expect(pk).toEqual({ "apps/web": true, "apps/api": true, "packages/ui": false });
    expect(r.rootDir).toBe("apps/web");
    expect(r.workspaceRoot).toBe(".");
    expect(r.installCommand).toBe("pnpm install --frozen-lockfile");
    expect(r.confidence).toBe("medium");
    const api = r.monorepo!.packages.find((p) => p.path === "apps/api")!.analysis!;
    expect(api).toMatchObject({ framework: "fastify", port: 4000 });
    expect(api.databaseDetected[0]!.engine).toBe("redis");
  });

  it("polyglot repository with apps in sub directories", async () => {
    const r = await analyze("polyglot");
    expect(r.monorepo!.tool).toBe("directories");
    expect(r.monorepo!.packages.map((p) => p.path).sort()).toEqual(["backend", "frontend"]);
    const be = r.monorepo!.packages.find((p) => p.path === "backend");
    const a = be!.analysis ?? r;
    expect(a.runtime).toBe("go");
    expect(a.port).toBe(9000);
  });

  it("static HTML", async () => {
    const r = await analyze("static-html");
    expect(r).toMatchObject({ runtime: "static", serviceType: "static", outputDirectory: ".", confidence: "high" });
  });

  it("background worker", async () => {
    const r = await analyze("worker-bot");
    expect(r).toMatchObject({ serviceType: "worker", startCommand: "npm run start" });
    expect(r.environmentVariables.map((v) => v.key)).toEqual(["DISCORD_TOKEN"]);
  });

  it("unknown project has low confidence", async () => {
    const r = await analyze("unknown");
    expect(r.runtime).toBe("unknown");
    expect(r.confidence).toBe("low");
    expect(explainAnalysis(r).at(-1)).toMatch(/not sure/);
  });

  it("explicit rootDir cannot escape the repository", async () => {
    await expect(analyzeRepository(fx("monorepo"), { rootDir: "../express" })).rejects.toThrow();
  });

  it("works on an in-memory listing", async () => {
    const r = await analyzeRepository(memoryFS({ "package.json": JSON.stringify({ dependencies: { koa: "2" }, scripts: { start: "node a.js" } }), "a.js": "app.listen(process.env.PORT || 8088)" }));
    expect(r).toMatchObject({ framework: "koa", port: 8088 });
  });
});

describe("build plans", () => {
  it("generates Dockerfiles for every reference stack", async () => {
    for (const name of ["express", "nextjs", "vite-react", "django", "fastapi", "flask", "laravel", "go-nethttp", "rust-axum", "spring-boot", "static-html", "worker-bot"]) {
      const a = await analyze(name);
      const plan = generateBuildPlan({ ...a, cacheKey: "svc123" });
      expect(plan.dockerfile, name).toMatch(/^FROM /);
      expect(plan.dockerfile, name).toMatch(/CMD |nginx/);
      if (a.serviceType === "static") {
        expect(plan.port).toBe(8080);
        expect(plan.files["nginx.conf"]).toContain("try_files");
      } else expect(plan.dockerfile, name).toMatch(/USER /);
    }
  });

  it("uses the workspace root as build context in monorepos", async () => {
    const a = await analyze("monorepo");
    const plan = generateBuildPlan({ ...a, cacheKey: "k" });
    expect(plan.context).toBe(".");
    expect(plan.dockerfile).toContain("WORKDIR /app/apps/web");
  });

  it("cannot inject Dockerfile instructions through commands", () => {
    expect(() => generateBuildPlan({ runtime: "node", serviceType: "web", startCommand: "node a.js\nRUN curl evil", cacheKey: "k" })).toThrow();
    const plan = generateBuildPlan({ runtime: "node", serviceType: "web", installCommand: 'npm ci"] && echo FROM x', startCommand: "node a.js", cacheKey: "k" } as never);
    expect(plan.dockerfile.split("\n").filter((l) => l.startsWith("FROM")).length).toBe(2);
  });

  it("rejects path traversal in directories", () => {
    expect(() => generateBuildPlan({ runtime: "static", serviceType: "static", outputDirectory: "../../etc", cacheKey: "k" })).toThrow();
  });
});
