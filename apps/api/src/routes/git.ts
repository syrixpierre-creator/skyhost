import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, gitInstallations } from "@skyhost/db";
import { encrypt, hmacSha256, randomToken, safeEqual } from "@skyhost/shared/node";
import { listRemoteBranches } from "@skyhost/engine";
import { audit, badRequest, githubInstallationInfo, notFound, providerClient, redis, serverConfig, unavailable } from "@skyhost/core";
import { actorOf } from "../lib/auth";
import { teamAccess } from "../lib/authz";
import { idParam, route } from "../lib/http";

/** State parameter binding an install/connect flow to a team and user (HMAC signed, short lived). */
function signState(payload: Record<string, string>) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 15 * 60_000, n: randomToken(8) })).toString("base64url");
  return `${body}.${hmacSha256(serverConfig().SKYHOST_SESSION_SECRET, body, "base64").replace(/=+$/, "")}`;
}

function verifyState(state: string | undefined): Record<string, string> | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig || !safeEqual(sig, hmacSha256(serverConfig().SKYHOST_SESSION_SECRET, body, "base64").replace(/=+$/, ""))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, string> & { exp: number };
  return p.exp > Date.now() ? p : null;
}

function installationView(i: typeof gitInstallations.$inferSelect) {
  return { id: i.id, provider: i.provider, accountLogin: i.accountLogin, accountType: i.accountType, suspended: !!i.suspendedAt, createdAt: i.createdAt };
}

const OAUTH_GIT = {
  gitlab: {
    configured: () => !!serverConfig().GITLAB_CLIENT_ID,
    authorize: (state: string, redirect: string) => `${serverConfig().GITLAB_URL}/oauth/authorize?${new URLSearchParams({ client_id: serverConfig().GITLAB_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: "api read_repository", state })}`,
    async exchange(code: string, redirect: string) {
      const c = serverConfig();
      const res = await fetch(`${c.GITLAB_URL}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: c.GITLAB_CLIENT_ID, client_secret: c.GITLAB_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: redirect }) });
      const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!t.access_token) throw badRequest("GitLab authorization failed");
      const me = (await (await fetch(`${c.GITLAB_URL}/api/v4/user`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json()) as { id: number; username: string };
      return { externalId: String(me.id), login: me.username, ...t };
    },
  },
  bitbucket: {
    configured: () => !!serverConfig().BITBUCKET_CLIENT_ID,
    authorize: (state: string) => `https://bitbucket.org/site/oauth2/authorize?${new URLSearchParams({ client_id: serverConfig().BITBUCKET_CLIENT_ID, response_type: "code", state })}`,
    async exchange(code: string) {
      const c = serverConfig();
      const res = await fetch("https://bitbucket.org/site/oauth2/access_token", {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${c.BITBUCKET_CLIENT_ID}:${c.BITBUCKET_CLIENT_SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code }),
      });
      const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!t.access_token) throw badRequest("Bitbucket authorization failed");
      const me = (await (await fetch("https://api.bitbucket.org/2.0/user", { headers: { Authorization: `Bearer ${t.access_token}` } })).json()) as { uuid: string; username: string };
      return { externalId: me.uuid, login: me.username, ...t };
    },
  },
} as const;

