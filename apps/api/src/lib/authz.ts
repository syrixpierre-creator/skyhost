import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import {
  buckets, databases, deployments, domains, environments, getDb, projectMembers, projects, screenshots, services, teamMembers, teams,
} from "@skyhost/db";
import { isRole, permissionsFor, scopeAllows, type ApiKeyScope, type Permission, type Role } from "@skyhost/shared";
import { AppError, forbidden, notFound, unauthorized } from "@skyhost/core";
import { clientIp } from "./auth";

export type Team = typeof teams.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Service = typeof services.$inferSelect;

export interface TeamAccess {
  team: Team;
  role: Role;
  permissions: Set<Permission>;
}

function ipInList(ip: string, list: string[]): boolean {
  const toInt = (x: string) => x.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const v4 = ip.replace(/^::ffff:/, "");
  return list.some((entry) => {
    const [base, bits] = entry.split("/");
    if (!bits) return base === v4 || base === ip;
    if (!v4.includes(".") || !base!.includes(".")) return false;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toInt(v4) & mask) === (toInt(base!) & mask);
  });
}

/**
 * Central authorization check: authentication + team membership + role permission (+ API key scope/team
 * restriction + team security policies). Non-members get 404 so resources of other teams are not disclosed.
 */
export async function teamAccess(req: FastifyRequest, teamId: string, permission: Permission, projectId?: string): Promise<TeamAccess> {
  const user = req.auth.user;
  if (!user) throw unauthorized();
  const db = getDb();
  const [row] = await db
    .select({ team: teams, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id), isNull(teams.deletedAt)));
  // Platform admins impersonating a user act with that user's memberships only.
  if (!row) throw notFound("Team");
  let role = isRole(row.role) ? row.role : "viewer";
  if (projectId) {
    const [pm] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)));
    if (pm && isRole(pm.role) && pm.role !== "owner") role = pm.role;
  }
  const perms = permissionsFor(role, row.team.roleOverrides);

  const key = req.auth.apiKey;
  if (key) {
    if (key.teamId !== teamId) throw notFound("Team");
    if (key.projectId && projectId && key.projectId !== projectId) throw forbidden("This API key is restricted to another project");
    if (key.projectId && !projectId && !permission.startsWith("team:read") && permission !== "project:read") throw forbidden("This API key is restricted to a project");
    if (!scopeAllows(key.scopes as ApiKeyScope[], permission)) throw forbidden(`This API key does not have the scope required for ${permission}`);
  } else if (req.auth.session) {
    const t = row.team;
    if (t.require2fa && !user.totpEnabledAt && !req.auth.session.impersonatorId) {
      throw new AppError(403, "team_requires_2fa", "This team requires two-factor authentication. Enable 2FA in your account settings.");
    }
    if (t.sessionTtlHours && Date.now() - req.auth.session.createdAt.getTime() > t.sessionTtlHours * 3600 * 1000) {
      throw new AppError(401, "session_expired_for_team", "Your session is older than this team allows. Please sign in again.");
    }
    if (t.dashboardIpAllowlist.length && !ipInList(clientIp(req), t.dashboardIpAllowlist)) {
      throw new AppError(403, "ip_not_allowed", "Your IP address is not allowed to access this team.");
    }
  }
  if (!perms.has(permission)) throw forbidden(`Your role (${role}) does not allow ${permission}`);
  return { team: row.team, role, permissions: perms };
}

export async function projectAccess(req: FastifyRequest, projectId: string, permission: Permission) {
  const [project] = await getDb().select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!project) throw notFound("Project");
  const access = await teamAccess(req, project.teamId, permission, project.id);
  return { ...access, project };
}

export async function serviceAccess(req: FastifyRequest, serviceId: string, permission: Permission) {
  const [service] = await getDb().select().from(services).where(and(eq(services.id, serviceId), isNull(services.deletedAt)));
  if (!service) throw notFound("Service");
  const key = req.auth.apiKey;
  if (key?.serviceId && key.serviceId !== service.id) throw notFound("Service");
  const access = await projectAccess(req, service.projectId, permission);
  return { ...access, service };
}

export async function environmentAccess(req: FastifyRequest, environmentId: string, permission: Permission) {
  const [env] = await getDb().select().from(environments).where(and(eq(environments.id, environmentId), isNull(environments.deletedAt)));
  if (!env) throw notFound("Environment");
  const access = await projectAccess(req, env.projectId, permission);
  return { ...access, environment: env };
}

export async function deploymentAccess(req: FastifyRequest, deploymentId: string, permission: Permission) {
  const [dep] = await getDb().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!dep) throw notFound("Deployment");
  const access = await serviceAccess(req, dep.serviceId, permission);
  return { ...access, deployment: dep };
}

export async function databaseAccess(req: FastifyRequest, databaseId: string, permission: Permission) {
  const [db] = await getDb().select().from(databases).where(and(eq(databases.id, databaseId), isNull(databases.deletedAt)));
  if (!db) throw notFound("Database");
  const access = await projectAccess(req, db.projectId, permission);
  if (access.team.id !== db.teamId) throw notFound("Database");
  return { ...access, database: db };
}

export async function domainAccess(req: FastifyRequest, domainId: string, permission: Permission) {
  const [d] = await getDb().select().from(domains).where(eq(domains.id, domainId));
  if (!d) throw notFound("Domain");
  if (d.serviceId) return { ...(await serviceAccess(req, d.serviceId, permission)), domain: d };
  if (d.projectId) return { ...(await projectAccess(req, d.projectId, permission)), domain: d, service: null };
  throw notFound("Domain");
}

export async function bucketAccess(req: FastifyRequest, bucketId: string, permission: Permission) {
  const [b] = await getDb().select().from(buckets).where(and(eq(buckets.id, bucketId), isNull(buckets.deletedAt)));
  if (!b) throw notFound("Bucket");
  return { ...(await projectAccess(req, b.projectId, permission)), bucket: b };
}

export async function screenshotAccess(req: FastifyRequest, screenshotId: string, permission: Permission) {
  const [s] = await getDb().select().from(screenshots).where(eq(screenshots.id, screenshotId));
  if (!s) throw notFound("Screenshot");
  return { ...(await serviceAccess(req, s.serviceId, permission)), screenshot: s };
}

export function requireAdmin(req: FastifyRequest) {
  const u = req.auth.user;
  if (!u) throw unauthorized();
  // Impersonated sessions never carry admin powers.
  if (!u.isAdmin || req.auth.session?.impersonatorId || req.auth.apiKey) throw notFound("Page");
  return u;
}
