import { eq } from "drizzle-orm";
import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";
import { getDb, gitInstallations } from "@skyhost/db";
import { decrypt, encrypt, hmacSha256, safeEqual } from "@skyhost/shared/node";
import { serverConfig } from "../config";
import { badRequest, unavailable } from "../errors";

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
  updatedAt?: string;
}

export interface CloneAuth {
  url: string;
  token: string | null;
  username: string;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface GitProviderClient {
  provider: "github" | "gitlab" | "bitbucket";
  listRepos(query?: string): Promise<RepoInfo[]>;
  listBranches(repo: string): Promise<string[]>;
  getRepo(repo: string): Promise<RepoInfo>;
  cloneAuth(repo: string): Promise<CloneAuth>;
  commentOnPullRequest(repo: string, number: number, body: string): Promise<void>;
  /** "success" when every check/status passed, "pending" while running, "failure" otherwise. */
  commitStatus(repo: string, sha: string): Promise<"success" | "pending" | "failure" | "none">;
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  createFixPullRequest(repo: string, base: string, branch: string, changes: FileChange[], title: string, body: string): Promise<{ url: string; number: number }>;
  /** Registers the SKYHOST push/PR webhook on the repository (GitHub Apps receive events without it). */
  ensureWebhook(repo: string, url: string): Promise<void>;
}

type Installation = typeof gitInstallations.$inferSelect;

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404) throw badRequest(`${what}: not found or not accessible`);
    throw new Error(`${what} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

const repoPath = (repo: string) => {
  if (!/^[\w.-]+\/[\w./-]+$/.test(repo) || repo.includes("..")) throw badRequest("Invalid repository name");
  return repo;
};

// ------------------------------------------------------------------------------------------------- GitHub App

const ghTokens = new Map<string, { token: string; expiresAt: number }>();

export async function githubAppJwt(): Promise<string> {
  const c = serverConfig();
  if (!c.GITHUB_APP_ID || !c.GITHUB_APP_PRIVATE_KEY) throw unavailable("GitHub repositories are not available yet on this SKYHOST installation.");
  const pem = c.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  // GitHub issues PKCS#1 keys; convert to PKCS#8 for jose.
  const pkcs8 = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  const key = await importPKCS8(pkcs8, "RS256");
  const now = Math.floor(Date.now() / 1000);
  // GitHub wants the App ID as a number in "iss" (a string is only accepted for the app's Client ID, "Iv…").
  const appId = c.GITHUB_APP_ID.trim().replace(/^["']|["']$/g, "");
  return new SignJWT({ iss: /^\d+$/.test(appId) ? Number(appId) : appId } as Record<string, unknown>)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(key);
}

export async function githubInstallationToken(installationId: string): Promise<string> {
  const cached = ghTokens.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 120_000) return cached.token;
  const res = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await githubAppJwt()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  const j = await json<{ token: string; expires_at: string }>(res, "GitHub installation token");
  ghTokens.set(installationId, { token: j.token, expiresAt: new Date(j.expires_at).getTime() });
  return j.token;
}

export async function githubInstallationInfo(installationId: string) {
  const res = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}`, {
    headers: { Authorization: `Bearer ${await githubAppJwt()}`, Accept: "application/vnd.github+json" },
  });
  return json<{ id: number; account: { login: string; type: string } }>(res, "GitHub installation");
}

