import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, gitInstallations } from "@skyhost/db";
import { audit, badRequest, notFound, providerClient, type GitProviderClient } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { serviceAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB per file, like GitHub's contents API.

interface GitSource {
  client: GitProviderClient;
  repo: string;
  branch: string;
}

/** Resolves a service's git source into a provider client, or explains why the editor is unavailable. */
async function gitSourceOf(req: FastifyRequest, serviceId: string, permission: "service:read" | "service:update"): Promise<{ teamId: string; src: GitSource; serviceId: string }> {
  const a = await serviceAccess(req, serviceId, permission);
  const source = a.service.source as { kind?: string; repo?: string; branch?: string; installationId?: string };
  if (!["github", "gitlab", "bitbucket"].includes(source.kind ?? "") || !source.repo || !source.installationId) {
    throw badRequest("This service is not connected to a Git repository, so the code editor is not available for it.");
  }
  const [inst] = await getDb().select().from(gitInstallations).where(eq(gitInstallations.id, source.installationId));
  if (!inst) throw badRequest("The Git connection for this service is no longer available. Reconnect the repository.");
  const client = providerClient(inst);
  const branch = source.branch || (await client.getRepo(source.repo)).defaultBranch;
  return { teamId: a.team.id, serviceId: a.service.id, src: { client, repo: source.repo, branch } };
}

function cleanPath(p: string): string {
  if (p.startsWith("/") || p.includes("..") || p.includes("\0") || /(^|\/)\.git(\/|$)/.test(p)) throw badRequest("Invalid file path");
  return p;
}

export default async function codeRoutes(app: FastifyInstance) {
  /** The repository file tree plus the branch the service deploys from. */
  route(app, { method: "GET", url: "/services/:id/code/tree", tags: ["code"], params: idParam, query: z.object({ ref: z.string().max(200).optional() }) }, async (req, _r, { params, query }) => {
    const { src } = await gitSourceOf(req, params.id, "service:read");
    const ref = query.ref || src.branch;
    const tree = await src.client.listTree(src.repo, ref);
    return { repo: src.repo, branch: src.branch, ref, tree };
  });

  /** One file's contents. */
  route(app, { method: "GET", url: "/services/:id/code/file", tags: ["code"], params: idParam, query: z.object({ path: z.string().min(1).max(1024), ref: z.string().max(200).optional() }) }, async (req, _r, { params, query }) => {
    const { src } = await gitSourceOf(req, params.id, "service:read");
    const path = cleanPath(query.path);
    const content = await src.client.readFile(src.repo, query.ref || src.branch, path);
    if (content === null) throw notFound("File");
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw badRequest("This file is too large to edit here.");
    return { path, content };
  });

  /** Commits edited files straight to the deploy branch; the push redeploys the service automatically. */
  route(
    app,
    {
      method: "POST",
      url: "/services/:id/code/commit",
      tags: ["code"],
      params: idParam,
      body: z.object({
        message: z.string().trim().min(1).max(500),
        changes: z.array(z.object({ path: z.string().min(1).max(1024), content: z.string().max(MAX_FILE_BYTES) })).min(1).max(50),
      }),
      rateLimit: { max: 60, timeWindow: "1 hour" },
    },
    async (req, _r, { params, body }) => {
      const { teamId, src, serviceId } = await gitSourceOf(req, params.id, "service:update");
      const changes = body.changes.map((c) => ({ path: cleanPath(c.path), content: c.content }));
      const { sha } = await src.client.commitToBranch(src.repo, src.branch, changes, body.message);
      await audit(actorOf(req), teamId, "code.commit", { type: "service", id: serviceId }, { branch: src.branch, sha, files: changes.map((c) => c.path) });
      // The push to the deploy branch triggers the repository's push webhook, which redeploys the service.
      return { sha, branch: src.branch, repo: src.repo, files: changes.length };
    },
  );
}
