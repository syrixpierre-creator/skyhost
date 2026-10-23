import { and, eq, inArray, ne } from "drizzle-orm";
import { deployments, environments, getDb, gitInstallations, screenshots, serviceInstances, services, volumes } from "@skyhost/db";
import { analyzeErrors } from "@skyhost/analyzer";
import type { ServiceConfig } from "@skyhost/shared";
import {
  createAndStart, engineConfig, ensureNetwork, getDocker, HealthcheckError, imageExists, LABEL, names, pullImage, removeContainer, stopContainer, waitHealthy,
} from "@skyhost/engine";
import { getTeamPlan, internalHost, notify, providerClient, publicUrl, publish, resolveServiceEnv, serviceHostname, enqueue } from "@skyhost/core";
import { DeployLog, isCancelled, markPhase, setDeploymentState, teamOfService } from "../deploy-log";
import { deploymentFailedNotice } from "./build";

const LONG_RUNNING = new Set(["web", "static", "docker", "private", "worker"]);
const HTTP_TYPES = new Set(["web", "static", "docker", "private"]);

async function ensureVolumes(serviceId: string, environmentId: string, teamId: string) {
  const vols = await getDb().select().from(volumes).where(and(eq(volumes.serviceId, serviceId), eq(volumes.environmentId, environmentId)));
  for (const v of vols) {
    await getDocker()
      .createVolume({ Name: v.dockerVolume, Labels: { [LABEL.managed]: "true", [LABEL.team]: teamId, [LABEL.service]: serviceId } })
      .catch((e: Error) => {
        if (!/already exists/.test(e.message)) throw e;
      });
  }
  return vols.map((v) => ({ dockerVolume: v.dockerVolume, mountPath: v.mountPath }));
}

/**
 * Gives the new containers their internal DNS names only once they are healthy (no traffic to unready replicas).
 * Only possible with runc: gVisor and Kata sandboxes keep the network interface they started with, so reconnecting a
 * running container cuts it off (visitors get 502 while the app still listens inside). There, names are set at start.
 */
const lateAliases = () => engineConfig().runtime === "runc";
async function attachAliases(container: string, network: string, aliases: string[]) {
  const net = getDocker().getNetwork(network);
  await net.disconnect({ Container: container, Force: true });
  await net.connect({ Container: container, EndpointConfig: { Aliases: aliases } });
}

