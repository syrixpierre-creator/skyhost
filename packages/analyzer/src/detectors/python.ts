import { parse as parseToml } from "smol-toml";
import type { AnalysisResult, RepoFS } from "../types";
import { walkSources } from "../fs";
import { findLoopbackBind, findPortInCode } from "../util";

export interface PythonDeps {
  names: Set<string>;
  manager: "pip" | "poetry" | "uv" | "pipenv" | "pdm";
}

function normalizeReq(line: string): string | null {
  const l = line.split("#")[0]!.trim();
  if (!l || l.startsWith("-")) return null;
  const m = /^([A-Za-z0-9_.-]+)/.exec(l);
  return m ? m[1]!.toLowerCase().replace(/_/g, "-") : null;
}

export async function readPythonDeps(fs: RepoFS): Promise<PythonDeps | null> {
  const names = new Set<string>();
  let manager: PythonDeps["manager"] = "pip";
  let found = false;
  const req = await fs.readFile("requirements.txt");
  if (req != null) {
    found = true;
    for (const line of req.split("\n")) {
      const n = normalizeReq(line);
      if (n) names.add(n);
    }
  }
  const pyproject = await fs.readFile("pyproject.toml");
  if (pyproject != null) {
    found = true;
    try {
      const t = parseToml(pyproject) as {
        project?: { dependencies?: string[] };
        tool?: { poetry?: { dependencies?: Record<string, unknown> }; uv?: unknown; pdm?: unknown };
      };
      for (const d of t.project?.dependencies ?? []) {
        const n = normalizeReq(d);
        if (n) names.add(n);
      }
      for (const d of Object.keys(t.tool?.poetry?.dependencies ?? {})) names.add(d.toLowerCase());
      if (t.tool?.poetry || (await fs.exists("poetry.lock"))) manager = "poetry";
      else if (await fs.exists("uv.lock")) manager = "uv";
      else if (t.tool?.pdm || (await fs.exists("pdm.lock"))) manager = "pdm";
    } catch {
      // Invalid TOML: keep what we have
    }
  }
  const pipfile = await fs.readFile("Pipfile");
  if (pipfile != null) {
    found = true;
    manager = req == null && pyproject == null ? "pipenv" : manager;
    const section = /\[packages\]([\s\S]*?)(\n\[|$)/.exec(pipfile)?.[1] ?? "";
    for (const line of section.split("\n")) {
      const m = /^([A-Za-z0-9_.-]+)\s*=/.exec(line.trim());
      if (m) names.add(m[1]!.toLowerCase());
    }
  }
  if (!found && !(await fs.exists("manage.py"))) return null;
  return { names, manager };
}

const INSTALL: Record<PythonDeps["manager"], string> = {
  pip: "pip install --no-cache-dir -r requirements.txt",
  poetry: "pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --no-interaction --no-root --only main",
  uv: "pip install --no-cache-dir uv && uv pip install --system -r pyproject.toml",
  pipenv: "pip install --no-cache-dir pipenv && pipenv install --system --deploy",
  pdm: "pip install --no-cache-dir pdm && pdm export -o requirements.txt --without-hashes && pip install --no-cache-dir -r requirements.txt",
};

/** Converts "src/app/main.py" to "src.app.main" */
const toModule = (file: string) => file.replace(/\.py$/, "").replace(/\//g, ".");

export async function detectPython(fs: RepoFS, r: AnalysisResult): Promise<boolean> {
  const deps = await readPythonDeps(fs);
  if (!deps) return false;
  r.runtime = "python";
  r.packageManager = deps.manager;
  r.reasons.push(`Found Python dependency files (installed with ${deps.manager}).`);
  if (deps.manager === "pip" && !(await fs.exists("requirements.txt"))) {
    r.installCommand = (await fs.exists("pyproject.toml")) ? "pip install --no-cache-dir ." : null;
  } else r.installCommand = INSTALL[deps.manager];

  const pyVersion = ((await fs.readFile(".python-version")) ?? (await fs.readFile("runtime.txt")))?.trim().replace(/^python-/, "");
  r.version = pyVersion?.match(/^(\d+\.\d+)/)?.[1] ?? "3.12";

  const has = (n: string) => deps.names.has(n);
  const files = await walkSources(fs, [".py"], 300, 4);

  if ((await fs.exists("manage.py")) || has("django")) {
    r.framework = "django";
    r.port = 8000;
    // Find the project package holding wsgi.py
    const wsgi = files.find((f) => f.endsWith("/wsgi.py") || f === "wsgi.py");
    const mod = wsgi ? toModule(wsgi) : null;
    if (mod) {
      r.startCommand = `gunicorn ${mod}:application --bind 0.0.0.0:$PORT`;
      r.reasons.push(`Detected Django (manage.py, ${wsgi}): served by gunicorn.`);
    } else {
      r.startCommand = "python manage.py runserver 0.0.0.0:$PORT";
      r.warnings.push("wsgi.py not found: falling back to the Django development server.");
    }
    r.buildCommand = "python manage.py collectstatic --noinput";
    if (!has("gunicorn") && mod) r.warnings.push("gunicorn is not in your dependencies; SKYHOST installs it during the build.");
  } else if (has("fastapi") || has("starlette")) {
    r.framework = "fastapi";
    r.port = 8000;
    const file = await findFileContaining(fs, files, /=\s*FastAPI\(/);
    const varName = file ? /(\w+)\s*=\s*FastAPI\(/.exec((await fs.readFile(file)) ?? "")?.[1] ?? "app" : "app";
    const mod = file ? toModule(file) : "main";
    r.startCommand = `uvicorn ${mod}:${varName} --host 0.0.0.0 --port $PORT`;
    r.reasons.push(`Detected FastAPI (${file ?? "main.py"}): served by uvicorn on $PORT.`);
    if (!has("uvicorn")) r.warnings.push("uvicorn is not in your dependencies; SKYHOST installs it during the build.");
  } else if (has("flask")) {
    r.framework = "flask";
    r.port = 5000;
    const file = await findFileContaining(fs, files, /=\s*Flask\(/);
    const code = file ? ((await fs.readFile(file)) ?? "") : "";
    const varName = /(\w+)\s*=\s*Flask\(/.exec(code)?.[1] ?? "app";
    const mod = file ? toModule(file) : "app";
    r.startCommand = `gunicorn ${mod}:${varName} --bind 0.0.0.0:$PORT`;
    r.reasons.push(`Detected Flask (${file ?? "app.py"}): served by gunicorn on $PORT.`);
    if (!has("gunicorn")) r.warnings.push("gunicorn is not in your dependencies; SKYHOST installs it during the build.");
  } else if (has("streamlit")) {
    r.framework = "streamlit";
    r.port = 8501;
    const file = files.find((f) => /^(app|main|streamlit_app)\.py$/.test(f)) ?? "app.py";
    r.startCommand = `streamlit run ${file} --server.port $PORT --server.address 0.0.0.0`;
  } else if (has("celery") && !has("flask") && !has("django")) {
    r.framework = "celery";
    r.serviceType = "worker";
    const file = await findFileContaining(fs, files, /=\s*Celery\(/);
    r.startCommand = `celery -A ${file ? toModule(file) : "tasks"} worker --loglevel=info`;
    r.reasons.push("Celery app without a web framework: deployed as a background worker.");
  } else {
    const entry = files.find((f) => /^(main|app|server|bot)\.py$/.test(f));
    if (entry) {
      r.startCommand = `python ${entry}`;
      const code = (await fs.readFile(entry)) ?? "";
      if (!/(http\.server|aiohttp|socket|bottle|tornado|sanic|port)/i.test(code)) r.serviceType = "worker";
    }
  }

  for (const f of files.slice(0, 80)) {
    const code = await fs.readFile(f);
    if (!code) continue;
    const loop = findLoopbackBind(code);
    if (loop && /(run|listen|serve|uvicorn)\s*\(/.test(code)) {
      r.suggestions.push({ file: f, message: `This file binds to ${loop}. Use host "0.0.0.0" so SKYHOST can route traffic.`, find: loop, replace: "0.0.0.0" });
      break;
    }
    if (!r.framework && r.serviceType === "web") {
      const p = findPortInCode(code);
      if (p) r.port = p;
    }
  }
  if (r.serviceType === "web" && !r.port) r.port = 8000;
  r.testCommand = has("pytest") ? "pytest" : null;
  return true;
}

async function findFileContaining(fs: RepoFS, files: string[], re: RegExp): Promise<string | null> {
  const preferred = ["main.py", "app.py", "app/main.py", "src/main.py", "api/main.py", "server.py", "wsgi.py", "application.py"];
  const ordered = [...preferred.filter((p) => files.includes(p)), ...files.filter((f) => !preferred.includes(f))];
  for (const f of ordered) {
    const code = await fs.readFile(f);
    if (code && re.test(code)) return f;
  }
  return null;
}
