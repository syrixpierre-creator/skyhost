import { connect as tlsConnect } from "node:tls";
import { lookup } from "node:dns/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  buckets, databaseConnections, databases, deployHooks, deploymentLogs, deployments, domains, environments, getDb, jobRuns, notificationChannels, outgoingWebhooks, screenshots, serviceInstances, services, volumes, volumeSnapshots, webhookDeliveries,
} from "@skyhost/db";
import { assertPublicUrl, decrypt, Redactor, safeFetch } from "@skyhost/shared/node";
import type { ServiceConfig } from "@skyhost/shared";
import {
  deleteBucket, ensureImage, getDocker, getObjectStore, LABEL, listManagedContainers, names, provisionBucket, removeContainer, runJob, setBucketVisibility, startContainer, stopContainer,
} from "@skyhost/engine";
import {
  channelMessage, createDeployment, decryptChannelConfig, enqueue, notify, publish, resolveServiceEnv, sendEmailNow, serverConfig, serviceHostname, signWebhook,
} from "@skyhost/core";
import { teamOfService } from "../deploy-log";
import { platformBackup } from "../offsite";
import { canaryAction } from "./release";

// ------------------------------------------------------------------------------------------- Jobs & cron runs
export async function processJob(data: { jobRunId: string }) {
  const db = getDb();
  const [run] = await db.select().from(jobRuns).where(eq(jobRuns.id, data.jobRunId));
  if (!run || run.status !== "queued") return;
  const [svc] = await db.select().from(services).where(eq(services.id, run.serviceId));
  const [inst] = await db.select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, run.serviceId), eq(serviceInstances.environmentId, run.environmentId)));
  const [dep] = inst?.liveDeploymentId ? await db.select().from(deployments).where(eq(deployments.id, inst.liveDeploymentId)) : [];
  if (!svc || !dep?.image) {
    await db.update(jobRuns).set({ status: "failed", output: "No released image for this service", finishedAt: new Date() }).where(eq(jobRuns.id, run.id));
    return;
  }
  const { teamId } = await teamOfService(svc.id);
  const config = (dep.configSnapshot ?? svc.config) as ServiceConfig;
  let command = run.kind === "oneoff" ? run.command : config.startCommand;
  if (!command) {
    // Use the image default command for cron jobs without an explicit command.
    const img = await getDocker().getImage(dep.image).inspect();
    command = [...(img.Config.Entrypoint ?? []), ...(img.Config.Cmd ?? [])].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  }
  const resolved = await resolveServiceEnv(svc.id, run.environmentId, { deploymentId: dep.id });
  const redactor = new Redactor().add(...resolved.secrets);
  const vols = await db.select().from(volumes).where(and(eq(volumes.serviceId, svc.id), eq(volumes.environmentId, run.environmentId)));
  await db.update(jobRuns).set({ status: "running", startedAt: new Date() }).where(eq(jobRuns.id, run.id));
  let output = "";
  const res = await runJob({
    id: run.id,
    image: dep.image,
    command,
    env: resolved.env,
    network: names.teamNetwork(teamId),
    teamId,
    serviceId: svc.id,
    cpu: config.resources.cpu,
    memoryMb: config.resources.memoryMb,
    timeoutSeconds: config.cron?.timeoutSeconds ?? 3600,
    volumes: vols.map((v) => ({ dockerVolume: v.dockerVolume, mountPath: v.mountPath })),
    onLine: (l) => {
      const line = redactor.apply(l);
      if (output.length < 512 * 1024) output += line + "\n";
      void publish(`service:${svc.id}`, { type: "job.log", jobId: run.id, line });
    },
  }).catch((e) => ({ exitCode: null, output: String((e as Error).message), timedOut: false }));
  const status = res.timedOut ? "timeout" : res.exitCode === 0 ? "succeeded" : "failed";
  await db.update(jobRuns).set({ status, exitCode: res.exitCode, output: (output || redactor.apply(res.output)).slice(-512 * 1024), finishedAt: new Date() }).where(eq(jobRuns.id, run.id));
  await publish(`service:${svc.id}`, { type: "job.finished", jobId: run.id, status });
  if (status !== "succeeded" && run.kind === "cron") await notify({ teamId, event: "service.crashed", title: `Cron job ${svc.name} ${status}`, body: `Exit code ${res.exitCode ?? "n/a"}`, link: `/projects/${svc.projectId}/services/${svc.id}?tab=jobs` });
}

