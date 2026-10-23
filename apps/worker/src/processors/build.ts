import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { databaseConnections, databases, deployments, environments, getDb, gitInstallations, services, uploads, usageRecords } from "@skyhost/db";
import { analyzeErrors, analyzeRepository, localFS, type AnalysisResult } from "@skyhost/analyzer";
import type { ServiceConfig } from "@skyhost/shared";
import { buildImage, BuildError, cloneRepository, extractZip, getObjectStore, makeWorkDir, names, pullImage, removeWorkDir } from "@skyhost/engine";
import { audit, enqueue, notify, providerClient, redis, redisSubscriber, resolveServiceEnv } from "@skyhost/core";
import { DeployLog, isCancelled, markPhase, setDeploymentState, teamOfService } from "../deploy-log";

export interface EffectiveConfig {
  runtime: string | null;
  runtimeVersion: string | null;
  packageManager: string | null;
  rootDir: string;
  workspaceRoot: string | null;
  dockerfilePath: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  testCommand: string | null;
  outputDirectory: string | null;
  port: number | null;
}

/** User settings (Advanced mode) always win over detected values (Simple mode). */
export function effectiveConfig(cfg: ServiceConfig, a: AnalysisResult | null): EffectiveConfig {
  const pick = <T>(user: T | undefined | null, detected: T | undefined | null) => (user !== undefined && user !== null && user !== "" ? user : (detected ?? null));
  return {
    runtime: pick(cfg.runtime, a?.runtime),
    runtimeVersion: pick(cfg.runtimeVersion, a?.version),
    packageManager: pick(cfg.packageManager, a?.packageManager),
    rootDir: cfg.rootDir && cfg.rootDir !== "." ? cfg.rootDir : (a?.rootDir ?? "."),
    workspaceRoot: a?.workspaceRoot ?? null,
    dockerfilePath: cfg.dockerfilePath ?? null,
    installCommand: pick(cfg.installCommand, a?.installCommand),
    buildCommand: pick(cfg.buildCommand, a?.buildCommand),
    startCommand: pick(cfg.startCommand, a?.startCommand),
    testCommand: pick(cfg.testCommand, null),
    outputDirectory: pick(cfg.outputDirectory, a?.outputDirectory),
    port: pick(cfg.port, a?.port),
  };
}

const cancelControllers = new Map<string, AbortController>();
let cancelListener = false;
function listenForCancels() {
  if (cancelListener) return;
  cancelListener = true;
  const sub = redisSubscriber().duplicate();
  void sub.subscribe("sh:cancel");
  sub.on("message", (_c, id: string) => cancelControllers.get(id)?.abort());
}

