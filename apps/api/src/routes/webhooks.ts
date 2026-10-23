import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, gitInstallations, webhookReceipts } from "@skyhost/db";
import {
  handleFlutterwaveTransaction, handlePaypalEvent, handleStripeEvent, verifyBitbucketSignature, verifyFlutterwaveHash, verifyFlutterwaveTransaction, verifyGithubSignature, verifyGitlabToken, verifyPaypalWebhook, verifyStripeWebhook,
} from "@skyhost/core";
import { handlePullRequest, handlePush } from "../lib/git-events";

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Records a delivery id; returns false when it was already received (replay / provider retry). */
async function firstDelivery(source: string, deliveryId: string | undefined, event: string): Promise<boolean> {
  if (!deliveryId || deliveryId.length > 200) return false;
  const res = await getDb().insert(webhookReceipts).values({ source, deliveryId, event }).onConflictDoNothing().returning({ id: webhookReceipts.id });
  return res.length > 0;
}

async function processed(source: string, deliveryId: string, error?: string) {
  await getDb().update(webhookReceipts).set({ processedAt: new Date(), error: error ?? null }).where(and(eq(webhookReceipts.source, source), eq(webhookReceipts.deliveryId, deliveryId)));
}

const raw = (req: FastifyRequest) => req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export default async function webhookRoutes(app: FastifyInstance) {
  const opts = { config: { public: true, rateLimit: { max: 600, timeWindow: "1 minute" } }, bodyLimit: 10 * 1024 * 1024 };

  app.post("/webhooks/github", opts, async (req, reply) => {
    if (!verifyGithubSignature(raw(req), header(req, "x-hub-signature-256"))) return reply.code(401).send({ error: { code: "invalid_signature", message: "Invalid signature" } });
    const delivery = header(req, "x-github-delivery");
    const event = header(req, "x-github-event") ?? "unknown";
    if (!(await firstDelivery("github", delivery, event))) return reply.code(200).send({ ok: true, duplicate: true });
    const body = req.body as Any;
    try {
      const installationId = body.installation?.id ? String(body.installation.id) : undefined;
      if (event === "push" && body.ref?.startsWith("refs/heads/") && !body.deleted) {
        const files = (body.commits ?? []).flatMap((c: Any) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
        await handlePush("github", { repo: body.repository.full_name, branch: body.ref.slice(11), sha: body.after, message: body.head_commit?.message, author: body.head_commit?.author?.name, installationId, changedFiles: files });
      } else if (event === "pull_request") {
        const pr = body.pull_request;
        const action = body.action === "closed" ? "close" : body.action === "opened" || body.action === "reopened" ? "open" : body.action === "synchronize" ? "update" : null;
        if (action && pr.head.repo?.full_name === body.repository.full_name) {
          // Previews only for branches of the same repository (forks could run untrusted code with project secrets).
          await handlePullRequest("github", { repo: body.repository.full_name, number: pr.number, branch: pr.head.ref, sha: pr.head.sha, action, title: pr.title, author: pr.user?.login, installationId });
        }
      } else if (event === "installation" && installationId) {
        const db = getDb();
        if (body.action === "deleted") await db.delete(gitInstallations).where(and(eq(gitInstallations.provider, "github"), eq(gitInstallations.externalId, installationId)));
        if (body.action === "suspend") await db.update(gitInstallations).set({ suspendedAt: new Date() }).where(and(eq(gitInstallations.provider, "github"), eq(gitInstallations.externalId, installationId)));
        if (body.action === "unsuspend") await db.update(gitInstallations).set({ suspendedAt: null }).where(and(eq(gitInstallations.provider, "github"), eq(gitInstallations.externalId, installationId)));
      }
      await processed("github", delivery!);
      return { ok: true };
    } catch (e) {
      await processed("github", delivery!, (e as Error).message);
      throw e;
    }
  });

  app.post("/webhooks/gitlab", opts, async (req, reply) => {
    if (!verifyGitlabToken(header(req, "x-gitlab-token"))) return reply.code(401).send({ error: { code: "invalid_signature", message: "Invalid token" } });
    const delivery = header(req, "x-gitlab-event-uuid") ?? header(req, "x-gitlab-webhook-uuid");
    const event = header(req, "x-gitlab-event") ?? "unknown";
    if (!(await firstDelivery("gitlab", delivery, event))) return { ok: true, duplicate: true };
    const b = req.body as Any;
    const repo = b.project?.path_with_namespace as string;
    if (event === "Push Hook" && b.ref?.startsWith("refs/heads/") && b.after !== "0000000000000000000000000000000000000000") {
      const files = (b.commits ?? []).flatMap((c: Any) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]);
      const last = (b.commits ?? []).at(-1);
      await handlePush("gitlab", { repo, branch: b.ref.slice(11), sha: b.after, message: last?.message, author: last?.author?.name, changedFiles: files });
    } else if (event === "Merge Request Hook") {
      const mr = b.object_attributes;
      const action = ["close", "merge"].includes(mr.action) ? "close" : mr.action === "open" || mr.action === "reopen" ? "open" : mr.action === "update" ? "update" : null;
      if (action && mr.source_project_id === mr.target_project_id) await handlePullRequest("gitlab", { repo, number: mr.iid, branch: mr.source_branch, sha: mr.last_commit?.id, action, title: mr.title, author: b.user?.username });
    }
    await processed("gitlab", delivery!);
    return { ok: true };
  });

  app.post("/webhooks/bitbucket", opts, async (req, reply) => {
    if (!verifyBitbucketSignature(raw(req), header(req, "x-hub-signature"))) return reply.code(401).send({ error: { code: "invalid_signature", message: "Invalid signature" } });
    const delivery = header(req, "x-request-uuid") ?? header(req, "x-hook-uuid");
    const event = header(req, "x-event-key") ?? "unknown";
    if (!(await firstDelivery("bitbucket", delivery, event))) return { ok: true, duplicate: true };
    const b = req.body as Any;
    const repo = b.repository?.full_name as string;
    if (event === "repo:push") {
      for (const ch of b.push?.changes ?? []) {
        if (ch.new?.type !== "branch") continue;
        await handlePush("bitbucket", { repo, branch: ch.new.name, sha: ch.new.target.hash, message: ch.new.target.message, author: ch.new.target.author?.user?.display_name });
      }
    } else if (event.startsWith("pullrequest:")) {
      const pr = b.pullrequest;
      const kind = event.split(":")[1];
      const action = kind === "created" ? "open" : kind === "updated" ? "update" : kind === "fulfilled" || kind === "rejected" ? "close" : null;
      if (action && pr.source?.repository?.full_name === repo) await handlePullRequest("bitbucket", { repo, number: pr.id, branch: pr.source.branch.name, sha: pr.source.commit.hash, action, title: pr.title, author: pr.author?.display_name });
    }
    await processed("bitbucket", delivery!);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------- Payments
  app.post("/webhooks/stripe", opts, async (req: FastifyRequest, reply: FastifyReply) => {
    let event;
    try {
      event = verifyStripeWebhook(raw(req), header(req, "stripe-signature"));
    } catch (e) {
      return reply.code(400).send({ error: { code: "invalid_signature", message: (e as Error).message } });
    }
    const result = await handleStripeEvent(event as never);
    return { ok: true, result };
  });

  app.post("/webhooks/paypal", opts, async (req, reply) => {
    const body = req.body as Any;
    let ok = false;
    try {
      ok = await verifyPaypalWebhook(req.headers, body);
    } catch (e) {
      return reply.code(400).send({ error: { code: "invalid_signature", message: (e as Error).message } });
    }
    if (!ok) return reply.code(400).send({ error: { code: "invalid_signature", message: "PayPal could not verify this event" } });
    return { ok: true, result: await handlePaypalEvent(body as never) };
  });

  app.post("/webhooks/flutterwave", opts, async (req, reply) => {
    try {
      if (!verifyFlutterwaveHash(header(req, "verif-hash"))) return reply.code(401).send({ error: { code: "invalid_signature", message: "Invalid hash" } });
    } catch (e) {
      return reply.code(400).send({ error: { code: "invalid_signature", message: (e as Error).message } });
    }
    const body = req.body as Any;
    const id = body?.data?.id;
    if (!id) return { ok: true, result: "ignored" };
    // Never trust the webhook payload for amounts: fetch the transaction from Flutterwave.
    const tx = await verifyFlutterwaveTransaction(id);
    return { ok: true, result: await handleFlutterwaveTransaction(tx.data) };
  });
}