/** Release stage: Deploy → Health Check → Live, with zero downtime (blue/green). */
export async function processRelease(deploymentId: string) {
  const db = getDb();
  const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!dep || !["building", "queued"].includes(dep.status)) return;
  const [svc] = await db.select().from(services).where(eq(services.id, dep.serviceId));
  const [env] = await db.select().from(environments).where(eq(environments.id, dep.environmentId));
  if (!svc || !env) return;
  const { teamId, projectId } = await teamOfService(svc.id);
  const config = (dep.configSnapshot ?? svc.config) as ServiceConfig;
  const log = new DeployLog(deploymentId, "deploy");
  const network = names.teamNetwork(teamId);
  const created: string[] = [];
  try {
    await setDeploymentState(deploymentId, { status: "deploying", startedAt: dep.startedAt ?? new Date() });
    await markPhase(deploymentId, "deploy");
    if (!(await imageExists(dep.image!))) {
      log.line(`Pulling ${dep.image}`);
      await pullImage(dep.image!, (l) => log.line(l));
    }
    const [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, svc.id), eq(serviceInstances.environmentId, env.id)));
    const previousLiveId = inst?.liveDeploymentId ?? null;

    if (!LONG_RUNNING.has(svc.type)) {
      // Cron jobs and one-off jobs: the image is released; containers start per run.
      await goLive(dep.id, svc.id, env.id, previousLiveId, [], false);
      log.line(svc.type === "cron" ? `Cron job released. Schedule: ${config.cron?.schedule} (${config.cron?.timezone ?? "UTC"})` : "Job image released");
      await finish(log, dep.id, svc, env, teamId, projectId);
      return;
    }

    const port = config.port ?? (svc.type === "static" ? 8080 : null);
    const resolved = await resolveServiceEnv(svc.id, env.id, { port, deploymentId, commitSha: dep.commitSha });
    log.redactor.add(...resolved.secrets);
    for (const m of resolved.missingReferences) log.line(`Warning: reference ${m} could not be resolved`, "warn");
    const vols = await ensureVolumes(svc.id, env.id, teamId);
    await ensureNetwork(network, { [LABEL.team]: teamId });
    const plan = await getTeamPlan(teamId);
    const replicas = Math.max(1, Math.min(config.resources.replicas, 20));
    const cpu = Math.min(config.resources.cpu, plan.limits.cpu);
    const memoryMb = Math.min(config.resources.memoryMb, plan.limits.memoryMb);
    const svcType = svc.type;
    const command = svcType === "docker" || svc.source.kind === "image" ? (config.startCommand ?? null) : null;

    for (let i = 0; i < replicas; i++) {
      const name = names.appContainer(svc.id, dep.id, i);
      log.line(`Starting replica ${i + 1}/${replicas} (${cpu} vCPU, ${memoryMb} MB${engineConfig().runtime === "runc" ? "" : `, runtime ${engineConfig().runtime}`})`);
      created.push(name);
      await createAndStart({
        name,
        image: dep.image!,
        env: { ...resolved.env, SKYHOST_REPLICA: String(i) },
        command,
        network,
        networkLabels: { [LABEL.team]: teamId },
        aliases: lateAliases() ? [] : [internalHost(svc.slug, env), `${internalHost(svc.slug, env)}.internal`],
        labels: { [LABEL.kind]: "app", [LABEL.team]: teamId, [LABEL.project]: projectId, [LABEL.service]: svc.id, [LABEL.environment]: env.id, [LABEL.deployment]: dep.id },
        cpu,
        memoryMb,
        volumes: vols,
        stopGraceSeconds: config.gracefulShutdownSeconds,
        restart: "on-failure",
      });
    }

    await markPhase(deploymentId, "healthcheck");
    const hc = config.healthcheck;
    const checkHttp = HTTP_TYPES.has(svcType) && !!port && hc.enabled !== false;
    for (const name of created) {
      if (await isCancelled(deploymentId)) throw new HealthcheckError("Deployment cancelled", "");
      await waitHealthy({
        container: name,
        network,
        port: checkHttp ? (hc.port ?? port) : null,
        path: hc.path ?? "/",
        intervalSeconds: hc.intervalSeconds ?? 5,
        timeoutSeconds: hc.timeoutSeconds ?? 5,
        retries: hc.retries ?? 12,
        minUptimeSeconds: 5,
        onLine: (l) => log.line(l),
      });
    }
    const host = internalHost(svc.slug, env);
    if (lateAliases()) for (const name of created) await attachAliases(name, network, [host, `${host}.internal`]);

    if (dep.isCanary && previousLiveId) {
      await db.update(serviceInstances).set({ canaryDeploymentId: dep.id, canaryWeight: 10 }).where(eq(serviceInstances.id, inst!.id));
      await setDeploymentState(dep.id, { status: "live", phase: "live", containers: created, finishedAt: new Date() });
      log.line("Canary is live with 10% of the traffic. Promote or abort it from the dashboard.");
      await log.flush();
      return;
    }

    await goLive(dep.id, svc.id, env.id, previousLiveId, created, true);
    log.line(HTTP_TYPES.has(svcType) && svcType !== "private" ? `Live at ${publicUrl(serviceHostname(svc, env))}` : "Live");
    await finish(log, dep.id, svc, env, teamId, projectId);
    if (previousLiveId) await drainPrevious(previousLiveId, svc.id, config.gracefulShutdownSeconds);
  } catch (e) {
    const err = e as Error;
    const logs = e instanceof HealthcheckError ? e.logs : "";
    if (logs) for (const l of logs.split("\n").slice(-60)) if (l.trim()) log.line(`[app] ${l}`, "error");
    log.line(`Deployment failed: ${err.message}. The previous version stays live.`, "error");
    await log.flush();
    for (const c of created) await removeContainer(c, { graceSeconds: 1 });
    const diag = analyzeErrors(`${log.text.join("\n")}\n${logs}`, { port: config.port, memoryMb: config.resources?.memoryMb, packageManager: config.packageManager });
    await setDeploymentState(dep.id, { status: err.message === "Deployment cancelled" ? "cancelled" : "failed", error: err.message.slice(0, 2000), errorAnalysis: diag, finishedAt: new Date() });
    await deploymentFailedNotice(dep.id, svc.name, teamId, projectId, err.message, diag[0], `${log.text.slice(-20).join("\n")}\n${logs}`);
  }
}

async function goLive(deploymentId: string, serviceId: string, environmentId: string, previousLiveId: string | null, containers: string[], running: boolean) {
  const db = getDb();
  await db
    .insert(serviceInstances)
    .values({ serviceId, environmentId, liveDeploymentId: deploymentId, status: running ? "running" : "idle", sleeping: false, lastRequestAt: new Date(), restartCount: 0 })
    .onConflictDoUpdate({ target: [serviceInstances.serviceId, serviceInstances.environmentId], set: { liveDeploymentId: deploymentId, status: running ? "running" : "idle", sleeping: false, canaryDeploymentId: null, canaryWeight: 0, lastRequestAt: new Date(), restartCount: 0 } });
  await setDeploymentState(deploymentId, { status: "live", phase: "live", containers, finishedAt: new Date() });
  if (previousLiveId) await db.update(deployments).set({ status: "superseded" }).where(and(eq(deployments.id, previousLiveId), ne(deployments.id, deploymentId)));
  // Older builds of this environment that were still marked live (e.g. after a canary) are superseded too.
  await db.update(deployments).set({ status: "superseded" }).where(and(eq(deployments.serviceId, serviceId), eq(deployments.environmentId, environmentId), eq(deployments.status, "live"), ne(deployments.id, deploymentId)));
}

