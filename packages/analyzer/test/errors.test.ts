import { describe, expect, it } from "vitest";
import { analyzeErrors, applyFileFix } from "../src";

const ids = (log: string, ctx = {}) => analyzeErrors(log, ctx).map((d) => d.id);

describe("Smart Error Analyzer", () => {
  it("detects a missing Node package and proposes a reviewable package.json edit", () => {
    const pkg = JSON.stringify({ name: "a", dependencies: {}, devDependencies: { dotenv: "^16.0.0" } }, null, 2);
    const [d] = analyzeErrors("Error: Cannot find module 'dotenv'\nRequire stack:\n- /app/server.js", { files: { "package.json": pkg }, packageManager: "npm" });
    expect(d).toMatchObject({ id: "node-missing-module", problem: "Missing package: dotenv", confidence: "high" });
    expect(d!.autoFix!.file).toBe("package.json");
    const next = JSON.parse(applyFileFix(pkg, d!.autoFix!)!);
    expect(next.dependencies.dotenv).toBe("^16.0.0");
    expect(next.devDependencies.dotenv).toBeUndefined();
    // A fix is never applied to content that changed since the diagnosis
    expect(applyFileFix(pkg + " ", { ...d!.autoFix!, find: "nope" })).toBeNull();
  });

  it("treats relative imports as missing files", () => {
    expect(analyzeErrors("Error: Cannot find module './Config'")[0]!.problem).toMatch(/local file/);
  });

  it("detects missing Python modules with the right package name", () => {
    const [d] = analyzeErrors("ModuleNotFoundError: No module named 'cv2'", { files: { "requirements.txt": "flask\n" } });
    expect(d!.problem).toBe("Missing Python package: opencv-python");
    expect(d!.autoFix!.replace).toBe("flask\nopencv-python\n");
  });

  it("detects runtime version, port, env, database, migration, permission and memory errors", () => {
    expect(ids('error vite@6.0.0: The engine "node" is incompatible with this module. Expected version "^18.0.0 || >=20.0.0". Got "16.20.0"')).toContain("node-version");
    expect(ids("Error: listen EADDRINUSE: address already in use :::3000")).toContain("port-in-use");
    expect(ids("Server listening on http://127.0.0.1:3000")).toContain("listening-localhost");
    expect(ids("Health check failed: connection refused on port 3000", { port: 3000 })).toContain("port-mismatch");
    expect(ids("Error: Missing required environment variable: STRIPE_KEY")).toContain("missing-env");
    expect(ids("KeyError: 'DJANGO_SECRET_KEY'")).toContain("missing-env");
    expect(ids("Error: connect ECONNREFUSED 127.0.0.1:5432")).toContain("db-connection");
    expect(ids('error: relation "users" does not exist')).toContain("migration");
    expect(ids("Error: EACCES: permission denied, mkdir '/app/uploads'")).toContain("permission");
    const oom = analyzeErrors("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", { memoryMb: 512 })[0]!;
    expect(oom).toMatchObject({ id: "oom", autoFix: { field: "resources.memoryMb", value: 1024 } });
    expect(ids("npm ERR! Missing script: \"build\"")).toContain("missing-script");
    expect(ids("src/a.ts(3,1): error TS2304: Cannot find name 'x'.")).toContain("typescript");
    expect(ids("/bin/sh: 1: tsc: not found")).toContain("command-not-found");
    expect(ids("ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile")).toContain("lockfile");
  });

  it("returns nothing for clean logs", () => {
    expect(analyzeErrors("Compiled successfully\nListening on 0.0.0.0:3000")).toEqual([]);
  });
});
