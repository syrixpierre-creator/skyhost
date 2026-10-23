import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { alertRules, getDb, notificationChannels, notifications, outgoingWebhooks, webhookDeliveries } from "@skyhost/db";
import { EVENT_TYPES } from "@skyhost/shared";
import { assertPublicUrl, decrypt, encrypt, randomToken } from "@skyhost/shared/node";
import { audit, badRequest, decryptChannelConfig, encryptChannelConfig, enqueue, notFound } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { serviceAccess, teamAccess } from "../lib/authz";
import { idParam, queryBool, route } from "../lib/http";

const teamParam = z.object({ teamId: z.string().uuid() });
const quiet = z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), timezone: z.string().max(64) }).nullable().default(null);

const channelBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack"), name: z.string().max(80), url: z.string().url().startsWith("https://hooks.slack.com/"), events: z.array(z.enum(EVENT_TYPES)).default([]), quietHours: quiet }),
  z.object({ kind: z.literal("discord"), name: z.string().max(80), url: z.string().url().regex(/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//), events: z.array(z.enum(EVENT_TYPES)).default([]), quietHours: quiet }),
  z.object({ kind: z.literal("email"), name: z.string().max(80), email: z.string().email(), events: z.array(z.enum(EVENT_TYPES)).default([]), quietHours: quiet }),
  z.object({ kind: z.literal("webhook"), name: z.string().max(80), url: z.string().url().startsWith("https://"), events: z.array(z.enum(EVENT_TYPES)).default([]), quietHours: quiet }),
]);

export default async function notificationRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------------- In-app
  route(app, { method: "GET", url: "/notifications", tags: ["notifications"], query: z.object({ unread: queryBool(), limit: z.coerce.number().int().min(1).max(100).default(30) }) }, async (req, _r, { query }) => {
    const rows = await getDb()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, req.auth.user!.id), query.unread ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(query.limit);
    const unread = (await getDb().select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, req.auth.user!.id), isNull(notifications.readAt)))).length;
    return { notifications: rows, unread };
  });

  route(app, { method: "POST", url: "/notifications/:id/read", tags: ["notifications"], params: idParam }, async (req, _r, { params }) => {
    await getDb().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, params.id), eq(notifications.userId, req.auth.user!.id)));
    return { ok: true };
  });

  route(app, { method: "POST", url: "/notifications/read-all", tags: ["notifications"] }, async (req) => {
    await getDb().update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, req.auth.user!.id), isNull(notifications.readAt)));
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Team channels
  route(app, { method: "GET", url: "/teams/:teamId/notification-channels", tags: ["notifications"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "team:read");
    const rows = await getDb().select().from(notificationChannels).where(eq(notificationChannels.teamId, params.teamId));
    return {
      channels: rows.map((c) => {
        const cfg = decryptChannelConfig<{ url?: string; email?: string }>(c.configEnc);
        return { id: c.id, kind: c.kind, name: c.name, events: c.events, quietHours: c.quietHours, enabled: c.enabled, target: cfg.email ?? (cfg.url ? cfg.url.replace(/(\/[^/]{6})[^/]*$/, "$1…") : null) };
      }),
    };
  });

  route(app, { method: "POST", url: "/teams/:teamId/notification-channels", tags: ["notifications"], params: teamParam, body: channelBody }, async (req, reply, { params, body }) => {
    await teamAccess(req, params.teamId, "notifications:manage");
    const cfg = "url" in body ? { url: body.url } : { email: body.email };
    if ("url" in body) await assertPublicUrl(body.url, { protocols: ["https:"] }).catch((e) => Promise.reject(badRequest((e as Error).message)));
    const [c] = await getDb().insert(notificationChannels).values({ teamId: params.teamId, kind: body.kind, name: body.name, configEnc: encryptChannelConfig(cfg), events: body.events, quietHours: body.quietHours }).returning();
    await audit(actorOf(req), params.teamId, "notification_channel.create", { type: "notification_channel", id: c!.id }, { kind: body.kind });
    reply.code(201);
    return { channel: { id: c!.id, kind: c!.kind, name: c!.name } };
  });

  route(app, { method: "PATCH", url: "/notification-channels/:id", tags: ["notifications"], params: idParam, body: z.object({ enabled: z.boolean().optional(), events: z.array(z.enum(EVENT_TYPES)).optional(), quietHours: quiet.optional(), name: z.string().max(80).optional() }) }, async (req, _r, { params, body }) => {
    const [c] = await getDb().select().from(notificationChannels).where(eq(notificationChannels.id, params.id));
    if (!c) throw notFound("Channel");
    await teamAccess(req, c.teamId, "notifications:manage");
    await getDb().update(notificationChannels).set(body).where(eq(notificationChannels.id, params.id));
    return { ok: true };
  });

  route(app, { method: "DELETE", url: "/notification-channels/:id", tags: ["notifications"], params: idParam }, async (req, _r, { params }) => {
    const [c] = await getDb().select().from(notificationChannels).where(eq(notificationChannels.id, params.id));
    if (!c) throw notFound("Channel");
    await teamAccess(req, c.teamId, "notifications:manage");
    await getDb().delete(notificationChannels).where(eq(notificationChannels.id, params.id));
    await audit(actorOf(req), c.teamId, "notification_channel.delete", { type: "notification_channel", id: c.id });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/notification-channels/:id/test", tags: ["notifications"], params: idParam }, async (req, _r, { params }) => {
    const [c] = await getDb().select().from(notificationChannels).where(eq(notificationChannels.id, params.id));
    if (!c) throw notFound("Channel");
    await teamAccess(req, c.teamId, "notifications:manage");
    await enqueue("notify", { channelId: c.id, event: "test", payload: { title: "SKYHOST test notification", body: `Sent by ${req.auth.user!.name}. This channel works.` } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Outgoing webhooks (HMAC signed)
  route(app, { method: "GET", url: "/teams/:teamId/webhooks", tags: ["webhooks"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "team:read");
    const rows = await getDb().select().from(outgoingWebhooks).where(eq(outgoingWebhooks.teamId, params.teamId));
    return { webhooks: rows.map(({ secretEnc: _s, ...w }) => w) };
  });

  route(app, { method: "POST", url: "/teams/:teamId/webhooks", tags: ["webhooks"], params: teamParam, body: z.object({ url: z.string().url().max(2048), events: z.array(z.enum(EVENT_TYPES)).default([]) }) }, async (req, reply, { params, body }) => {
    await teamAccess(req, params.teamId, "webhook:manage");
    await assertPublicUrl(body.url, { protocols: ["https:"] }).catch((e) => Promise.reject(badRequest((e as Error).message)));
    const secret = `whsk_${randomToken(24)}`;
    const [w] = await getDb().insert(outgoingWebhooks).values({ teamId: params.teamId, url: body.url, secretEnc: encrypt(secret), events: body.events }).returning();
    await audit(actorOf(req), params.teamId, "webhook.create", { type: "webhook", id: w!.id }, { url: body.url, events: body.events });
    reply.code(201);
    // The signing secret is displayed once.
    return { webhook: { id: w!.id, url: w!.url, events: w!.events, enabled: w!.enabled }, secret };
  });

  route(app, { method: "PATCH", url: "/webhooks/:id", tags: ["webhooks"], params: idParam, body: z.object({ enabled: z.boolean().optional(), events: z.array(z.enum(EVENT_TYPES)).optional() }) }, async (req, _r, { params, body }) => {
    const [w] = await getDb().select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, params.id));
    if (!w) throw notFound("Webhook");
    await teamAccess(req, w.teamId, "webhook:manage");
    await getDb().update(outgoingWebhooks).set(body).where(eq(outgoingWebhooks.id, params.id));
    return { ok: true };
  });

  route(app, { method: "DELETE", url: "/webhooks/:id", tags: ["webhooks"], params: idParam }, async (req, _r, { params }) => {
    const [w] = await getDb().select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, params.id));
    if (!w) throw notFound("Webhook");
    await teamAccess(req, w.teamId, "webhook:manage");
    await getDb().delete(outgoingWebhooks).where(eq(outgoingWebhooks.id, params.id));
    await audit(actorOf(req), w.teamId, "webhook.delete", { type: "webhook", id: w.id });
    return { ok: true };
  });

  route(app, { method: "GET", url: "/webhooks/:id/deliveries", tags: ["webhooks"], params: idParam }, async (req, _r, { params }) => {
    const [w] = await getDb().select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, params.id));
    if (!w) throw notFound("Webhook");
    await teamAccess(req, w.teamId, "webhook:manage");
    return { deliveries: await getDb().select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, params.id)).orderBy(desc(webhookDeliveries.createdAt)).limit(100) };
  });

  route(app, { method: "POST", url: "/webhooks/:id/rotate-secret", tags: ["webhooks"], params: idParam }, async (req, _r, { params }) => {
    const [w] = await getDb().select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, params.id));
    if (!w) throw notFound("Webhook");
    await teamAccess(req, w.teamId, "webhook:manage");
    const secret = `whsk_${randomToken(24)}`;
    await getDb().update(outgoingWebhooks).set({ secretEnc: encrypt(secret) }).where(eq(outgoingWebhooks.id, params.id));
    await audit(actorOf(req), w.teamId, "webhook.secret_rotated", { type: "webhook", id: w.id });
    void decrypt;
    return { secret };
  });

  // ---------------------------------------------------------------------------------- Alerts
  route(app, { method: "GET", url: "/teams/:teamId/alerts", tags: ["alerts"], params: teamParam }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "metrics:read");
    return { rules: await getDb().select().from(alertRules).where(eq(alertRules.teamId, params.teamId)) };
  });

  route(
    app,
    { method: "POST", url: "/teams/:teamId/alerts", tags: ["alerts"], params: teamParam, body: z.object({ serviceId: z.string().uuid().nullable().default(null), metric: z.enum(["cpu", "memory", "crash", "unhealthy", "deploy_failed", "quota"]), threshold: z.number().min(0).max(100).nullable().default(null), durationMinutes: z.number().int().min(1).max(1440).default(5) }) },
    async (req, reply, { params, body }) => {
      await teamAccess(req, params.teamId, "notifications:manage");
      if (body.serviceId) {
        const a = await serviceAccess(req, body.serviceId, "metrics:read");
        if (a.team.id !== params.teamId) throw notFound("Service");
      }
      if ((body.metric === "cpu" || body.metric === "memory" || body.metric === "quota") && body.threshold == null) throw badRequest("A threshold (percent) is required");
      const [r] = await getDb().insert(alertRules).values({ teamId: params.teamId, ...body }).returning();
      reply.code(201);
      return { rule: r };
    },
  );

  route(app, { method: "DELETE", url: "/alerts/:id", tags: ["alerts"], params: idParam }, async (req, _r, { params }) => {
    const [r] = await getDb().select().from(alertRules).where(eq(alertRules.id, params.id));
    if (!r) throw notFound("Alert rule");
    await teamAccess(req, r.teamId, "notifications:manage");
    await getDb().delete(alertRules).where(eq(alertRules.id, params.id));
    return { ok: true };
  });
}
