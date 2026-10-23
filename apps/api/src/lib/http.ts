import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { badRequest } from "@skyhost/core";

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw badRequest(issues[0] ? `${issues[0].path ? `${issues[0].path}: ` : ""}${issues[0].message}` : "Invalid request", issues);
  }
  return r.data;
}

interface RouteDef<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny> {
  method: HTTPMethods;
  url: string;
  summary?: string;
  tags?: string[];
  body?: B;
  query?: Q;
  params?: P;
  /** Public routes skip the authentication requirement. */
  public?: boolean;
  rateLimit?: { max: number; timeWindow: string };
  rawBody?: boolean;
}

type Handler<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny> = (
  req: FastifyRequest,
  reply: FastifyReply,
  input: { body: z.infer<B>; query: z.infer<Q>; params: z.infer<P> },
) => Promise<unknown> | unknown;

const toJson = (s: ZodTypeAny) => {
  const j = zodToJsonSchema(s, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  delete j.$schema;
  return j;
};

/**
 * Registers a route with zod validation and OpenAPI documentation. Authentication is required unless
 * `public: true`; authorization is checked inside handlers through the access helpers.
 */
export function route<B extends ZodTypeAny = z.ZodAny, Q extends ZodTypeAny = z.ZodAny, P extends ZodTypeAny = z.ZodAny>(
  app: FastifyInstance,
  def: RouteDef<B, Q, P>,
  handler: Handler<B, Q, P>,
) {
  app.route({
    method: def.method,
    url: def.url,
    schema: {
      summary: def.summary,
      tags: def.tags,
      ...(def.body ? { body: toJson(def.body) } : {}),
      ...(def.query ? { querystring: toJson(def.query) } : {}),
      ...(def.params ? { params: toJson(def.params) } : {}),
      ...(def.public ? {} : { security: [{ cookie: [] }, { bearer: [] }] }),
    },
    config: { public: !!def.public, ...(def.rateLimit ? { rateLimit: def.rateLimit } : {}) },
    handler: async (req, reply) => {
      if (!def.public && !req.auth.user) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "Authentication required" } });
      }
      const input = {
        body: def.body ? parse(def.body, req.body) : (req.body as z.infer<B>),
        query: def.query ? parse(def.query, req.query) : (req.query as z.infer<Q>),
        params: def.params ? parse(def.params, req.params) : (req.params as z.infer<P>),
      };
      const out = await handler(req, reply, input);
      if (reply.sent) return;
      return out ?? { ok: true };
    },
  });
}

export const idParam = z.object({ id: z.string().uuid() });
export const uuid = z.string().uuid();