class GitHubClient implements GitProviderClient {
  provider = "github" as const;
  constructor(private readonly installationId: string) {}
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await githubInstallationToken(this.installationId);
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    return json<T>(res, `GitHub ${path.split("?")[0]}`);
  }
  async listRepos(query?: string) {
    const out: RepoInfo[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.api<{ repositories: Array<{ full_name: string; default_branch: string; private: boolean; clone_url: string; pushed_at: string }> }>(`/installation/repositories?per_page=100&page=${page}`);
      out.push(...r.repositories.map((x) => ({ fullName: x.full_name, defaultBranch: x.default_branch, private: x.private, url: x.clone_url, updatedAt: x.pushed_at })));
      if (r.repositories.length < 100) break;
    }
    const q = query?.toLowerCase();
    return (q ? out.filter((r) => r.fullName.toLowerCase().includes(q)) : out).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  async getRepo(repo: string) {
    const x = await this.api<{ full_name: string; default_branch: string; private: boolean; clone_url: string }>(`/repos/${repoPath(repo)}`);
    return { fullName: x.full_name, defaultBranch: x.default_branch, private: x.private, url: x.clone_url };
  }
  async listBranches(repo: string) {
    const r = await this.api<Array<{ name: string }>>(`/repos/${repoPath(repo)}/branches?per_page=100`);
    return r.map((b) => b.name);
  }
  async cloneAuth(repo: string) {
    return { url: `https://github.com/${repoPath(repo)}.git`, token: await githubInstallationToken(this.installationId), username: "x-access-token" };
  }
  async commentOnPullRequest(repo: string, number: number, body: string) {
    await this.api(`/repos/${repoPath(repo)}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }
  async commitStatus(repo: string, sha: string) {
    const [status, checks] = await Promise.all([
      this.api<{ state: string; total_count: number }>(`/repos/${repoPath(repo)}/commits/${sha}/status`),
      this.api<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null; name: string }> }>(`/repos/${repoPath(repo)}/commits/${sha}/check-runs?per_page=100`),
    ]);
    const runs = checks.check_runs.filter((c) => !/skyhost/i.test(c.name));
    if (!runs.length && status.total_count === 0) return "none";
    if (runs.some((c) => c.status !== "completed") || status.state === "pending") return "pending";
    if (runs.some((c) => !["success", "neutral", "skipped"].includes(c.conclusion ?? "")) || status.state === "failure" || status.state === "error") return "failure";
    return "success";
  }
  async readFile(repo: string, ref: string, path: string) {
    try {
      const r = await this.api<{ content: string; encoding: string }>(`/repos/${repoPath(repo)}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`);
      return Buffer.from(r.content, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  async createFixPullRequest(repo: string, base: string, branch: string, changes: FileChange[], title: string, body: string) {
    const r = repoPath(repo);
    const baseRef = await this.api<{ object: { sha: string } }>(`/repos/${r}/git/ref/heads/${encodeURIComponent(base)}`);
    await this.api(`/repos/${r}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }) });
    for (const ch of changes) {
      let sha: string | undefined;
      try {
        sha = (await this.api<{ sha: string }>(`/repos/${r}/contents/${ch.path}?ref=${encodeURIComponent(branch)}`)).sha;
      } catch {
        sha = undefined;
      }
      await this.api(`/repos/${r}/contents/${ch.path}`, { method: "PUT", body: JSON.stringify({ message: `SKYHOST Auto Fix: update ${ch.path}`, content: Buffer.from(ch.content).toString("base64"), branch, sha }) });
    }
    const pr = await this.api<{ html_url: string; number: number }>(`/repos/${r}/pulls`, { method: "POST", body: JSON.stringify({ title, body, head: branch, base }) });
    return { url: pr.html_url, number: pr.number };
  }
  async ensureWebhook() {
    // GitHub App webhooks are configured on the App itself.
  }
}

// ------------------------------------------------------------------------------------------------- GitLab

async function oauthToken(inst: Installation): Promise<string> {
  if (!inst.accessTokenEnc) throw badRequest("This Git connection has no access token; reconnect it");
  if (inst.tokenExpiresAt && inst.tokenExpiresAt.getTime() < Date.now() + 60_000 && inst.refreshTokenEnc) {
    const c = serverConfig();
    const refresh = decrypt(inst.refreshTokenEnc);
    const isGitlab = inst.provider === "gitlab";
    const res = await fetch(isGitlab ? `${c.GITLAB_URL}/oauth/token` : "https://bitbucket.org/site/oauth2/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(isGitlab ? {} : { Authorization: `Basic ${Buffer.from(`${c.BITBUCKET_CLIENT_ID}:${c.BITBUCKET_CLIENT_SECRET}`).toString("base64")}` }),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, ...(isGitlab ? { client_id: c.GITLAB_CLIENT_ID, client_secret: c.GITLAB_CLIENT_SECRET } : {}) }),
    });
    const j = await json<{ access_token: string; refresh_token?: string; expires_in?: number }>(res, "OAuth token refresh");
    await getDb()
      .update(gitInstallations)
      .set({ accessTokenEnc: encrypt(j.access_token), refreshTokenEnc: j.refresh_token ? encrypt(j.refresh_token) : inst.refreshTokenEnc, tokenExpiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null })
      .where(eq(gitInstallations.id, inst.id));
    return j.access_token;
  }
  return decrypt(inst.accessTokenEnc);
}

