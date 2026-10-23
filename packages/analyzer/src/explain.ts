import type { AnalysisResult } from "./types";

const RUNTIME_NAMES: Record<string, string> = {
  node: "Node.js",
  python: "Python",
  go: "Go",
  rust: "Rust",
  php: "PHP",
  java: "Java",
  docker: "Docker",
  static: "static HTML",
  unknown: "an unknown stack",
};

/** Plain-language explanation shown by the "Explain" button. */
export function explainAnalysis(a: AnalysisResult): string[] {
  const out: string[] = [];
  const what = a.framework ? `${a.framework} app (${RUNTIME_NAMES[a.runtime]}${a.version ? ` ${a.version}` : ""})` : `${RUNTIME_NAMES[a.runtime]} project`;
  out.push(`This looks like a ${what}.`);
  if (a.rootDir !== ".") out.push(`The app lives in the "${a.rootDir}" folder of the repository.`);
  if (a.dockerDetected) out.push("Your repository has a Dockerfile, so SKYHOST will build the image exactly as it describes.");
  else {
    if (a.installCommand) out.push(`First, SKYHOST installs your dependencies with: ${a.installCommand}`);
    if (a.buildCommand) out.push(`Then it builds the app with: ${a.buildCommand}`);
  }
  if (a.serviceType === "static") out.push(`The result is a set of static files (from ${a.outputDirectory}/) served over HTTPS with caching and SPA fallback.`);
  else if (a.serviceType === "worker") out.push("It does not serve web pages: it runs in the background as a worker.");
  else {
    if (a.startCommand) out.push(`Your app is started with: ${a.startCommand}`);
    out.push(`It must listen on port ${a.port ?? 3000}. SKYHOST passes the port in the PORT variable and gives you a public HTTPS address.`);
  }
  if (a.databaseDetected.length) out.push(`Your code uses ${a.databaseDetected.map((d) => d.engine).join(", ")}. SKYHOST can create ${a.databaseDetected.length > 1 ? "these databases" : "this database"} and connect ${a.databaseDetected.length > 1 ? "them" : "it"} automatically.`);
  const required = a.environmentVariables.filter((v) => v.required);
  if (required.length) out.push(`You will need to fill in ${required.length} setting${required.length > 1 ? "s" : ""}: ${required.slice(0, 8).map((v) => v.key).join(", ")}${required.length > 8 ? "…" : ""}.`);
  if (a.monorepo) out.push(`This repository contains several apps (${a.monorepo.packages.filter((p) => p.deployable).map((p) => p.path).join(", ")}). You can deploy them all at once.`);
  if (a.compose?.length) out.push(`A docker-compose file describes ${a.compose.length} services; SKYHOST can recreate them as linked services.`);
  out.push(
    a.confidence === "high"
      ? "SKYHOST is confident about this setup: you can deploy in one click."
      : a.confidence === "medium"
        ? "SKYHOST is fairly confident; please double check the values before deploying."
        : "SKYHOST is not sure how to run this project; please review the configuration.",
  );
  for (const s of a.suggestions) out.push(`Tip: ${s.message}`);
  return out;
}
