import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { buckets, getDb } from "@skyhost/db";
import { decrypt, encrypt, randomId, randomPassword } from "@skyhost/shared/node";
import { bucketPublicHost, bucketUsageBytes, presignUrl } from "@skyhost/engine";
import { assertFeature, assertQuota, audit, badRequest, conflict, enqueue, serverConfig } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { bucketAccess, projectAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";

const aad = (id: string) => `bucket:${id}`;

function view(b: typeof buckets.$inferSelect) {
  const scheme = serverConfig().SKYHOST_PUBLIC_SCHEME;
  return { id: b.id, projectId: b.projectId, name: b.name, isPublic: b.isPublic, quotaMb: b.quotaMb, endpoint: `${scheme}://${bucketPublicHost(b.id)}`, bucket: b.physicalName, region: "us-east-1", internalEndpoint: `http://s3-${b.name}.internal:9000`, createdAt: b.createdAt };
}

export default async function storageRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/projects/:id/buckets", tags: ["storage"], params: idParam }, async (req, _r, { params }) => {
    await projectAccess(req, params.id, "project:read");
    return { buckets: (await getDb().select().from(buckets).where(and(eq(buckets.projectId, params.id), isNull(buckets.deletedAt)))).map(view) };
  });

  route(
    app,
    { method: "POST", url: "/buckets", tags: ["storage"], body: z.object({ projectId: z.string().uuid(), name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/), isPublic: z.boolean().default(false), quotaMb: z.number().int().min(100).max(1_048_576).default(1024) }) },
    async (req, reply, { body }) => {
      const a = await projectAccess(req, body.projectId, "storage:manage");
      await assertFeature(a.team.id, "objectStorage");
      await assertQuota(a.team.id, "buckets");
      await assertQuota(a.team.id, "bucketStorageMb", body.quotaMb);
      const db = getDb();
      const [dup] = await db.select().from(buckets).where(and(eq(buckets.projectId, body.projectId), eq(buckets.name, body.name), isNull(buckets.deletedAt)));
      if (dup) throw conflict("A bucket with this name already exists in the project");
      const accessKey = `SKY${randomId(17, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789")}`;
      const secret = randomPassword(40);
      const [b] = await db
        .insert(buckets)
        .values({ teamId: a.team.id, projectId: body.projectId, name: body.name, physicalName: body.name, isPublic: body.isPublic, accessKey, secretKeyEnc: "pending", quotaMb: body.quotaMb })
        .returning();
      await db.update(buckets).set({ secretKeyEnc: encrypt(secret, undefined, aad(b!.id)) }).where(eq(buckets.id, b!.id));
      await enqueue("bucket", { action: "provision", bucketId: b!.id }, { attempts: 3, backoff: { type: "exponential", delay: 5000 } });
      await audit(actorOf(req), a.team.id, "bucket.create", { type: "bucket", id: b!.id }, { name: body.name, isPublic: body.isPublic });
      reply.code(201);
      return { bucket: view(b!), credentials: { accessKeyId: accessKey, secretAccessKey: secret } };
    },
  );

  route(app, { method: "GET", url: "/buckets/:id/credentials", tags: ["storage"], params: idParam }, async (req, _r, { params }) => {
    const a = await bucketAccess(req, params.id, "storage:manage");
    await audit(actorOf(req), a.team.id, "bucket.credentials_viewed", { type: "bucket", id: params.id });
    return { credentials: { accessKeyId: a.bucket.accessKey, secretAccessKey: decrypt(a.bucket.secretKeyEnc, undefined, aad(a.bucket.id)) }, bucket: view(a.bucket) };
  });

  route(app, { method: "PATCH", url: "/buckets/:id", tags: ["storage"], params: idParam, body: z.object({ isPublic: z.boolean().optional(), quotaMb: z.number().int().min(100).max(1_048_576).optional() }) }, async (req, _r, { params, body }) => {
    const a = await bucketAccess(req, params.id, "storage:manage");
    if (body.quotaMb && body.quotaMb > a.bucket.quotaMb) await assertQuota(a.team.id, "bucketStorageMb", body.quotaMb - a.bucket.quotaMb);
    const [b] = await getDb().update(buckets).set(body).where(eq(buckets.id, params.id)).returning();
    if (body.isPublic !== undefined) await enqueue("bucket", { action: "visibility", bucketId: params.id });
    await audit(actorOf(req), a.team.id, "bucket.update", { type: "bucket", id: params.id }, body);
    return { bucket: view(b!) };
  });

  route(
    app,
    { method: "POST", url: "/buckets/:id/presign", tags: ["storage"], params: idParam, body: z.object({ key: z.string().min(1).max(1024).regex(/^[^\0]+$/), method: z.enum(["GET", "PUT"]).default("GET"), expiresSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(3600) }) },
    async (req, _r, { params, body }) => {
      const a = await bucketAccess(req, params.id, "storage:manage");
      if (body.key.startsWith("/") || body.key.includes("..")) throw badRequest("Invalid object key");
      const url = await presignUrl({ id: a.bucket.id, accessKey: a.bucket.accessKey, secretKey: decrypt(a.bucket.secretKeyEnc, undefined, aad(a.bucket.id)), bucketName: a.bucket.physicalName }, body.key, body.method, body.expiresSeconds);
      return { url, expiresAt: new Date(Date.now() + body.expiresSeconds * 1000) };
    },
  );

  route(app, { method: "GET", url: "/buckets/:id/usage", tags: ["storage"], params: idParam }, async (req, _r, { params }) => {
    const a = await bucketAccess(req, params.id, "project:read");
    const bytes = await bucketUsageBytes({ id: a.bucket.id, network: (await import("@skyhost/engine")).names.teamNetwork(a.team.id), accessKey: a.bucket.accessKey, secretKey: decrypt(a.bucket.secretKeyEnc, undefined, aad(a.bucket.id)), bucketName: a.bucket.physicalName }).catch(() => null);
    return { usedBytes: bytes, quotaMb: a.bucket.quotaMb };
  });

  route(app, { method: "DELETE", url: "/buckets/:id", tags: ["storage"], params: idParam, body: z.object({ confirmName: z.string() }) }, async (req, _r, { params, body }) => {
    const a = await bucketAccess(req, params.id, "storage:manage");
    if (body.confirmName !== a.bucket.name) throw badRequest("Type the bucket name to confirm");
    await getDb().update(buckets).set({ deletedAt: new Date() }).where(eq(buckets.id, params.id));
    await enqueue("bucket", { action: "delete", bucketId: params.id });
    await audit(actorOf(req), a.team.id, "bucket.delete", { type: "bucket", id: params.id }, { name: a.bucket.name });
    return { ok: true };
  });
}