class GitLabClient implements GitProviderClient {
  provider = "gitlab" as const;
  constructor(private readonly inst: Installation) {}
  private base = () => `${serverConfig().GITLAB_URL}/api/v4`;
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, { ...init, headers: { Authorization: `Bearer ${await oauthToken(this.inst)}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return json<T>(res, `GitLab ${path.split("?")[0]}`);
  }
  private id = (repo: string) => encodeURIComponent(repoPath(repo));
  async listRepos(query?: string) {
    const r = await this.api<Array<{ path_with_namespace: string; default_branch: string; visibility: string; http_url_to_repo: string; last_activity_at: string }>>(
      `/projects?membership=true&per_page=100&order_by=last_activity_at${query ? `&search=${encodeURIComponent(query)}` : ""}`,
    );
    return r.map((p) => ({ fullName: p.path_with_namespace, defaultBranch: p.default_branch, private: p.visibility !== "public", url: p.http_url_to_repo, updatedAt: p.last_activity_at }));
  }
  async getRepo(repo: string) {
    const p = await this.api<{ path_with_namespace: string; default_branch: string; visibility: string; http_url_to_repo: string }>(`/projects/${this.id(repo)}`);
    return { fullName: p.path_with_namespace, defaultBranch: p.default_branch, private: p.visibility !== "public", url: p.http_url_to_repo };
  }
  async listBranches(repo: string) {
    return (await this.api<Array<{ name: string }>>(`/projects/${this.id(repo)}/repository/branches?per_page=100`)).map((b) => b.name);
  }
  async cloneAuth(repo: string) {
    return { url: `${serverConfig().GITLAB_URL}/${repoPath(repo)}.git`, token: await oauthToken(this.inst), username: "oauth2" };
  }
  async commentOnPullRequest(repo: string, number: number, body: string) {
    await this.api(`/projects/${this.id(repo)}/merge_requests/${number}/notes`, { method: "POST", body: JSON.stringify({ body }) });
  }
  async commitStatus(repo: string, sha: string) {
    const s = await this.api<Array<{ status: string; name: string }>>(`/projects/${this.id(repo)}/repository/commits/${sha}/statuses`);
    const rel = s.filter((x) => !/skyhost/i.test(x.name));
    if (!rel.length) return "none";
    if (rel.some((x) => ["pending", "running", "created"].includes(x.status))) return "pending";
    return rel.every((x) => x.status === "success" || x.status === "skipped") ? "success" : "failure";
  }
  async readFile(repo: string, ref: string, path: string) {
    try {
      const res = await fetch(`${this.base()}/projects/${this.id(repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${await oauthToken(this.inst)}` } });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }
  async createFixPullRequest(repo: string, base: string, branch: string, changes: FileChange[], title: string, body: string) {
    await this.api(`/projects/${this.id(repo)}/repository/commits`, {
      method: "POST",
      body: JSON.stringify({ branch, start_branch: base, commit_message: title, actions: changes.map((c) => ({ action: "update", file_path: c.path, content: c.content })) }),
    });
    const mr = await this.api<{ web_url: string; iid: number }>(`/projects/${this.id(repo)}/merge_requests`, { method: "POST", body: JSON.stringify({ source_branch: branch, target_branch: base, title, description: body }) });
    return { url: mr.web_url, number: mr.iid };
  }
  async ensureWebhook(repo: string, url: string) {
    const hooks = await this.api<Array<{ id: number; url: string }>>(`/projects/${this.id(repo)}/hooks`);
    if (hooks.some((h) => h.url === url)) return;
    await this.api(`/projects/${this.id(repo)}/hooks`, {
      method: "POST",
      body: JSON.stringify({ url, push_events: true, merge_requests_events: true, token: serverConfig().GITLAB_WEBHOOK_SECRET, enable_ssl_verification: true }),
    });
  }
}

// ------------------------------------------------------------------------------------------------- Bitbucket

class BitbucketClient implements GitProviderClient {
  provider = "bitbucket" as const;
  constructor(private readonly inst: Installation) {}
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`https://api.bitbucket.org/2.0${path}`, { ...init, headers: { Authorization: `Bearer ${await oauthToken(this.inst)}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return json<T>(res, `Bitbucket ${path.split("?")[0]}`);
  }
  async listRepos(query?: string) {
    const q = query ? `&q=${encodeURIComponent(`name ~ "${query.replace(/"/g, "")}"`)}` : "";
    const r = await this.api<{ values: Array<{ full_name: string; mainbranch?: { name: string }; is_private: boolean; updated_on: string }> }>(`/repositories?role=member&pagelen=100&sort=-updated_on${q}`);
    return r.values.map((v) => ({ fullName: v.full_name, defaultBranch: v.mainbranch?.name ?? "main", private: v.is_private, url: `https://bitbucket.org/${v.full_name}.git`, updatedAt: v.updated_on }));
  }
  async getRepo(repo: string) {
    const v = await this.api<{ full_name: string; mainbranch?: { name: string }; is_private: boolean }>(`/repositories/${repoPath(repo)}`);
    return { fullName: v.full_name, defaultBranch: v.mainbranch?.name ?? "main", private: v.is_private, url: `https://bitbucket.org/${v.full_name}.git` };
  }
  async listBranches(repo: string) {
    return (await this.api<{ values: Array<{ name: string }> }>(`/repositories/${repoPath(repo)}/refs/branches?pagelen=100`)).values.map((b) => b.name);
  }
  async cloneAuth(repo: string) {
    return { url: `https://bitbucket.org/${repoPath(repo)}.git`, token: await oauthToken(this.inst), username: "x-token-auth" };
  }
  async commentOnPullRequest(repo: string, number: number, body: string) {
    await this.api(`/repositories/${repoPath(repo)}/pullrequests/${number}/comments`, { method: "POST", body: JSON.stringify({ content: { raw: body } }) });
  }
  async commitStatus(repo: string, sha: string) {
    const s = await this.api<{ values: Array<{ state: string; key: string }> }>(`/repositories/${repoPath(repo)}/commit/${sha}/statuses`);
    const rel = s.values.filter((x) => !/skyhost/i.test(x.key));
    if (!rel.length) return "none";
    if (rel.some((x) => x.state === "INPROGRESS")) return "pending";
    return rel.every((x) => x.state === "SUCCESSFUL") ? "success" : "failure";
  }
  async readFile(repo: string, ref: string, path: string) {
    try {
      const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoPath(repo)}/src/${encodeURIComponent(ref)}/${path}`, { headers: { Authorization: `Bearer ${await oauthToken(this.inst)}` } });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }
  async createFixPullRequest(repo: string, base: string, branch: string, changes: FileChange[], title: string, body: string) {
    const form = new FormData();
    form.set("branch", branch);
    form.set("parents", base);
    form.set("message", title);
    for (const c of changes) form.set(c.path, c.content);
    const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoPath(repo)}/src`, { method: "POST", headers: { Authorization: `Bearer ${await oauthToken(this.inst)}` }, body: form });
    if (!res.ok) throw new Error(`Bitbucket commit failed (${res.status})`);
    const pr = await this.api<{ id: number; links: { html: { href: string } } }>(`/repositories/${repoPath(repo)}/pullrequests`, {
      method: "POST",
      body: JSON.stringify({ title, description: body, source: { branch: { name: branch } }, destination: { branch: { name: base } } }),
    });
    return { url: pr.links.html.href, number: pr.id };
  }
  async ensureWebhook(repo: string, url: string) {
    const hooks = await this.api<{ values: Array<{ url: string }> }>(`/repositories/${repoPath(repo)}/hooks`);
    if (hooks.values.some((h) => h.url === url)) return;
    await this.api(`/repositories/${repoPath(repo)}/hooks`, {
      method: "POST",
      body: JSON.stringify({ description: "SKYHOST", url, active: true, secret: serverConfig().BITBUCKET_WEBHOOK_SECRET, events: ["repo:push", "pullrequest:created", "pullrequest:updated", "pullrequest:fulfilled", "pullrequest:rejected"] }),
    });
  }
}

