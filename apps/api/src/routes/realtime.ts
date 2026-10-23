import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { getDb, serviceInstances, deployments, shellSessions } from "@skyhost/db";
import { Redactor } from "@skyhost/shared/node";
import { listManagedContainers, LABEL, runShellCommand, ShellRejected, streamLogs } from "@skyhost/engine";
import { audit, CHANNEL_PREFIX, redisSubscriber, resolveServiceEnv, serverConfig } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { databaseAccess, deploymentAccess, projectAccess, serviceAccess, teamAccess } from "../lib/authz";

/** One Redis pattern subscription per API process, fanned out to local sockets. */
const subscribers = new Map<string, Set<WebSocket>>();
let listening = false;

function ensureListener() {
  if (listening) return;
  listening = true;
  const sub = redisSubscriber();
  sub.psubscribe(`${CHANNEL_PREFIX}*`).catch(() => {
    listening = false;
  });
  sub.on("pmessage", (_p: string, channel: string, message: string) => {
    const set = subscribers.get(channel.slice(CHANNEL_PREFIX.length));
    if (!set) return;
    for (const ws of set) if (ws.readyState === 1) ws.send(message);
  });
}

function originAllowed(req: FastifyRequest) {
  // Browsers send an Origin on upgrade: cookie sessions are only accepted from the dashboard (cross-site WebSocket hijacking).
  if (!req.auth.session) return true;
  const origin = req.headers.origin;
  return !origin || origin === new URL(serverConfig().SKYHOST_DASHBOARD_URL).origin;
}

async function authorizeChannel(req: FastifyRequest, channel: string) {
  const [kind, id] = channel.split(":");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid channel");
  switch (kind) {
    case "deployment":
      return deploymentAccess(req, id, "logs:read");
    case "service":
      return serviceAccess(req, id, "service:read");
    case "project":
      return projectAccess(req, id, "project:read");
    case "database":
      return databaseAccess(req, id, "database:read");
    case "team":
      return teamAccess(req, id, "team:read");
    case "user":
      if (id !== req.auth.user!.id) throw new Error("Forbidden");
      return;
    default:
      throw new Error("Unknown channel");
  }
}

async function liveContainers(serviceId: string, environmentId: string) {
  const [inst] = await getDb().select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, serviceId), eq(serviceInstances.environmentId, environmentId)));
  if (!inst?.liveDeploymentId) return [];
  const [dep] = await getDb().select().from(deployments).where(eq(deployments.id, inst.liveDeploymentId));
  if (dep?.containers.length) return dep.containers;
  return (await listManagedContainers({ [LABEL.deployment]: inst.liveDeploymentId })).map((c) => c.Id);
}

