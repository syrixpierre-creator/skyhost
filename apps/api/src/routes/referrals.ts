import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordReferralClick, referralDashboard, requestPayout, serverConfig } from "@skyhost/core";
import { route } from "../lib/http";

export default async function referralRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/referrals", tags: ["referrals"] }, async (req) => {
    const d = await referralDashboard(req.auth.user!.id);
    return { ...d, link: `${serverConfig().SKYHOST_DASHBOARD_URL}/r/${d.code}` };
  });

  route(app, { method: "POST", url: "/referrals/payout", tags: ["referrals"], body: z.object({ method: z.enum(["credit", "stripe_connect", "paypal"]), teamId: z.string().uuid().optional() }) }, async (req, reply, { body }) => {
    const payout = await requestPayout(req.auth.user!.id, body.method, body.teamId);
    reply.code(201);
    return { payout };
  });

  route(app, { method: "POST", url: "/public/referrals/:code/click", public: true, tags: ["referrals"], params: z.object({ code: z.string().regex(/^[a-z0-9]{4,32}$/i) }), rateLimit: { max: 30, timeWindow: "1 minute" } }, async (req, reply, { params }) => {
    const ref = await recordReferralClick(params.code, req.ip, req.headers["user-agent"] ?? null);
    if (!ref) return { valid: false };
    reply.setCookie("sh_ref", params.code.toLowerCase(), { path: "/", httpOnly: true, sameSite: "lax", secure: serverConfig().isProd, maxAge: 30 * 24 * 3600 });
    return { valid: true };
  });
}
