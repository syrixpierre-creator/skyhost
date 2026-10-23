import { build } from "esbuild";

/**
 * Bundles the application with its dependencies: esbuild resolves every import from the importing package, so
 * each workspace package gets the dependency versions it declares. Packages that load native addons or read their
 * own files at runtime stay external and are installed in the runtime image.
 */
export const RUNTIME_EXTERNALS = ["@node-rs/argon2", "@fastify/swagger-ui", "pdfkit", "playwright", "playwright-core", "dockerode", "ssh2", "cpu-features", "bufferutil", "utf-8-validate"];

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: RUNTIME_EXTERNALS,
  banner: { js: "import { createRequire } from 'module'; import { fileURLToPath as __shFileURLToPath } from 'url'; import { dirname as __shDirname } from 'path'; const require = createRequire(import.meta.url); const __filename = __shFileURLToPath(import.meta.url); const __dirname = __shDirname(__filename);" },
  logLevel: "warning",
});
console.log("API bundled to dist/index.js");