export function providerClient(inst: Installation): GitProviderClient {
  switch (inst.provider) {
    case "github":
      return new GitHubClient(inst.externalId);
    case "gitlab":
      return new GitLabClient(inst);
    case "bitbucket":
      return new BitbucketClient(inst);
    default:
      throw badRequest(`Unsupported provider ${inst.provider}`);
  }
}

// ------------------------------------------------------------------------------------------------- Webhook signatures

/** GitHub: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body) */
export function verifyGithubSignature(rawBody: Buffer, header: string | undefined, secret = serverConfig().GITHUB_WEBHOOK_SECRET): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  return safeEqual(header, `sha256=${hmacSha256(secret, rawBody)}`);
}

/** GitLab sends the configured secret token as-is in X-Gitlab-Token. */
export function verifyGitlabToken(header: string | undefined, secret = serverConfig().GITLAB_WEBHOOK_SECRET): boolean {
  return !!secret && !!header && safeEqual(header, secret);
}

/** Bitbucket Cloud webhooks with a secret send X-Hub-Signature: sha256=<hmac>. */
export function verifyBitbucketSignature(rawBody: Buffer, header: string | undefined, secret = serverConfig().BITBUCKET_WEBHOOK_SECRET): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  return safeEqual(header, `sha256=${hmacSha256(secret, rawBody)}`);
}