// ------------------------------------------------------------------------------------------- Notifications
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, allowHosts?: string[]) {
  // safeFetch validates the URL and pins the connection to the validated public IP (no DNS rebinding).
  return safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "SKYHOST-Webhook/1.0", ...headers }, body: JSON.stringify(body), protocols: ["https:"], allowHosts, timeoutMs: 10_000 });
}

export async function processNotify(data: { channelId?: string; event?: string; payload?: Record<string, unknown>; email?: string; subject?: string; text?: string; html?: string }) {
  if (data.email) {
    await sendEmailNow({ to: data.email, subject: data.subject!, text: data.text!, html: data.html });
    return;
  }
  const [c] = await getDb().select().from(notificationChannels).where(eq(notificationChannels.id, data.channelId!));
  if (!c || !c.enabled) return;
  const cfg = decryptChannelConfig<{ url?: string; email?: string; botToken?: string; chatId?: string; phone?: string; apiKey?: string }>(c.configEnc);
  const p = data.payload as { title?: string; body?: string; link?: string };
  const plain = `${p.title ?? "SKYHOST"}\n${p.body ?? ""}${p.link ? `\n${p.link}` : ""}`.slice(0, 3500);
  if (c.kind === "telegram") {
    // Fixed provider hosts (users only give a token and an id): no SSRF lookup needed.
    const res = await postJson(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, { chat_id: cfg.chatId, text: plain, disable_web_page_preview: true }, {}, ["api.telegram.org"]);
    if (!res.ok) throw new Error(`telegram responded ${res.status}`);
    return;
  }
  if (c.kind === "whatsapp") {
    const url = `https://api.callmebot.com/whatsapp.php?${new URLSearchParams({ phone: cfg.phone!, text: plain, apikey: cfg.apiKey! })}`;
    const res = await safeFetch(url, { protocols: ["https:"], timeoutMs: 15_000 });
    if (!res.ok) throw new Error(`whatsapp (CallMeBot) responded ${res.status}`);
    return;
  }
  if (c.kind === "email") {
    await sendEmailNow({ to: cfg.email!, subject: `[SKYHOST] ${p.title}`, text: `${p.body}\n${p.link ?? ""}` });
    return;
  }
  const res = await postJson(cfg.url!, c.kind === "webhook" ? { event: data.event, ...p } : channelMessage(c.kind, p));
  if (!res.ok) throw new Error(`${c.kind} responded ${res.status}`);
}

export async function processWebhook(data: { deliveryId: string }) {
  const db = getDb();
  const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, data.deliveryId));
  if (!d || d.status === "delivered") return;
  const [hook] = await db.select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, d.webhookId));
  if (!hook?.enabled) return;
  const body = JSON.stringify(d.payload);
  const sig = signWebhook(decrypt(hook.secretEnc), body);
  let code: number | null = null;
  let error: string | null = null;
  try {
    const res = await safeFetch(hook.url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "SKYHOST-Webhook/1.0", "X-Skyhost-Event": d.event, "X-Skyhost-Delivery": d.id, "X-Skyhost-Signature": sig }, body, protocols: ["https:"], timeoutMs: 10_000 });
    code = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  await db.update(webhookDeliveries).set({ status: error ? "failed" : "delivered", responseCode: code, attempts: d.attempts + 1, lastError: error, deliveredAt: error ? null : new Date() }).where(eq(webhookDeliveries.id, d.id));
  if (error) throw new Error(error); // BullMQ retries with exponential backoff
}

// ------------------------------------------------------------------------------------------- Deletion
/**
 * Removes everything a deleted service left on the server: containers (apps, jobs, cron), volumes and their
 * snapshots, built images, screenshots and deployment logs. Nothing of it is reachable once the service is deleted.
 */