/** Waits for the proxy to pick the new routes, then stops the old version gracefully (SIGTERM, grace period). */
export async function drainPrevious(previousId: string, serviceId: string, graceSeconds: number) {
  const delay = Number(process.env.SKYHOST_PROXY_SWITCH_DELAY_MS ?? 6000);
  await new Promise((r) => setTimeout(r, delay));
  const [prev] = await getDb().select().from(deployments).where(eq(deployments.id, previousId));
  const names_ = prev?.containers.length ? prev.containers : [names.appContainer(serviceId, previousId, 0)];
  for (const c of names_) {
    await stopContainer(c, graceSeconds);
    await removeContainer(c, { graceSeconds: 1 });
  }
}

async function finish(log: DeployLog, deploymentId: string, svc: typeof services.$inferSelect, env: typeof environments.$inferSelect, teamId: string, projectId: string) {
  await log.flush();
  const db = getDb();
  const url = HTTP_TYPES.has(svc.type) && svc.type !== "private" ? publicUrl(serviceHostname(svc, env)) : null;
  await notify({ teamId, event: "deployment.succeeded", title: `${svc.name} is live`, body: url ? `Deployed to ${env.name}: ${url}` : `Deployed to ${env.name}`, link: `/projects/${projectId}/services/${svc.id}`, payload: { deploymentId, service: svc.name, environment: env.name, url } });
  await publish(`project:${projectId}`, { type: "service.live", serviceId: svc.id, environmentId: env.id, url });
  const [dep] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
  // Automatic captures after each live deployment (desktop + mobile) for services with a public URL.
  if (url && svc.config.autoScreenshots !== false && svc.type !== "worker") {
    const plan = await getTeamPlan(teamId);
    const { getUsage } = await import("@skyhost/core");
    const usage = await getUsage(teamId);
    const paths = (svc.config.screenshotPaths?.length ? svc.config.screenshotPaths : ["/"]).slice(0, 3);
    const wanted = paths.length * 2;
    if (usage.screenshotsPerMonth + wanted <= plan.limits.screenshotsPerMonth) {
      for (const path of paths) {
        for (const viewport of ["desktop", "mobile"] as const) {
          const [s] = await db.insert(screenshots).values({ serviceId: svc.id, projectId, deploymentId, commitSha: dep?.commitSha ?? null, kind: "auto", path, viewport, delayMs: 1000, title: dep?.commitMessage?.split("\n")[0]?.slice(0, 120) ?? null }).returning();
          await enqueue("screenshot", { screenshotId: s!.id }, { jobId: s!.id, attempts: 2, backoff: { type: "fixed", delay: 5000 } });
        }
      }
    }
  }
  // Preview environments: comment the URL on the pull request.
  if (env.type === "preview" && env.prNumber && url) {
    const src = svc.source as { kind: string; repo?: string; installationId?: string };
    if (src.installationId && src.repo) {
      const [inst] = await db.select().from(gitInstallations).where(eq(gitInstallations.id, src.installationId));
      if (inst) await providerClient(inst).commentOnPullRequest(src.repo, env.prNumber, `**${svc.name}** preview deployed (${dep?.commitSha?.slice(0, 7) ?? ""}): ${url}`).catch(() => {});
    }
  }
}

export async function canaryAction(instanceId: string, action: "promote" | "abort") {
  const db = getDb();
  const [inst] = await db.select().from(serviceInstances).where(eq(serviceInstances.id, instanceId));
  if (!inst?.canaryDeploymentId) return;
  const [svc] = await db.select().from(services).where(eq(services.id, inst.serviceId));
  const canaryId = inst.canaryDeploymentId;
  if (action === "promote") {
    const previous = inst.liveDeploymentId;
    const [canary] = await db.select().from(deployments).where(eq(deployments.id, canaryId));
    await goLive(canaryId, inst.serviceId, inst.environmentId, previous, canary?.containers ?? [], true);
    if (previous) await drainPrevious(previous, inst.serviceId, svc?.config.gracefulShutdownSeconds ?? 30);
  } else {
    await db.update(serviceInstances).set({ canaryDeploymentId: null, canaryWeight: 0 }).where(eq(serviceInstances.id, inst.id));
    await new Promise((r) => setTimeout(r, Number(process.env.SKYHOST_PROXY_SWITCH_DELAY_MS ?? 6000)));
    const [canary] = await db.select().from(deployments).where(eq(deployments.id, canaryId));
    for (const c of canary?.containers ?? []) await removeContainer(c, { graceSeconds: 10 });
    await db.update(deployments).set({ status: "stopped" }).where(eq(deployments.id, canaryId));
  }
  void inArray;
}
