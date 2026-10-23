import { and, eq, inArray } from "drizzle-orm";
import { getDb, notificationChannels, notifications, outgoingWebhooks, teamMembers, users, webhookDeliveries } from "@skyhost/db";
import { decrypt, encrypt, hmacSha256, randomToken } from "@skyhost/shared/node";
import type { EventType } from "@skyhost/shared";
import { enqueue } from "./queue";
import { publish } from "./realtime";
import { renderEmail, sendMail } from "./mail";
import { serverConfig } from "./config";

export interface NotifyInput {
  teamId: string;
  event: EventType;
  title: string;
  body: string;
  link?: string;
  payload?: Record<string, unknown>;
  /** Restrict in-app/email notification to these users (e.g. invitation target). */
  userIds?: string[];
}

/** Events members receive by email unless they opt out. */
const EMAIL_BY_DEFAULT = new Set<string>(["deployment.failed", "database.backup.failed", "service.crashed", "billing.payment_failed", "spend.threshold", "quota.near_limit", "alert.triggered"]);

interface UserPrefs {
  [event: string]: { email?: boolean; web?: boolean } | unknown;
  quietHours?: { start: string; end: string; timezone: string } | null;
}

export function inQuietHours(q: { start: string; end: string; timezone: string } | null | undefined, now = new Date()): boolean {
  if (!q?.start || !q?.end) return false;
  const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: q.timezone || "UTC" });
  const hm = fmt.format(now);
  return q.start <= q.end ? hm >= q.start && hm < q.end : hm >= q.start || hm < q.end;
}

/**
 * Fan-out of a platform event: in-app notifications (+ realtime push), emails according to member preferences,
 * and team channels (Slack, Discord, email, outgoing webhooks) subscribed to the event.
 */
export async function notify(input: NotifyInput) {
  const db = getDb();
  const members = await db
    .select({ userId: users.id, email: users.email, prefs: users.notificationPrefs })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(input.userIds?.length ? and(eq(teamMembers.teamId, input.teamId), inArray(teamMembers.userId, input.userIds)) : eq(teamMembers.teamId, input.teamId));

  const link = input.link ? (input.link.startsWith("http") ? input.link : `${serverConfig().SKYHOST_DASHBOARD_URL}${input.link}`) : undefined;
  for (const m of members) {
    const prefs = (m.prefs ?? {}) as UserPrefs;
    const p = (prefs[input.event] ?? {}) as { email?: boolean; web?: boolean };
    if (p.web !== false) {
      const [n] = await db.insert(notifications).values({ userId: m.userId, teamId: input.teamId, type: input.event, title: input.title, body: input.body, link: input.link }).returning();
      await publish(`user:${m.userId}`, { type: "notification", notification: n });
    }
    const wantsEmail = p.email ?? EMAIL_BY_DEFAULT.has(input.event);
    if (wantsEmail && !inQuietHours(prefs.quietHours)) {
      const { text, html } = renderEmail(input.title, [input.body], link ? { label: "Open in SKYHOST", url: link } : undefined);
      await enqueue("notify", { email: m.email, subject: `[SKYHOST] ${input.title}`, text, html });
    }
  }

  const channels = await db.select().from(notificationChannels).where(and(eq(notificationChannels.teamId, input.teamId), eq(notificationChannels.enabled, true)));
  for (const c of channels) {
    if (c.events.length && !c.events.includes(input.event)) continue;
    if (inQuietHours(c.quietHours)) continue;
    await enqueue("notify", { channelId: c.id, event: input.event, payload: { title: input.title, body: input.body, link, ...input.payload } });
  }

  const hooks = await db.select().from(outgoingWebhooks).where(and(eq(outgoingWebhooks.teamId, input.teamId), eq(outgoingWebhooks.enabled, true)));
  for (const h of hooks) {
    if (h.events.length && !h.events.includes(input.event)) continue;
    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ webhookId: h.id, event: input.event, payload: { id: randomToken(12), event: input.event, createdAt: new Date().toISOString(), data: { title: input.title, body: input.body, link, ...input.payload } } })
      .returning();
    await enqueue("webhook", { deliveryId: delivery!.id }, { attempts: 6, backoff: { type: "exponential", delay: 10_000 } });
  }
}

/** Signature header sent with outgoing webhooks: t=<unix>,v1=<hmac_sha256(secret, `${t}.${body}`)> */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;
}

export function encryptChannelConfig(cfg: Record<string, unknown>) {
  return encrypt(JSON.stringify(cfg));
}

export function decryptChannelConfig<T = Record<string, string>>(enc: string): T {
  return JSON.parse(decrypt(enc)) as T;
}

/** Formats a channel message (used by the notify worker). */
export function channelMessage(kind: string, payload: { title?: string; body?: string; link?: string }) {
  const text = `*${payload.title ?? "SKYHOST"}*\n${payload.body ?? ""}${payload.link ? `\n${payload.link}` : ""}`;
  if (kind === "slack") return { text };
  if (kind === "discord") return { content: text.replace(/^\*(.*)\*$/m, "**$1**").slice(0, 1900) };
  return { title: payload.title, body: payload.body, link: payload.link };
}

export const sendEmailNow = sendMail;