export default async function realtimeRoutes(app: FastifyInstance) {
  /** Generic event stream: {"op":"subscribe","channel":"deployment:<id>"} */
  app.get("/ws", { websocket: true, config: { public: true } }, (socket, req) => {
    if (!req.auth.user || !originAllowed(req)) {
      socket.close(4401, "unauthorized");
      return;
    }
    ensureListener();
    const mine = new Set<string>();
    socket.on("message", async (raw) => {
      let msg: { op?: string; channel?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg.channel || typeof msg.channel !== "string") return;
      if (msg.op === "subscribe") {
        if (mine.size >= 50) return socket.send(JSON.stringify({ type: "error", message: "Too many subscriptions" }));
        try {
          await authorizeChannel(req, msg.channel);
        } catch {
          return socket.send(JSON.stringify({ type: "error", channel: msg.channel, message: "Not allowed" }));
        }
        mine.add(msg.channel);
        if (!subscribers.has(msg.channel)) subscribers.set(msg.channel, new Set());
        subscribers.get(msg.channel)!.add(socket);
        socket.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
      } else if (msg.op === "unsubscribe") {
        mine.delete(msg.channel);
        subscribers.get(msg.channel)?.delete(socket);
      }
    });
    socket.on("close", () => {
      for (const ch of mine) {
        const set = subscribers.get(ch);
        set?.delete(socket);
        if (set && !set.size) subscribers.delete(ch);
      }
    });
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 25_000);
    socket.on("close", () => clearInterval(ping));
  });

  /** Live runtime logs of a service (all replicas of the live deployment), secrets redacted. */
  app.get("/services/:id/logs/stream", { websocket: true, config: { public: true } }, async (socket, req) => {
    const { id } = req.params as { id: string };
    const { environmentId, tail } = req.query as { environmentId?: string; tail?: string };
    if (!req.auth.user || !originAllowed(req) || !environmentId) return socket.close(4401, "unauthorized");
    try {
      await serviceAccess(req, id, "logs:read");
    } catch {
      return socket.close(4403, "forbidden");
    }
    const env = await resolveServiceEnv(id, environmentId).catch(() => ({ secrets: [] as string[] }));
    const redactor = new Redactor().add(...env.secrets);
    const stops: Array<() => void> = [];
    for (const c of await liveContainers(id, environmentId)) {
      try {
        stops.push(await streamLogs(c, { follow: true, tail: Math.min(Number(tail ?? 200), 2000) }, (l) => socket.readyState === 1 && socket.send(JSON.stringify({ ...l, line: redactor.apply(l.line), replica: c.slice(-1) }))));
      } catch {
        /* container gone */
      }
    }
    if (!stops.length) socket.send(JSON.stringify({ ts: new Date().toISOString(), stream: "stderr", line: "No running instance for this environment." }));
    socket.on("close", () => stops.forEach((s) => s()));
  });

  /**
   * Secure shell: commands are validated against the allowlist and executed inside the service container
   * (never the host), outputs are redacted, the session is recorded and closed after 10 minutes of inactivity.
   */
  app.get("/services/:id/shell", { websocket: true, config: { public: true } }, async (socket, req) => {
    const { id } = req.params as { id: string };
    const { environmentId } = req.query as { environmentId?: string };
    if (!req.auth.user || !originAllowed(req) || !environmentId) return socket.close(4401, "unauthorized");
    let access;
    try {
      access = await serviceAccess(req, id, "shell:access");
    } catch {
      return socket.close(4403, "forbidden");
    }
    const containers = await liveContainers(id, environmentId);
    if (!containers.length) {
      socket.send(JSON.stringify({ type: "error", message: "The service has no running container in this environment." }));
      return socket.close(1000);
    }
    const container = containers[0]!;
    const env = await resolveServiceEnv(id, environmentId).catch(() => ({ secrets: [] as string[] }));
    const redactor = new Redactor().add(...env.secrets);
    const db = getDb();
    const [session] = await db.insert(shellSessions).values({ serviceId: id, environmentId, userId: req.auth.user.id, containerId: container, ip: req.ip }).returning();
    await audit(actorOf(req), access.team.id, "shell.session_started", { type: "service", id }, { sessionId: session!.id, environmentId });
    const transcript: Array<{ at: string; cmd: string; exitCode?: number | null; rejected?: boolean }> = [];
    let idle: NodeJS.Timeout;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        socket.send(JSON.stringify({ type: "info", message: "Session closed after 10 minutes of inactivity." }));
        socket.close(1000, "idle");
      }, 10 * 60_000);
    };
    resetIdle();
    let busy = false;
    let count = 0;
    socket.send(JSON.stringify({ type: "ready", runtime: access.service.config.runtime ?? null }));
    socket.on("message", async (raw) => {
      resetIdle();
      let msg: { cmd?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg.cmd || busy) return;
      if (++count > 500) return socket.close(1008, "too many commands");
      busy = true;
      const at = new Date().toISOString();
      try {
        const res = await runShellCommand(container, msg.cmd, access.service.config.runtime);
        transcript.push({ at, cmd: msg.cmd.slice(0, 500), exitCode: res.exitCode });
        socket.send(JSON.stringify({ type: "output", stdout: redactor.apply(res.stdout.toString()), stderr: redactor.apply(res.stderr.toString()), exitCode: res.exitCode }));
      } catch (e) {
        transcript.push({ at, cmd: msg.cmd.slice(0, 500), rejected: e instanceof ShellRejected });
        socket.send(JSON.stringify({ type: "error", message: e instanceof ShellRejected ? e.message : `Command failed: ${(e as Error).message}` }));
      } finally {
        busy = false;
      }
    });
    socket.on("close", async () => {
      clearTimeout(idle);
      await db.update(shellSessions).set({ endedAt: new Date(), transcript, endReason: "closed" }).where(eq(shellSessions.id, session!.id));
      await audit(actorOf(req), access.team.id, "shell.session_ended", { type: "service", id }, { sessionId: session!.id, commands: transcript.length });
    });
  });
}