async function waitForCi(log: DeployLog, inst: typeof gitInstallations.$inferSelect, repo: string, sha: string, deploymentId: string) {
  const client = providerClient(inst);
  const deadline = Date.now() + 30 * 60_000;
  log.line(`Waiting for CI checks on ${sha.slice(0, 7)} to pass`);
  while (Date.now() < deadline) {
    if (await isCancelled(deploymentId)) throw new BuildError("Deployment cancelled", "cancelled");
    const s = await client.commitStatus(repo, sha).catch(() => "pending" as const);
    if (s === "success" || s === "none") {
      log.line(s === "none" ? "No CI checks configured, continuing" : "CI checks passed");
      return;
    }
    if (s === "failure") throw new BuildError("CI checks failed for this commit; deployment skipped", "build");
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new BuildError("CI checks did not finish within 30 minutes", "timeout");
}

async function waitForDatabases(serviceId: string, log: DeployLog) {
  const db = getDb();
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const conns = await db.select({ d: databases }).from(databaseConnections).innerJoin(databases, eq(databases.id, databaseConnections.databaseId)).where(eq(databaseConnections.serviceId, serviceId));
    const pending = conns.filter((c) => c.d.status === "provisioning");
    if (!pending.length) return;
    if (Date.now() > deadline) throw new BuildError(`Database ${pending[0]!.d.name} is not ready yet`, "build");
    log.line(`Waiting for database ${pending.map((p) => p.d.name).join(", ")} to be ready…`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function readSmall(dir: string, file: string) {
  try {
    const s = await readFile(join(dir, file), "utf8");
    return s.length < 200_000 ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Build stage of the pipeline: Clone → Analyze → Install → Build → Test → Image. Then hands off to the release stage. */
export async function processBuild(deploymentId: string) {
  listenForCancels();
  const db = getDb();
  const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!dep || dep.status !== "queued") return;
  const [svc] = await db.select().from(services).where(eq(services.id, dep.serviceId));
  const [env] = await db.select().from(environments).where(eq(environments.id, dep.environmentId));
  if (!svc || !env || svc.deletedAt || env.deletedAt) {
    await setDeploymentState(deploymentId, { status: "cancelled", error: "Service or environment was deleted", finishedAt: new Date() });
    return;
  }
  const { teamId } = await teamOfService(svc.id);
  const log = new DeployLog(deploymentId, "build");
  const controller = new AbortController();
  cancelControllers.set(deploymentId, controller);
  const started = Date.now();
  let workDir: string | null = null;
  let repoDir: string | null = null;
  const config = (dep.configSnapshot ?? svc.config) as ServiceConfig;
  try {
    await setDeploymentState(deploymentId, { status: "building", startedAt: new Date() });
    const resolved = await resolveServiceEnv(svc.id, env.id, { deploymentId, commitSha: dep.commitSha });
    log.redactor.add(...resolved.secrets);
    if (resolved.missingReferences.length) log.line(`Warning: unresolved references ${resolved.missingReferences.join(", ")}`, "warn");

    // Rollbacks and redeploys reuse an existing image: no rebuild.
    if (dep.image) {
      log.line(dep.trigger === "rollback" ? `Rolling back to image of deployment ${dep.rollbackOfId?.slice(0, 8)}` : "Reusing the current image (no rebuild)");
      await log.flush();
      await enqueue("release", { deploymentId }, { jobId: `release-${deploymentId}` });
      return;
    }

    const source = (dep.sourceRef?.uploadId ? { ...svc.source, kind: "zip", uploadId: dep.sourceRef.uploadId } : svc.source) as Record<string, string> & { kind: string };
    if (source.kind === "image") {
      await markPhase(deploymentId, "image");
      log.line(`Pulling image ${source.image}`);
      let auth: { username: string; password: string; serveraddress?: string } | undefined;
      if (source.registryAuth) {
        const { decrypt } = await import("@skyhost/shared/node");
        const [username = "", password = ""] = decrypt(source.registryAuth).split(":");
        auth = { username, password };
      }
      await pullImage(source.image!, (l) => log.line(l), auth);
      await setDeploymentState(deploymentId, { image: source.image, analysis: null });
      await log.flush();
      await enqueue("release", { deploymentId }, { jobId: `release-${deploymentId}` });
      return;
    }

    // ---------------------------------------------------------------- Clone / extract
    await markPhase(deploymentId, "clone");
    if (source.kind === "zip") {
      const [u] = await db.select().from(uploads).where(and(eq(uploads.id, source.uploadId!), eq(uploads.teamId, teamId)));
      if (!u) throw new BuildError("The uploaded archive is missing", "plan");
      const tmp = await makeWorkDir("upload");
      const zipPath = join(tmp, "source.zip");
      await writeFile(zipPath, await getObjectStore().get(u.objectKey));
      log.line(`Extracting uploaded archive (${Math.round(u.sizeBytes / 1024)} KB)`);
      const ex = await extractZip(zipPath);
      await removeWorkDir(tmp);
      workDir = ex.workDir;
      repoDir = ex.dir;
      log.line(`Extracted ${ex.files} files`);
    } else {
      let url = source.url!;
      let token: string | null = null;
      let username = "x-access-token";
      let inst: typeof gitInstallations.$inferSelect | undefined;
      if (source.kind !== "git") {
        [inst] = await db.select().from(gitInstallations).where(and(eq(gitInstallations.id, source.installationId!), eq(gitInstallations.teamId, teamId)));
        if (!inst) throw new BuildError("The Git connection of this service was removed. Reconnect it in the service settings.", "plan");
        const auth = await providerClient(inst).cloneAuth(source.repo!);
        url = auth.url;
        token = auth.token;
        username = auth.username;
        log.redactor.add(token);
      }
      if (inst && config.waitForCi && dep.commitSha && dep.trigger === "git") await waitForCi(log, inst, source.repo!, dep.commitSha, deploymentId);
      const cloned = await cloneRepository({ url, branch: dep.branch ?? source.branch ?? null, commit: dep.commitSha, token, tokenUsername: username, onLine: (l) => log.line(l) });
      workDir = cloned.workDir;
      repoDir = cloned.dir;
      if (!dep.commitSha || dep.commitSha.length < 40) await setDeploymentState(deploymentId, { commitSha: cloned.commit.sha, commitMessage: dep.commitMessage ?? cloned.commit.message, commitAuthor: dep.commitAuthor ?? cloned.commit.author });
    }
    if (await isCancelled(deploymentId)) throw new BuildError("Deployment cancelled", "cancelled");

    // ---------------------------------------------------------------- Analyze
    await markPhase(deploymentId, "analyze");
    const analysis = await analyzeRepository(localFS(repoDir), { rootDir: config.rootDir && config.rootDir !== "." ? config.rootDir : undefined, dockerfilePath: config.dockerfilePath, ignoreDockerfile: !!config.runtime && svc.type !== "docker" && !config.dockerfilePath });
    log.line(`Detected ${analysis.framework ?? analysis.runtime} (${analysis.confidence} confidence)`);
    for (const r of analysis.reasons) log.line(`  · ${r}`);
    for (const w of analysis.warnings) log.line(`  ! ${w}`, "warn");
    const eff = effectiveConfig(config, analysis);
    const useDockerfile = svc.type === "docker" || !!config.dockerfilePath || (analysis.dockerDetected && !config.runtime);
    const serviceType = svc.type === "static" || (svc.type === "web" && analysis.serviceType === "static" && !useDockerfile) ? "static" : (svc.type as "web");
    await setDeploymentState(deploymentId, { analysis: analysis as never });
    if (!svc.analysis) await db.update(services).set({ analysis: analysis as never }).where(eq(services.id, svc.id));
    await waitForDatabases(svc.id, log);

    // ---------------------------------------------------------------- Build (install, build, test, image)
    await markPhase(deploymentId, "build");
    const image = names.image(teamId, svc.id, deploymentId);
    const res = await buildImage({
      repoDir,
      image,
      cacheKey: svc.id,
      labels: { "skyhost.team": teamId, "skyhost.service": svc.id, "skyhost.deployment": deploymentId },
      config: { ...eff, spaFallback: config.spaFallback },
      serviceType,
      useDockerfile,
      buildEnv: resolved.env,
      onLine: (l, level) => log.line(l, level),
      signal: controller.signal,
    });
    await markPhase(deploymentId, "image");
    const port = serviceType === "static" ? 8080 : (eff.port ?? res.port);
    const buildSeconds = Math.round((Date.now() - started) / 1000);
    await setDeploymentState(deploymentId, { image: res.image, buildSeconds, configSnapshot: { ...config, port: port ?? undefined, startCommand: useDockerfile ? config.startCommand : undefined } as ServiceConfig });
    await db.insert(usageRecords).values({ teamId, serviceId: svc.id, metric: "build_seconds", quantity: buildSeconds, periodStart: new Date() });
    await log.flush();
    await enqueue("release", { deploymentId }, { jobId: `release-${deploymentId}` });
  } catch (e) {
    const err = e as Error & { phase?: string };
    const cancelled = err instanceof BuildError && err.phase === "cancelled";
    log.line(cancelled ? "Deployment cancelled" : `Build failed: ${err.message}`, "error");
    await log.flush();
    const files = repoDir ? { "package.json": await readSmall(repoDir, join(config.rootDir ?? ".", "package.json")), "requirements.txt": await readSmall(repoDir, join(config.rootDir ?? ".", "requirements.txt")) } : {};
    const diag = cancelled ? [] : analyzeErrors(log.text.join("\n"), { packageManager: config.packageManager, port: config.port, memoryMb: config.resources?.memoryMb, files: Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined)) as Record<string, string> });
    await setDeploymentState(deploymentId, { status: cancelled ? "cancelled" : "failed", error: err.message.slice(0, 2000), errorAnalysis: diag, finishedAt: new Date(), buildSeconds: Math.round((Date.now() - started) / 1000) });
    if (!cancelled) await deploymentFailedNotice(deploymentId, svc.name, teamId, svc.projectId, err.message, diag[0], log.text.slice(-40).join("\n"));
  } finally {
    cancelControllers.delete(deploymentId);
    await redis().del(`sh:cancel:${deploymentId}`);
    if (workDir) await removeWorkDir(workDir).catch(() => {});
  }
}

export async function deploymentFailedNotice(deploymentId: string, serviceName: string, teamId: string, projectId: string, error: string, diag?: { problem: string; cause: string; suggestedFix: string }, logs?: string) {
  await notify({
    teamId,
    event: "deployment.failed",
    title: `Deployment of ${serviceName} failed`,
    body: `${diag ? `${diag.problem}. ` : ""}${error}`.slice(0, 500) + " The previous version keeps running.",
    details: diag ? [["Cause", diag.cause], ["Suggested fix", diag.suggestedFix]] : undefined,
    logs,
    link: `/projects/${projectId}/deployments/${deploymentId}`,
    payload: { deploymentId, service: serviceName },
  });
  await audit(null, teamId, "deployment.failed", { type: "deployment", id: deploymentId }, { error: error.slice(0, 300) });
}

