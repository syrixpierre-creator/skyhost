import { parse as parseToml } from "smol-toml";
import type { AnalysisResult, DockerInfo, RepoFS } from "../types";
import { walkSources } from "../fs";
import { findLoopbackBind, findPortInCode, readJson } from "../util";

// ---------------------------------------------------------------------------- Go
export async function detectGo(fs: RepoFS, r: AnalysisResult): Promise<boolean> {
  const mod = await fs.readFile("go.mod");
  if (mod == null) return false;
  r.runtime = "go";
  r.packageManager = "go";
  r.version = /^go\s+(\d+\.\d+)/m.exec(mod)?.[1] ?? "1.23";
  r.installCommand = "go mod download";
  const fw: Array<[RegExp, string]> = [
    [/github\.com\/gin-gonic\/gin/, "gin"],
    [/github\.com\/labstack\/echo/, "echo"],
    [/github\.com\/gofiber\/fiber/, "fiber"],
    [/github\.com\/go-chi\/chi/, "chi"],
    [/github\.com\/gorilla\/mux/, "gorilla"],
  ];
  r.framework = fw.find(([re]) => re.test(mod))?.[1] ?? "net/http";
  // Pick the main package: root main.go, else cmd/<name>/main.go (prefer server/api/web)
  let pkg = ".";
  if (!(await fs.exists("main.go"))) {
    const cmds = (await fs.list("cmd")).filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1));
    const pick = cmds.find((c) => /server|api|web|app/.test(c)) ?? cmds[0];
    if (pick) pkg = `./cmd/${pick}`;
  }
  r.buildCommand = `CGO_ENABLED=0 go build -o /app/server ${pkg}`;
  r.startCommand = "/app/server";
  r.reasons.push(`Found go.mod (Go ${r.version}, ${r.framework}); building ${pkg} into a single binary.`);
  const files = await walkSources(fs, [".go"], 120, 4);
  for (const f of files) {
    const code = await fs.readFile(f);
    if (!code || !/(ListenAndServe|\.Run\(|\.Listen\(|\.Start\()/.test(code)) continue;
    r.port = findPortInCode(code) ?? 8080;
    if (!/Getenv\("PORT"\)/.test(code)) r.warnings.push(`${f} does not read os.Getenv("PORT"). SKYHOST sets PORT=${r.port}.`);
    const loop = findLoopbackBind(code);
    if (loop) r.suggestions.push({ file: f, message: `Listening on ${loop} is not reachable; listen on ":$PORT" or 0.0.0.0.`, find: loop, replace: "0.0.0.0" });
    break;
  }
  if (!r.port) {
    r.serviceType = files.length ? "worker" : "web";
    r.port = r.serviceType === "web" ? 8080 : null;
  }
  r.testCommand = "go test ./...";
  return true;
}

// ---------------------------------------------------------------------------- Rust
export async function detectRust(fs: RepoFS, r: AnalysisResult): Promise<boolean> {
  const raw = await fs.readFile("Cargo.toml");
  if (raw == null) return false;
  r.runtime = "rust";
  r.packageManager = "cargo";
  let name = "app";
  let deps: Record<string, unknown> = {};
  try {
    const t = parseToml(raw) as { package?: { name?: string; "rust-version"?: string }; dependencies?: Record<string, unknown>; bin?: Array<{ name?: string }> };
    name = t.bin?.[0]?.name ?? t.package?.name ?? name;
    deps = t.dependencies ?? {};
    r.version = t.package?.["rust-version"] ?? null;
  } catch {
    r.warnings.push("Cargo.toml could not be parsed.");
  }
  const toolchain = await fs.readFile("rust-toolchain.toml");
  r.version = r.version ?? /channel\s*=\s*"([\d.]+)"/.exec(toolchain ?? "")?.[1] ?? "1.83";
  r.framework = ["axum", "actix-web", "rocket", "warp", "poem", "tide"].find((d) => d in deps) ?? null;
  r.installCommand = null;
  r.buildCommand = "cargo build --release";
  r.startCommand = `./target/release/${name}`;
  r.reasons.push(`Found Cargo.toml (crate ${name}${r.framework ? `, ${r.framework}` : ""}); built in release mode.`);
  if (!r.framework && !("hyper" in deps) && !("tokio" in deps)) r.serviceType = "worker";
  const files = await walkSources(fs, [".rs"], 60, 3);
  for (const f of files) {
    const code = await fs.readFile(f);
    if (!code) continue;
    const p = findPortInCode(code);
    if (p) {
      r.port = p;
      const loop = findLoopbackBind(code);
      if (loop) r.suggestions.push({ file: f, message: `Binding to ${loop} is not reachable; bind to 0.0.0.0.`, find: loop, replace: "0.0.0.0" });
      if (!/env::var\("PORT"\)/.test(code)) r.warnings.push(`${f} does not read the PORT variable. SKYHOST sets PORT=${p}.`);
      break;
    }
  }
  if (r.serviceType === "web" && !r.port) r.port = r.framework === "rocket" ? 8000 : 3000;
  r.testCommand = "cargo test";
  return true;
}

// ---------------------------------------------------------------------------- PHP
export async function detectPhp(fs: RepoFS, r: AnalysisResult): Promise<boolean> {
  const composer = await readJson<{ require?: Record<string, string> }>(fs, "composer.json");
  const hasIndex = await fs.exists("index.php");
  if (!composer && !hasIndex && !(await fs.exists("public/index.php"))) return false;
  r.runtime = "php";
  r.packageManager = composer ? "composer" : null;
  r.version = composer?.require?.php?.match(/(\d+\.\d+)/)?.[1] ?? "8.3";
  if (composer) r.installCommand = "composer install --no-dev --optimize-autoloader --no-interaction";
  r.port = 8080;
  const req = composer?.require ?? {};
  if ("laravel/framework" in req || (await fs.exists("artisan"))) {
    r.framework = "laravel";
    r.startCommand = "php artisan serve --host=0.0.0.0 --port=$PORT";
    r.buildCommand = (await fs.exists("package.json")) ? "npm ci && npm run build" : null;
    r.reasons.push("Detected Laravel (artisan + laravel/framework).");
    r.warnings.push("Set APP_KEY in your variables (php artisan key:generate --show).");
  } else if ("symfony/framework-bundle" in req) {
    r.framework = "symfony";
    r.startCommand = "php -S 0.0.0.0:$PORT -t public";
  } else {
    r.framework = null;
    const docroot = (await fs.exists("public/index.php")) ? "public" : ".";
    r.startCommand = `php -S 0.0.0.0:$PORT -t ${docroot}`;
    r.reasons.push(`PHP application served from ${docroot}/.`);
  }
  return true;
}

// ---------------------------------------------------------------------------- Java
export async function detectJava(fs: RepoFS, r: AnalysisResult): Promise<boolean> {
  const pom = await fs.readFile("pom.xml");
  const gradle = (await fs.readFile("build.gradle")) ?? (await fs.readFile("build.gradle.kts"));
  if (pom == null && gradle == null) return false;
  r.runtime = "java";
  const text = pom ?? gradle ?? "";
  r.framework = /spring-boot/.test(text) ? "spring-boot" : /quarkus/.test(text) ? "quarkus" : /micronaut/.test(text) ? "micronaut" : null;
  if (pom != null) {
    r.packageManager = "maven";
    r.version = /<java\.version>(\d+)<\/java\.version>/.exec(pom)?.[1] ?? /<maven\.compiler\.(?:source|release)>(\d+)</.exec(pom)?.[1] ?? "21";
    const wrapper = await fs.exists("mvnw");
    r.buildCommand = `${wrapper ? "./mvnw" : "mvn"} -B -DskipTests package`;
    r.startCommand = "java -Dserver.port=$PORT -jar app.jar";
    r.testCommand = `${wrapper ? "./mvnw" : "mvn"} -B test`;
  } else {
    r.packageManager = "gradle";
    r.version = /languageVersion\s*(?:=|\.set\()\s*JavaLanguageVersion\.of\((\d+)\)/.exec(gradle!)?.[1] ?? /sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/.exec(gradle!)?.[1] ?? "21";
    const wrapper = await fs.exists("gradlew");
    r.buildCommand = `${wrapper ? "./gradlew" : "gradle"} build -x test --no-daemon`;
    r.startCommand = "java -Dserver.port=$PORT -jar app.jar";
    r.testCommand = `${wrapper ? "./gradlew" : "gradle"} test --no-daemon`;
  }
  r.port = 8080;
  const props = (await fs.readFile("src/main/resources/application.properties")) ?? "";
  const yml = (await fs.readFile("src/main/resources/application.yml")) ?? "";
  const p = /server\.port\s*=\s*\$?\{?(?:PORT:)?(\d+)/.exec(props)?.[1] ?? /port:\s*\$?\{?(?:PORT:)?(\d+)/.exec(yml)?.[1];
  if (p) r.port = Number(p);
  r.reasons.push(`Found ${pom != null ? "pom.xml (Maven)" : "build.gradle (Gradle)"}${r.framework ? ` with ${r.framework}` : ""}, Java ${r.version}.`);
  return true;
}

// ---------------------------------------------------------------------------- Docker
export function parseDockerfile(content: string, path = "Dockerfile"): DockerInfo {
  const info: DockerInfo = { path, from: [], expose: [], env: {} };
  // Join line continuations
  const lines = content.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [instr, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    switch (instr!.toUpperCase()) {
      case "FROM":
        info.from.push(rest.filter((x) => !x.startsWith("--"))[0] ?? arg);
        break;
      case "EXPOSE":
        for (const p of rest) {
          const n = Number(p.split("/")[0]);
          if (Number.isInteger(n) && n > 0) info.expose.push(n);
        }
        break;
      case "CMD":
        info.cmd = arg;
        break;
      case "ENTRYPOINT":
        info.entrypoint = arg;
        break;
      case "USER":
        info.user = arg;
        break;
      case "ENV": {
        if (/^\w+=/.test(arg)) {
          for (const m of arg.matchAll(/(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g)) info.env[m[1]!] = m[3] ?? m[4] ?? m[5] ?? "";
        } else if (rest[0]) info.env[rest[0]] = rest.slice(1).join(" ");
        break;
      }
    }
  }
  return info;
}

export async function detectDocker(fs: RepoFS, r: AnalysisResult, preferredPath?: string): Promise<boolean> {
  const path = preferredPath && (await fs.exists(preferredPath)) ? preferredPath : (await fs.exists("Dockerfile")) ? "Dockerfile" : (await fs.exists("dockerfile")) ? "dockerfile" : null;
  if (!path) return false;
  const content = (await fs.readFile(path)) ?? "";
  const info = parseDockerfile(content, path);
  r.dockerDetected = true;
  r.docker = info;
  r.reasons.push(`Found ${path}: SKYHOST builds your image exactly as described (base ${info.from.at(-1) ?? "unknown"}).`);
  if (info.expose.length) {
    r.port = info.expose[0]!;
    r.reasons.push(`The Dockerfile exposes port ${r.port}.`);
  } else if (info.env.PORT) {
    r.port = Number(info.env.PORT) || r.port;
  }
  if (!info.cmd && !info.entrypoint) r.warnings.push("The Dockerfile has no CMD or ENTRYPOINT; the base image default will be used.");
  if (!info.user || info.user === "root" || info.user === "0") {
    r.warnings.push("The image runs as root. SKYHOST drops all capabilities, but consider adding a USER instruction.");
  }
  return true;
}

// ---------------------------------------------------------------------------- Static
export async function detectStatic(fs: RepoFS, r: AnalysisResult): Promise<boolean> {
  for (const dir of [".", "public", "site", "docs"]) {
    if (await fs.exists(dir === "." ? "index.html" : `${dir}/index.html`)) {
      r.runtime = "static";
      r.serviceType = "static";
      r.outputDirectory = dir;
      r.framework = "html";
      r.reasons.push(`Found ${dir === "." ? "" : dir + "/"}index.html without a server: served as a static site.`);
      return true;
    }
  }
  return false;
}
