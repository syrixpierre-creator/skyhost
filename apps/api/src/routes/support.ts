import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, supportMessages, supportTickets, teamMembers, users } from "@skyhost/db";
import { audit, emailAdmins, enqueue, notFound, renderEmail, serverConfig } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { requireAdmin } from "../lib/authz";
import { idParam, route } from "../lib/http";

const CATEGORIES = ["technical", "billing", "account", "abuse", "other"] as const;
const body = z.string().trim().min(1).max(10_000);

/** The ticket if the caller opened it, or any ticket for an administrator. */
async function ticketAccess(req: FastifyRequest, id: string) {
  const [t] = await getDb().select().from(supportTickets).where(eq(supportTickets.id, id));
  const u = req.auth.user!;
  const staff = u.isAdmin && !req.auth.session?.impersonatorId && !req.auth.apiKey;
  if (!t || (t.userId !== u.id && !staff)) throw notFound("Ticket");
  return { ticket: t, staff };
}

async function emailUser(userId: string, subject: string, paragraphs: string[], ticketId: string) {
  const [u] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!u) return;
  const { text, html } = renderEmail(subject, paragraphs, { label: "Open the ticket", url: `${serverConfig().SKYHOST_DASHBOARD_URL}/support/${ticketId}` });
  await enqueue("notify", { email: u.email, subject: `[SKYHOST support] ${subject}`, text, html });
}

export default async function supportRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/support/tickets", tags: ["support"] }, async (req) => ({
    tickets: await getDb().select().from(supportTickets).where(eq(supportTickets.userId, req.auth.user!.id)).orderBy(desc(supportTickets.lastMessageAt)).limit(100),
  }));

  route(
    app,
    { method: "POST", url: "/support/tickets", tags: ["support"], body: z.object({ subject: z.string().trim().min(3).max(150), category: z.enum(CATEGORIES).default("technical"), body, teamId: z.string().uuid().optional() }), rateLimit: { max: 10, timeWindow: "1 hour" } },
    async (req, reply, { body: b }) => {
      const db = getDb();
      const u = req.auth.user!;
      // A team is only attached when the user belongs to it.
      const [member] = b.teamId ? await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, b.teamId), eq(teamMembers.userId, u.id))) : [];
      const [t] = await db.insert(supportTickets).values({ userId: u.id, teamId: member ? b.teamId! : null, subject: b.subject, category: b.category }).returning();
      await db.insert(supportMessages).values({ ticketId: t!.id, authorId: u.id, body: b.body });
      await audit(actorOf(req), t!.teamId, "support.ticket_opened", { type: "support_ticket", id: t!.id }, { category: b.category });
      await emailAdmins(`New ticket: ${b.subject}`, [`From ${u.name} <${u.email}> · ${b.category}`, b.body.slice(0, 2000)], { link: `/support/${t!.id}` });
      reply.code(201);
      return { ticket: t };
    },
  );

  route(app, { method: "GET", url: "/support/tickets/:id", tags: ["support"], params: idParam }, async (req, _r, { params }) => {
    const { ticket, staff } = await ticketAccess(req, params.id);
    const db = getDb();
    const messages = await db
      .select({ id: supportMessages.id, body: supportMessages.body, fromStaff: supportMessages.fromStaff, createdAt: supportMessages.createdAt, author: users.name })
      .from(supportMessages)
      .leftJoin(users, eq(users.id, supportMessages.authorId))
      .where(eq(supportMessages.ticketId, ticket.id))
      .orderBy(supportMessages.createdAt);
    const [owner] = staff ? await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, ticket.userId)) : [];
    // Staff names stay private to users: replies are signed "SKYHOST support".
    return { ticket, owner: owner ?? null, messages: messages.map((m) => ({ ...m, author: m.fromStaff && !staff ? "SKYHOST support" : m.author })), staff };
  });

  route(app, { method: "POST", url: "/support/tickets/:id/messages", tags: ["support"], params: idParam, body: z.object({ body }), rateLimit: { max: 60, timeWindow: "1 hour" } }, async (req, reply, { params, body: b }) => {
    const { ticket, staff } = await ticketAccess(req, params.id);
    const fromStaff = staff && ticket.userId !== req.auth.user!.id;
    const db = getDb();
    await db.insert(supportMessages).values({ ticketId: ticket.id, authorId: req.auth.user!.id, fromStaff, body: b.body });
    await db.update(supportTickets).set({ status: fromStaff ? "answered" : "open", lastMessageAt: new Date(), closedAt: null }).where(eq(supportTickets.id, ticket.id));
    if (fromStaff) await emailUser(ticket.userId, `Reply to "${ticket.subject}"`, [b.body.slice(0, 4000)], ticket.id);
    else await emailAdmins(`Ticket updated: ${ticket.subject}`, [b.body.slice(0, 2000)], { link: `/support/${ticket.id}` });
    reply.code(201);
    return { ok: true };
  });

  route(app, { method: "POST", url: "/support/tickets/:id/close", tags: ["support"], params: idParam }, async (req, _r, { params }) => {
    const { ticket } = await ticketAccess(req, params.id);
    await getDb().update(supportTickets).set({ status: "closed", closedAt: new Date() }).where(eq(supportTickets.id, ticket.id));
    return { ok: true };
  });

  route(app, { method: "GET", url: "/admin/support", tags: ["admin"], query: z.object({ status: z.enum(["open", "answered", "closed"]).optional() }) }, async (req, _r, { query }) => {
    requireAdmin(req);
    const db = getDb();
    const rows = await db
      .select({ ticket: supportTickets, name: users.name, email: users.email })
      .from(supportTickets)
      .innerJoin(users, eq(users.id, supportTickets.userId))
      .where(query.status ? eq(supportTickets.status, query.status) : inArray(supportTickets.status, ["open", "answered"]))
      .orderBy(desc(supportTickets.lastMessageAt))
      .limit(200);
    return { tickets: rows.map((r) => ({ ...r.ticket, userName: r.name, userEmail: r.email })) };
  });
}