export default async function gitRoutes(app: FastifyInstance) {
  route(app, { method: "GET", url: "/git/providers", public: true, tags: ["git"] }, async () => {
    const c = serverConfig();
    return { github: !!(c.GITHUB_APP_ID && c.GITHUB_APP_SLUG), gitlab: OAUTH_GIT.gitlab.configured(), bitbucket: OAUTH_GIT.bitbucket.configured() };
  });

  route(app, { method: "GET", url: "/teams/:teamId/git/installations", tags: ["git"], params: z.object({ teamId: z.string().uuid() }) }, async (req, _r, { params }) => {
    await teamAccess(req, params.teamId, "project:read");
    const rows = await getDb().select().from(gitInstallations).where(eq(gitInstallations.teamId, params.teamId));
    return { installations: rows.map(installationView) };
  });

  // GitHub App installation flow
  route(app, { method: "GET", url: "/git/github/install", tags: ["git"], query: z.object({ teamId: z.string().uuid() }) }, async (req, reply, { query }) => {
    await teamAccess(req, query.teamId, "project:create");
    const slug = serverConfig().GITHUB_APP_SLUG;
    if (!slug) throw unavailable("The GitHub App is not configured on this SKYHOST installation");
    const state = signState({ teamId: query.teamId, userId: req.auth.user!.id });
    return reply.redirect(`https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`);
  });

  app.get("/git/github/callback", { config: { public: true } }, async (req, reply) => {
    const dash = serverConfig().SKYHOST_DASHBOARD_URL;
    const q = req.query as { installation_id?: string; state?: string; setup_action?: string };
    const state = verifyState(q.state);
    if (!state || !q.installation_id || !/^\d+$/.test(q.installation_id)) return reply.redirect(`${dash}/new?error=${encodeURIComponent("GitHub installation could not be verified")}`);
    // Only the user who started the flow can bind the installation, and GitHub must confirm the installation exists.
    if (!req.auth.user || req.auth.user.id !== state.userId) return reply.redirect(`${dash}/login?next=/new`);
    try {
      const info = await githubInstallationInfo(q.installation_id);
      const [row] = await getDb()
        .insert(gitInstallations)
        .values({ teamId: state.teamId!, provider: "github", externalId: q.installation_id, accountLogin: info.account.login, accountType: info.account.type, connectedByUserId: state.userId })
        .onConflictDoUpdate({ target: [gitInstallations.teamId, gitInstallations.provider, gitInstallations.externalId], set: { accountLogin: info.account.login, suspendedAt: null } })
        .returning();
      await audit({ userId: state.userId, ip: req.ip }, state.teamId!, "git.connected", { type: "git_installation", id: row!.id }, { provider: "github", account: info.account.login });
      return reply.redirect(`${dash}/new?installation=${row!.id}`);
    } catch (e) {
      return reply.redirect(`${dash}/new?error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  // GitLab / Bitbucket OAuth connections
  route(app, { method: "GET", url: "/git/:provider/connect", tags: ["git"], params: z.object({ provider: z.enum(["gitlab", "bitbucket"]) }), query: z.object({ teamId: z.string().uuid() }) }, async (req, reply, { params, query }) => {
    await teamAccess(req, query.teamId, "project:create");
    const p = OAUTH_GIT[params.provider];
    if (!p.configured()) throw unavailable(`${params.provider} is not configured on this SKYHOST installation`);
    const state = signState({ teamId: query.teamId, userId: req.auth.user!.id, provider: params.provider });
    await redis().set(`sh:gitstate:${state.slice(-20)}`, "1", "EX", 900);
    const redirect = `${serverConfig().SKYHOST_API_URL}/api/v1/git/${params.provider}/callback`;
    return reply.redirect(p.authorize(state, redirect));
  });

  app.get("/git/:provider/callback", { config: { public: true } }, async (req, reply) => {
    const dash = serverConfig().SKYHOST_DASHBOARD_URL;
    const provider = (req.params as { provider: string }).provider as keyof typeof OAUTH_GIT;
    const q = req.query as { code?: string; state?: string };
    const state = verifyState(q.state);
    if (!(provider in OAUTH_GIT) || !state || state.provider !== provider || !q.code) return reply.redirect(`${dash}/new?error=invalid_state`);
    if (!(await redis().getdel(`sh:gitstate:${q.state!.slice(-20)}`))) return reply.redirect(`${dash}/new?error=state_reused`);
    if (!req.auth.user || req.auth.user.id !== state.userId) return reply.redirect(`${dash}/login?next=/new`);
    try {
      const t = await OAUTH_GIT[provider].exchange(q.code, `${serverConfig().SKYHOST_API_URL}/api/v1/git/${provider}/callback`);
      const [row] = await getDb()
        .insert(gitInstallations)
        .values({
          teamId: state.teamId!,
          provider,
          externalId: t.externalId,
          accountLogin: t.login,
          accountType: "User",
          connectedByUserId: state.userId,
          accessTokenEnc: encrypt(t.access_token!),
          refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token) : null,
          tokenExpiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
        })
        .onConflictDoUpdate({
          target: [gitInstallations.teamId, gitInstallations.provider, gitInstallations.externalId],
          set: { accessTokenEnc: encrypt(t.access_token!), refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token) : null, tokenExpiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null },
        })
        .returning();
      await audit({ userId: state.userId, ip: req.ip }, state.teamId!, "git.connected", { type: "git_installation", id: row!.id }, { provider, account: t.login });
      return reply.redirect(`${dash}/new?installation=${row!.id}`);
    } catch (e) {
      return reply.redirect(`${dash}/new?error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  async function installation(req: Parameters<typeof teamAccess>[0], id: string) {
    const [inst] = await getDb().select().from(gitInstallations).where(eq(gitInstallations.id, id));
    if (!inst) throw notFound("Git connection");
    await teamAccess(req, inst.teamId, "project:read");
    return inst;
  }

  route(app, { method: "GET", url: "/git/installations/:id/repos", tags: ["git"], params: idParam, query: z.object({ q: z.string().max(100).optional() }) }, async (req, _r, { params, query }) => {
    const inst = await installation(req, params.id);
    const cacheKey = `sh:repos:${inst.id}`;
    let repos = query.q ? null : await redis().get(cacheKey);
    if (!repos) {
      const list = await providerClient(inst).listRepos(query.q);
      repos = JSON.stringify(list);
      if (!query.q) await redis().set(cacheKey, repos, "EX", 60);
    }
    return { repositories: JSON.parse(repos) };
  });

  route(app, { method: "GET", url: "/git/installations/:id/branches", tags: ["git"], params: idParam, query: z.object({ repo: z.string().max(200) }) }, async (req, _r, { params, query }) => {
    const inst = await installation(req, params.id);
    const client = providerClient(inst);
    const [repo, branches] = await Promise.all([client.getRepo(query.repo), client.listBranches(query.repo)]);
    return { defaultBranch: repo.defaultBranch, branches };
  });

  route(app, { method: "DELETE", url: "/git/installations/:id", tags: ["git"], params: idParam }, async (req, _r, { params }) => {
    const [inst] = await getDb().select().from(gitInstallations).where(eq(gitInstallations.id, params.id));
    if (!inst) throw notFound("Git connection");
    await teamAccess(req, inst.teamId, "team:update");
    await getDb().delete(gitInstallations).where(and(eq(gitInstallations.id, params.id)));
    await audit(actorOf(req), inst.teamId, "git.disconnected", { type: "git_installation", id: params.id }, { provider: inst.provider });
    return { ok: true };
  });

  route(app, { method: "POST", url: "/git/public/branches", tags: ["git"], body: z.object({ url: z.string().url().max(2048) }), rateLimit: { max: 20, timeWindow: "1 minute" } }, async (_req, _r, { body }) => {
    try {
      return await listRemoteBranches(body.url);
    } catch (e) {
      throw badRequest(`Could not read the repository: ${(e as Error).message}`);
    }
  });
}
