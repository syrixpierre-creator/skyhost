import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { AppError, redis, serverConfig } from "@skyhost/core";
import { registerAuth } from "./lib/auth";
import authRoutes from "./routes/auth";
import accountRoutes from "./routes/account";
import teamRoutes from "./routes/teams";
import projectRoutes from "./routes/projects";
import serviceRoutes from "./routes/services";
import deploymentRoutes from "./routes/deployments";
import variableRoutes from "./routes/variables";
import domainRoutes from "./routes/domains";
import databaseRoutes from "./routes/databases";
import storageRoutes from "./routes/storage";
import gitRoutes from "./routes/git";
import webhookRoutes from "./routes/webhooks";
import billingRoutes from "./routes/billing";
import referralRoutes from "./routes/referrals";
import screenshotRoutes from "./routes/screenshots";
import notificationRoutes from "./routes/notifications";
import adminRoutes from "./routes/admin";
import internalRoutes from "./routes/internal";
import publicRoutes from "./routes/public";
import realtimeRoutes from "./routes/realtime";
import observabilityRoutes from "./routes/observability";

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = serverConfig();
  const app = Fastify({
    logger: cfg.isTest ? false : { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'] },
    trustProxy: process.env.SKYHOST_TRUST_PROXY ?? true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: cfg.isTest,
  });

  // Keep the raw body: webhook signatures are computed over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch {
      const err = new Error("Invalid JSON body") as FastifyError;
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body: string, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(body);
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });
  // Validation is done with zod inside handlers; JSON schemas are only used for the OpenAPI document.
  app.setValidatorCompiler(() => () => true);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], imgSrc: ["'self'", "data:"], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'", "'unsafe-inline'"] } },
    hsts: cfg.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cors, {
    origin: [cfg.SKYHOST_DASHBOARD_URL],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
  });
  await app.register(cookie, { secret: cfg.SKYHOST_SESSION_SECRET });
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.SKYHOST_RATE_LIMIT ?? 600),
    timeWindow: "1 minute",
    redis: redis(),
    nameSpace: "sh:rl:",
    keyGenerator: (req) => (req.headers.authorization?.startsWith("Bearer ") ? `key:${req.headers.authorization.slice(7, 20)}` : `ip:${req.ip}`),
    allowList: (req) => req.url.startsWith("/internal/"),
  });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 20 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(swagger, {
    openapi: {
      info: { title: "SKYHOST API", version: "1.0.0", description: "SKYHOST by SYRIX VISION COMPANY — REST API v1. Authenticate with the session cookie or `Authorization: Bearer sky_...` API keys." },
      servers: [{ url: cfg.SKYHOST_API_URL }],
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", description: "API key (sky_...)" },
          cookie: { type: "apiKey", in: "cookie", name: "sh_session" },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });

  registerAuth(app);

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests, please slow down" } });
    if (status < 500) return reply.code(status).send({ error: { code: (err as FastifyError).code ?? "bad_request", message: err.message } });
    req.log.error(err);
    // Never leak stack traces or internal messages in production.
    return reply.code(500).send({ error: { code: "internal", message: cfg.isProd ? "Internal server error" : err.message } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: "not_found", message: `Route ${req.method} ${req.url.split("?")[0]} not found` } }));

  app.get("/healthz", { config: { public: true, rateLimit: false } }, async () => ({ ok: true }));
  app.get("/readyz", { config: { public: true, rateLimit: false } }, async (_req, reply) => {
    try {
      await redis().ping();
      const { getDb } = await import("@skyhost/db");
      await getDb().execute((await import("drizzle-orm")).sql`select 1`);
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(accountRoutes);
      await v1.register(teamRoutes);
      await v1.register(projectRoutes);
      await v1.register(serviceRoutes);
      await v1.register(deploymentRoutes);
      await v1.register(variableRoutes);
      await v1.register(domainRoutes);
      await v1.register(databaseRoutes);
      await v1.register(storageRoutes);
      await v1.register(gitRoutes);
      await v1.register(webhookRoutes);
      await v1.register(billingRoutes);
      await v1.register(referralRoutes);
      await v1.register(screenshotRoutes);
      await v1.register(notificationRoutes);
      await v1.register(adminRoutes);
      await v1.register(publicRoutes);
      await v1.register(realtimeRoutes);
      await v1.register(observabilityRoutes);
    },
    { prefix: "/api/v1" },
  );
  await app.register(internalRoutes, { prefix: "/internal" });
  return app;
}