export async function purgeService(serviceId: string) {
  const db = getDb();
  const docker = getDocker();
  const store = getObjectStore();
  for (const c of await listManagedContainers({ [LABEL.service]: serviceId })) await removeContainer(c.Id, { graceSeconds: 10 }).catch(() => {});
  const vols = await db.select().from(volumes).where(eq(volumes.serviceId, serviceId));
  for (const v of vols) {
    for (const s of await db.select().from(volumeSnapshots).where(eq(volumeSnapshots.volumeId, v.id))) if (s.objectKey) await store.delete(s.objectKey).catch(() => {});
    await docker.getVolume(v.dockerVolume).remove({ force: true }).catch(() => {});
  }
  await db.delete(volumes).where(eq(volumes.serviceId, serviceId));
  // Images built for this service (and the image tags of every deployment). Pulled public images are left to
  // Docker's own pruning since other services may use them.
  const deps = await db.select({ id: deployments.id, image: deployments.image }).from(deployments).where(eq(deployments.serviceId, serviceId));
  const built = await docker.listImages({ filters: { label: [`${LABEL.service}=${serviceId}`] } }).catch(() => []);
  const refs = new Set<string>([...built.map((i) => i.Id), ...deps.map((d) => d.image).filter((i): i is string => !!i && /(^|\/)skyhost\//.test(i))]);
  for (const ref of refs) await docker.getImage(ref).remove({ force: true }).catch(() => {});
  for (const s of await db.select().from(screenshots).where(eq(screenshots.serviceId, serviceId))) if (s.objectKey) await store.delete(s.objectKey).catch(() => {});
  await db.delete(screenshots).where(eq(screenshots.serviceId, serviceId));
  const depIds = deps.map((d) => d.id);
  for (let i = 0; i < depIds.length; i += 500) await db.delete(deploymentLogs).where(inArray(deploymentLogs.deploymentId, depIds.slice(i, i + 500)));
  await db.delete(deployHooks).where(eq(deployHooks.serviceId, serviceId));
  await db.delete(databaseConnections).where(eq(databaseConnections.serviceId, serviceId));
  await db.update(serviceInstances).set({ status: "stopped", liveDeploymentId: null, canaryDeploymentId: null }).where(eq(serviceInstances.serviceId, serviceId));
}

// ------------------------------------------------------------------------------------------- Buckets
export async function processBucket(data: { action: string; bucketId: string }) {
  const [b] = await getDb().select().from(buckets).where(eq(buckets.id, data.bucketId));
  if (!b) return;
  const spec = { id: b.id, teamId: b.teamId, network: names.teamNetwork(b.teamId), bucketName: b.physicalName, accessKey: b.accessKey, secretKey: decrypt(b.secretKeyEnc, undefined, `bucket:${b.id}`), isPublic: b.isPublic };
  if (data.action === "provision") await provisionBucket(spec);
  if (data.action === "visibility") await setBucketVisibility(spec, b.isPublic);
  if (data.action === "delete") await deleteBucket(b.id);
}

// ------------------------------------------------------------------------------------------- Screenshots (SSRF-safe)
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, mobile: { width: 390, height: 844 } } as const;

/** A release goes live before Let's Encrypt has issued its certificate: wait for it instead of failing. */
const CERT_RETRIES = 10;
const isCertError = (m: string) => /ERR_CERT_|ERR_SSL_|certificate/i.test(m);

export async function processScreenshot(data: { screenshotId: string; attempt?: number }) {
  const db = getDb();
  const [s] = await db.select().from(screenshots).where(eq(screenshots.id, data.screenshotId));
  if (!s || s.status === "completed") return;
  const [svc] = await db.select().from(services).where(eq(services.id, s.serviceId));
  const [dep] = s.deploymentId ? await db.select().from(deployments).where(eq(deployments.id, s.deploymentId)) : [];
  const [env] = dep ? await db.select().from(environments).where(eq(environments.id, dep.environmentId)) : [];
  if (!svc || !env) return;
  const host = serviceHostname(svc, env);
  const url = `${serverConfig().SKYHOST_PUBLIC_SCHEME}://${host}${s.path}`;
  const { chromium } = await import("playwright");
  // The browser resolves the platform domain to the proxy only; every other host must be public (SSRF protection).
  const proxyHost = process.env.SKYHOST_SCREENSHOT_PROXY_HOST;
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (proxyHost) {
    const ip = (await lookup(proxyHost)).address;
    args.push(`--host-resolver-rules=MAP ${host} ${ip}`);
  }
  const browser = await chromium.launch({ headless: true, args, executablePath: process.env.SKYHOST_CHROMIUM_PATH || undefined });
  try {
    const vp = VIEWPORTS[s.viewport as keyof typeof VIEWPORTS] ?? VIEWPORTS.desktop;
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: s.viewport === "mobile" ? 2 : 1, isMobile: s.viewport === "mobile", userAgent: "SKYHOST-Screenshot/1.0", ignoreHTTPSErrors: !serverConfig().isProd, serviceWorkers: "block", acceptDownloads: false });
    const page = await ctx.newPage();
    await page.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === host) return route.continue();
      if (u.protocol === "data:" || u.protocol === "blob:") return route.continue();
      try {
        await assertPublicUrl(u.toString());
        return route.continue();
      } catch {
        return route.abort("blockedbyclient");
      }
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(async () => page.goto(url, { waitUntil: "load", timeout: 30_000 }));
    if (s.delayMs) await page.waitForTimeout(Math.min(s.delayMs, 15_000));
    const png = await page.screenshot({ fullPage: s.fullPage, type: "png", timeout: 20_000 });
    const key = `screenshots/${svc.projectId}/${svc.id}/${s.id}.png`;
    await getObjectStore().put(key, png, "image/png");
    await db.update(screenshots).set({ status: "completed", objectKey: key, sizeBytes: png.length, mimeType: "image/png" }).where(eq(screenshots.id, s.id));
    await publish(`service:${svc.id}`, { type: "screenshot.completed", screenshotId: s.id });
  } catch (e) {
    const message = (e as Error).message;
    const attempt = data.attempt ?? 0;
    if (isCertError(message) && attempt < CERT_RETRIES) {
      await db.update(screenshots).set({ status: "pending", error: "Waiting for the HTTPS certificate of the site" }).where(eq(screenshots.id, s.id));
      await enqueue("screenshot", { screenshotId: s.id, attempt: attempt + 1 }, { delay: 30_000 * (attempt + 1), attempts: 1 });
      return;
    }
    const friendly = isCertError(message) ? `The HTTPS certificate of ${host} is not valid yet (DNS or Let's Encrypt). ${message}` : message;
    await db.update(screenshots).set({ status: "failed", error: friendly.slice(0, 500) }).where(eq(screenshots.id, s.id));
    throw e;
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------------------------------- Maintenance tasks
async function instanceContainers(serviceId: string, environmentId: string) {
  return (await listManagedContainers({ [LABEL.service]: serviceId, [LABEL.environment]: environmentId, [LABEL.kind]: "app" })).map((c) => ({ id: c.Id, deployment: c.Labels[LABEL.deployment], state: c.State }));
}

async function liveContainers(serviceId: string, environmentId: string) {
  const [inst] = await getDb().select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, serviceId), eq(serviceInstances.environmentId, environmentId)));
  return { inst, containers: (await instanceContainers(serviceId, environmentId)).filter((c) => c.deployment === inst?.liveDeploymentId) };
}

