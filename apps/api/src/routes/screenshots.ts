import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { deployments, getDb, screenshots, serviceInstances } from "@skyhost/db";
import { randomId, randomToken, sha256 } from "@skyhost/shared/node";
import { getObjectStore } from "@skyhost/engine";
import { assertQuota, audit, badRequest, conflict, enqueue, notFound, serverConfig } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { screenshotAccess, serviceAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";

const MAX_UPLOAD = 25 * 1024 * 1024;

/** Detects the real file type from magic bytes; the client provided type is ignored. */
function sniffMime(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (b.subarray(0, 6).toString() === "GIF89a" || b.subarray(0, 6).toString() === "GIF87a") return "image/gif";
  if (b.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  return null;
}

function view(s: typeof screenshots.$inferSelect) {
  const { objectKey: _k, shareTokenHash, ...rest } = s;
  return { ...rest, shared: !!shareTokenHash && !s.shareRevokedAt && (!s.shareExpiresAt || s.shareExpiresAt > new Date()), imageUrl: `/api/v1/screenshots/${s.id}/image` };
}

export default async function screenshotRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/services/:id/screenshots", tags: ["screenshots"], params: idParam, query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }) }, async (req, _r, { params, query }) => {
    await serviceAccess(req, params.id, "service:read");
    const rows = await getDb()
      .select({ s: screenshots, d: deployments })
      .from(screenshots)
      .leftJoin(deployments, eq(deployments.id, screenshots.deploymentId))
      .where(eq(screenshots.serviceId, params.id))
      .orderBy(desc(screenshots.createdAt))
      .limit(query.limit);
    return { screenshots: rows.map(({ s, d }) => ({ ...view(s), commitMessage: d?.commitMessage ?? null, branch: d?.branch ?? null })) };
  });

  route(
    app,
    {
      method: "POST",
      url: "/services/:id/screenshots",
      tags: ["screenshots"],
      params: idParam,
      body: z.object({
        environmentId: z.string().uuid(),
        path: z.string().startsWith("/").max(512).default("/"),
        viewport: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
        fullPage: z.boolean().default(false),
        delayMs: z.number().int().min(0).max(15_000).default(0),
        title: z.string().max(120).optional(),
        description: z.string().max(2000).optional(),
      }),
    },
    async (req, reply, { params, body }) => {
      const a = await serviceAccess(req, params.id, "screenshot:create");
      if (!["web", "static", "docker"].includes(a.service.type)) throw badRequest("Only services with a public URL can be captured");
      const [inst] = await getDb().select().from(serviceInstances).where(and(eq(serviceInstances.serviceId, params.id), eq(serviceInstances.environmentId, body.environmentId)));
      if (!inst?.liveDeploymentId) throw badRequest("Deploy the service before capturing it");
      await assertQuota(a.team.id, "screenshotsPerMonth");
      const [live] = await getDb().select().from(deployments).where(eq(deployments.id, inst.liveDeploymentId));
      const [s] = await getDb()
        .insert(screenshots)
        .values({ serviceId: params.id, projectId: a.service.projectId, deploymentId: live!.id, commitSha: live!.commitSha, kind: "manual", path: body.path, viewport: body.viewport, fullPage: body.fullPage, delayMs: body.delayMs, title: body.title, description: body.description, createdBy: req.auth.user!.id })
        .returning();
      await enqueue("screenshot", { screenshotId: s!.id }, { jobId: s!.id, attempts: 2 });
      await audit(actorOf(req), a.team.id, "screenshot.capture", { type: "screenshot", id: s!.id }, { path: body.path, viewport: body.viewport });
      reply.code(201);
      return { screenshot: view(s!) };
    },
  );

  app.post("/services/:id/screenshots/upload", { schema: { tags: ["screenshots"], summary: "Upload an image or short video (multipart 'file', fields title/description/deploymentId)" } }, async (req, reply) => {
    if (!req.auth.user) return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required" } });
    const { id } = idParam.parse(req.params);
    const a = await serviceAccess(req, id, "screenshot:create");
    await assertQuota(a.team.id, "screenshotsPerMonth");
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!file) throw badRequest("Send the file in the 'file' field");
    const data = await file.toBuffer();
    if (file.file.truncated || data.length > MAX_UPLOAD) throw badRequest("Files are limited to 25 MB");
    const mime = sniffMime(data);
    if (!mime) throw badRequest("Only PNG, JPEG, WebP, GIF, MP4 and WebM files are accepted");
    const fields = Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: string })?.value]));
    let deploymentId: string | null = null;
    let commitSha: string | null = null;
    if (fields.deploymentId) {
      const [d] = await getDb().select().from(deployments).where(and(eq(deployments.id, String(fields.deploymentId)), eq(deployments.serviceId, id)));
      if (!d) throw badRequest("Unknown deployment");
      deploymentId = d.id;
      commitSha = d.commitSha;
    }
    const key = `screenshots/${a.team.id}/${id}/${randomId(16)}`;
    await getObjectStore().put(key, data, mime);
    const [s] = await getDb()
      .insert(screenshots)
      .values({ serviceId: id, projectId: a.service.projectId, deploymentId, commitSha, kind: "upload", status: "completed", mimeType: mime, objectKey: key, sizeBytes: data.length, title: String(fields.title ?? "").slice(0, 120) || null, description: String(fields.description ?? "").slice(0, 2000) || null, createdBy: req.auth.user.id })
      .returning();
    await audit(actorOf(req), a.team.id, "screenshot.upload", { type: "screenshot", id: s!.id }, { mime, size: data.length });
    reply.code(201);
    return { screenshot: view(s!) };
  });

  route(app, { method: "GET", url: "/screenshots/:id/image", tags: ["screenshots"], params: idParam }, async (req, reply, { params }) => {
    const a = await screenshotAccess(req, params.id, "service:read");
    if (!a.screenshot.objectKey) throw notFound("Image");
    const data = await getObjectStore().get(a.screenshot.objectKey);
    reply.header("Content-Type", a.screenshot.mimeType).header("Cache-Control", "private, max-age=3600").header("X-Content-Type-Options", "nosniff");
    return reply.send(data);
  });

  route(app, { method: "PATCH", url: "/screenshots/:id", tags: ["screenshots"], params: idParam, body: z.object({ title: z.string().max(120).nullable().optional(), description: z.string().max(2000).nullable().optional() }) }, async (req, _r, { params, body }) => {
    await screenshotAccess(req, params.id, "screenshot:create");
    const [s] = await getDb().update(screenshots).set(body).where(eq(screenshots.id, params.id)).returning();
    return { screenshot: view(s!) };
  });

  route(app, { method: "DELETE", url: "/screenshots/:id", tags: ["screenshots"], params: idParam }, async (req, _r, { params }) => {
    const a = await screenshotAccess(req, params.id, "screenshot:create");
    if (a.screenshot.objectKey) await getObjectStore().delete(a.screenshot.objectKey).catch(() => {});
    await getDb().delete(screenshots).where(eq(screenshots.id, params.id));
    await audit(actorOf(req), a.team.id, "screenshot.delete", { type: "screenshot", id: params.id });
    return { ok: true };
  });

  // Public share links: disabled by default, unguessable, expirable and revocable.
  route(app, { method: "POST", url: "/screenshots/:id/share", tags: ["screenshots"], params: idParam, body: z.object({ expiresInDays: z.number().int().min(1).max(365).nullable().default(30) }) }, async (req, _r, { params, body }) => {
    const a = await screenshotAccess(req, params.id, "screenshot:share");
    if (a.screenshot.status !== "completed") throw conflict("The capture is not ready yet");
    const token = randomToken(32);
    await getDb()
      .update(screenshots)
      .set({ shareTokenHash: sha256(token), shareExpiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null, shareRevokedAt: null })
      .where(eq(screenshots.id, params.id));
    await audit(actorOf(req), a.team.id, "screenshot.share_created", { type: "screenshot", id: params.id }, { expiresInDays: body.expiresInDays });
    return { url: `${serverConfig().SKYHOST_API_URL}/api/v1/public/screenshots/${token}`, pageUrl: `${serverConfig().SKYHOST_DASHBOARD_URL}/s/${token}`, expiresInDays: body.expiresInDays };
  });

  route(app, { method: "DELETE", url: "/screenshots/:id/share", tags: ["screenshots"], params: idParam }, async (req, _r, { params }) => {
    const a = await screenshotAccess(req, params.id, "screenshot:share");
    await getDb().update(screenshots).set({ shareRevokedAt: new Date() }).where(eq(screenshots.id, params.id));
    await audit(actorOf(req), a.team.id, "screenshot.share_revoked", { type: "screenshot", id: params.id });
    return { ok: true };
  });

  route(app, { method: "GET", url: "/public/screenshots/:token", public: true, tags: ["screenshots"], params: z.object({ token: z.string().min(20).max(100) }), rateLimit: { max: 120, timeWindow: "1 minute" } }, async (_req, reply, { params }) => {
    const [s] = await getDb()
      .select()
      .from(screenshots)
      .where(and(eq(screenshots.shareTokenHash, sha256(params.token)), isNull(screenshots.shareRevokedAt), or(isNull(screenshots.shareExpiresAt), gt(screenshots.shareExpiresAt, new Date()))));
    if (!s?.objectKey) throw notFound("Screenshot");
    const data = await getObjectStore().get(s.objectKey);
    reply.header("Content-Type", s.mimeType).header("Cache-Control", "public, max-age=300").header("X-Robots-Tag", "noindex").header("X-Content-Type-Options", "nosniff");
    return reply.send(data);
  });

  route(app, { method: "GET", url: "/public/screenshots/:token/meta", public: true, tags: ["screenshots"], params: z.object({ token: z.string().min(20).max(100) }) }, async (_req, _r, { params }) => {
    const [s] = await getDb()
      .select()
      .from(screenshots)
      .where(and(eq(screenshots.shareTokenHash, sha256(params.token)), isNull(screenshots.shareRevokedAt), or(isNull(screenshots.shareExpiresAt), gt(screenshots.shareExpiresAt, new Date()))));
    if (!s) throw notFound("Screenshot");
    return { title: s.title, description: s.description, viewport: s.viewport, mimeType: s.mimeType, createdAt: s.createdAt, commitSha: s.commitSha };
  });
}
