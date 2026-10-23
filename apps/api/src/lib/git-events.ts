import { and, eq, isNull, sql } from "drizzle-orm";
import { environments, getDb, gitInstallations, projects, serviceInstances, services, teams } from "@skyhost/db";
import { assertQuota, audit, createDeployment, enqueue, getTeamPlan, providerClient, publicUrl, serviceHostname } from "@skyhost/core";

type Provider = "github" | "gitlab" | "bitbucket";

/** Services linked to a repository through an installation of the given provider account. */
async function linkedServices(provider: Provider, repo: string, externalInstallationId?: string) {
  const db = getDb();
  const rows = await db
    .select({ svc: services, project: projects, inst: gitInstallations, team: teams })
    .from(services)
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(gitInstallations, sql`${gitInstallations.id}::text = ${services.source}->>'installationId'`)
    .where(and(isNull(services.deletedAt), isNull(projects.deletedAt), sql`${services.source}->>'kind' = ${provider}`, sql`lower(${services.source}->>'repo') = ${repo.toLowerCase()}`));
  return rows.filter((r) => !externalInstallationId || r.inst.externalId === externalInstallationId);
}

/** Push: auto-deploy every service tracking this branch (production environment). */
export async function handlePush(provider: Provider, o: { repo: string; branch: string; sha: string; message?: string; author?: string; installationId?: string; changedFiles?: string[] }) {
  const db = getDb();
  const results: string[] = [];
  for (const { svc, project, team } of await linkedServices(provider, o.repo, o.installationId)) {
    if (!svc.config.autoDeploy) continue;
    const branch = (svc.source as { branch?: string }).branch;
    if (branch && branch !== o.branch) continue;
    // Monorepos: only deploy when files under the service root (or its watch paths) changed.
    const root = svc.config.rootDir && svc.config.rootDir !== "." ? svc.config.rootDir.replace(/\/$/, "") + "/" : null;
    const watch = [...(root ? [root] : []), ...(svc.config.watchPaths ?? [])];
    if (watch.length && o.changedFiles?.length && !o.changedFiles.some((f) => watch.some((w) => f.startsWith(w)))) continue;
    const [prod] = await db.select().from(environments).where(and(eq(environments.projectId, project.id), eq(environments.type, "production")));
    if (!prod || team.suspendedAt) continue;
    try {
      const dep = await createDeployment({
        serviceId: svc.id,
        environmentId: prod.id,
        trigger: "git",
        commit: { sha: o.sha, message: o.message ?? null, author: o.author ?? null, branch: o.branch },
        sourceRef: { waitForCi: svc.config.waitForCi },
      });
      results.push(dep.id);
    } catch (e) {
      await audit(null, team.id, "deployment.skipped", { type: "service", id: svc.id }, { reason: (e as Error).message, commit: o.sha });
    }
  }
  return results;
}

/** Pull/merge request lifecycle: create/update a preview environment, or tear it down when closed. */
export async function handlePullRequest(provider: Provider, o: { repo: string; number: number; branch: string; sha: string; action: "open" | "update" | "close"; title?: string; author?: string; installationId?: string }) {
  const db = getDb();
  const byProject = new Map<string, Awaited<ReturnType<typeof linkedServices>>>();
  for (const row of await linkedServices(provider, o.repo, o.installationId)) {
    if (!row.svc.config.previews) continue;
    byProject.set(row.project.id, [...(byProject.get(row.project.id) ?? []), row]);
  }
  const deployed: Array<{ service: string; url: string | null }> = [];
  for (const [projectId, rows] of byProject) {
    const team = rows[0]!.team;
    const [existing] = await db.select().from(environments).where(and(eq(environments.projectId, projectId), eq(environments.type, "preview"), eq(environments.prNumber, o.number), isNull(environments.deletedAt)));
    if (o.action === "close") {
      if (existing) {
        await db.update(environments).set({ deletedAt: new Date() }).where(eq(environments.id, existing.id));
        await enqueue("maintenance", { task: `teardown-environment:${existing.id}` });
        await audit(null, team.id, "preview.deleted", { type: "environment", id: existing.id }, { pr: o.number });
      }
      continue;
    }
    const plan = await getTeamPlan(team.id);
    if (!plan.features.previews) continue;
    let env = existing;
    if (!env) {
      try {
        await assertQuota(team.id, "previewEnvironments");
      } catch {
        await audit(null, team.id, "preview.skipped", { type: "project", id: projectId }, { reason: "quota", pr: o.number });
        continue;
      }
      [env] = await db.insert(environments).values({ projectId, name: `pr-${o.number}`, type: "preview", isEphemeral: true, prNumber: o.number, branch: o.branch }).returning();
      await audit(null, team.id, "preview.created", { type: "environment", id: env!.id }, { pr: o.number });
    }
    for (const { svc } of rows) {
      await db.insert(serviceInstances).values({ serviceId: svc.id, environmentId: env!.id }).onConflictDoNothing();
      try {
        await createDeployment({ serviceId: svc.id, environmentId: env!.id, trigger: "preview", prNumber: o.number, commit: { sha: o.sha, branch: o.branch, message: o.title ?? null, author: o.author ?? null } });
        deployed.push({ service: svc.name, url: ["web", "static", "docker"].includes(svc.type) ? publicUrl(serviceHostname(svc, env!)) : null });
      } catch (e) {
        await audit(null, team.id, "deployment.skipped", { type: "service", id: svc.id }, { reason: (e as Error).message, pr: o.number });
      }
    }
    if (o.action === "open" && deployed.length) {
      const inst = rows[0]!.inst;
      const body = `### SKYHOST preview\n\n${deployed.map((d) => `- **${d.service}**: ${d.url ?? "(no public URL)"}`).join("\n")}\n\nThe preview updates on every push and is deleted when the pull request is closed.`;
      await providerClient(inst).commentOnPullRequest(o.repo, o.number, body).catch(() => {});
    }
  }
  return deployed;
}