async function checkCertificate(domainId: string) {
  const db = getDb();
  const [d] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!d || d.status === "ssl_issued") return;
  const target = process.env.SKYHOST_PROXY_TLS_HOST ?? "proxy";
  const ok = await new Promise<boolean>((resolve) => {
    const sock = tlsConnect({ host: target, port: 443, servername: d.hostname.replace(/^\*\./, "skyhost-check."), rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      const names_ = `${cert.subject?.CN ?? ""} ${cert.subjectaltname ?? ""}`;
      const valid = !/TRAEFIK DEFAULT CERT/i.test(names_) && names_.includes(d.hostname.replace(/^\*\./, "")) && new Date(cert.valid_to) > new Date();
      sock.end();
      resolve(valid);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
  if (ok) await db.update(domains).set({ status: "ssl_issued", certIssuedAt: new Date(), error: null }).where(eq(domains.id, d.id));
  else await enqueue("maintenance", { task: `check-certificate:${d.id}` }, { delay: 60_000, attempts: 1 });
}

export async function processMaintenance(data: { task: string }) {
  const [kind, ...rest] = data.task.split(":");
  const db = getDb();
  switch (kind) {
    case "reconcile-proxy":
      // Traefik polls the configuration endpoint; nothing to push. Kept for event ordering.
      return;
    case "teardown-service":
      return purgeService(rest[0]!);
    case "teardown-environment": {
      const [envId] = rest;
      for (const c of await listManagedContainers({ [LABEL.environment]: envId! })) await removeContainer(c.Id, { graceSeconds: 10 });
      await db.update(serviceInstances).set({ status: "stopped", liveDeploymentId: null }).where(eq(serviceInstances.environmentId, envId!));
      const dbs = await db.select().from(databases).where(eq(databases.environmentId, envId!));
      for (const d of dbs) {
        await db.update(databases).set({ deletedAt: new Date(), status: "deleting" }).where(eq(databases.id, d.id));
        await enqueue("database", { action: "delete", databaseId: d.id });
      }
      return;
    }
    case "stop":
    case "start":
    case "restart":
    case "wake": {
      const [serviceId, envId] = rest;
      const { inst, containers } = await liveContainers(serviceId!, envId!);
      if (!inst) return;
      const [svc] = await db.select().from(services).where(eq(services.id, serviceId!));
      for (const c of containers) {
        if (kind === "stop") await stopContainer(c.id, svc?.config.gracefulShutdownSeconds ?? 30);
        if (kind === "start" || kind === "wake") await startContainer(c.id);
        if (kind === "restart") await getDocker().getContainer(c.id).restart({ t: svc?.config.gracefulShutdownSeconds ?? 30 });
      }
      if (kind === "stop") await db.update(serviceInstances).set({ status: inst.pausedReason ? "paused" : "stopped" }).where(eq(serviceInstances.id, inst.id));
      else await db.update(serviceInstances).set({ status: "running", sleeping: false, lastRequestAt: new Date() }).where(eq(serviceInstances.id, inst.id));
      if (kind === "wake" && containers.length) await new Promise((r) => setTimeout(r, 1500));
      await publish(`service:${serviceId}`, { type: "instance.status", environmentId: envId, status: kind === "stop" ? "stopped" : "running" });
      return;
    }
    case "canary-promote":
      return canaryAction(rest[0]!, "promote");
    case "canary-abort":
      return canaryAction(rest[0]!, "abort");
    case "offsite-platform":
      return platformBackup();
    case "delete-volume":
      await getDocker().getVolume(rest.join(":")).remove().catch(() => {});
      return;
    case "snapshot-volume": {
      const [snapId] = rest;
      const [snap] = await db.select().from(volumeSnapshots).where(eq(volumeSnapshots.id, snapId!));
      const [v] = snap ? await db.select().from(volumes).where(eq(volumes.id, snap.volumeId)) : [];
      if (!snap || !v) return;
      await ensureImage("alpine:3.20");
      const c = await getDocker().createContainer({
        Image: "alpine:3.20",
        Cmd: ["tar", "czf", "-", "-C", "/data", "."],
        HostConfig: { Mounts: [{ Type: "volume", Source: v.dockerVolume, Target: "/data", ReadOnly: true }], NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: 256 * 1024 * 1024 },
        Labels: { [LABEL.managed]: "true", [LABEL.kind]: "job" },
      });
      try {
        await c.start();
        await c.wait();
        const raw = (await c.logs({ stdout: true, stderr: false })) as unknown as Buffer;
        // Strip multiplexing headers to recover the binary tar stream.
        const parts: Buffer[] = [];
        for (let i = 0; i + 8 <= raw.length; ) {
          const size = raw.readUInt32BE(i + 4);
          if (raw[i] === 1) parts.push(raw.subarray(i + 8, i + 8 + size));
          i += 8 + size;
        }
        const tgz = Buffer.concat(parts);
        const key = `volumes/${v.serviceId}/${v.id}/${snap.id}.tgz`;
        await getObjectStore().put(key, tgz, "application/gzip");
        await db.update(volumeSnapshots).set({ status: "completed", objectKey: key, sizeBytes: tgz.length }).where(eq(volumeSnapshots.id, snap.id));
      } catch (e) {
        await db.update(volumeSnapshots).set({ status: "failed" }).where(eq(volumeSnapshots.id, snap.id));
        throw e;
      } finally {
        await c.remove({ force: true }).catch(() => {});
      }
      return;
    }
    case "check-certificate":
      return checkCertificate(rest[0]!);
    case "move-project-network": {
      // After a project transfer, redeploy live services so they join the new team network.
      const svcs = await db.select().from(services).where(eq(services.projectId, rest[0]!));
      const insts = svcs.length ? await db.select().from(serviceInstances).where(inArray(serviceInstances.serviceId, svcs.map((s) => s.id))) : [];
      for (const i of insts) {
        if (!i.liveDeploymentId) continue;
        const [live] = await db.select().from(deployments).where(eq(deployments.id, i.liveDeploymentId));
        await createDeployment({ serviceId: i.serviceId, environmentId: i.environmentId, trigger: "config", image: live?.image ?? null, bypassFreeze: true }).catch(() => {});
      }
      return;
    }
  }
  void notify;
}
