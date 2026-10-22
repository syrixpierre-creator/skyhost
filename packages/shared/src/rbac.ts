export const ROLES = ["owner", "admin", "developer", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "team:read",
  "team:update",
  "team:delete",
  "team:transfer",
  "team:security",
  "members:read",
  "members:invite",
  "members:remove",
  "members:role",
  "billing:read",
  "billing:manage",
  "audit:read",
  "project:create",
  "project:read",
  "project:update",
  "project:delete",
  "service:create",
  "service:read",
  "service:update",
  "service:delete",
  "deploy:create",
  "deploy:cancel",
  "deploy:rollback",
  "env:read",
  "env:read_secret",
  "env:write",
  "domain:manage",
  "database:create",
  "database:read",
  "database:credentials",
  "database:query",
  "database:backup",
  "database:delete",
  "storage:manage",
  "logs:read",
  "metrics:read",
  "shell:access",
  "apikey:manage",
  "screenshot:create",
  "screenshot:share",
  "webhook:manage",
  "notifications:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = [
  "team:read",
  "members:read",
  "project:read",
  "service:read",
  "env:read",
  "database:read",
  "logs:read",
  "metrics:read",
];

const DEFAULTS: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter((p) => p !== "team:delete" && p !== "team:transfer"),
  developer: [
    ...READ,
    "project:create",
    "project:update",
    "service:create",
    "service:update",
    "service:delete",
    "deploy:create",
    "deploy:cancel",
    "deploy:rollback",
    "env:read_secret",
    "env:write",
    "domain:manage",
    "database:create",
    "database:credentials",
    "database:query",
    "database:backup",
    "storage:manage",
    "shell:access",
    "apikey:manage",
    "screenshot:create",
    "screenshot:share",
    "webhook:manage",
    "billing:read",
  ],
  member: [...READ, "deploy:create", "screenshot:create", "apikey:manage"],
  viewer: [...READ],
};

/** Ordering used when a minimum role is required (e.g. shell needs >= developer). */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, developer: 2, admin: 3, owner: 4 };

export interface RoleOverrides {
  [role: string]: { grant?: Permission[]; revoke?: Permission[] } | undefined;
}

export function permissionsFor(role: Role, overrides?: RoleOverrides | null): Set<Permission> {
  const set = new Set<Permission>(DEFAULTS[role]);
  // Owners always keep every permission: overrides can never lock the team out.
  if (role === "owner" || !overrides) return set;
  const o = overrides[role];
  for (const p of o?.grant ?? []) {
    // Ownership-only permissions cannot be granted to other roles.
    if (p === "team:delete" || p === "team:transfer") continue;
    set.add(p);
  }
  for (const p of o?.revoke ?? []) set.delete(p);
  return set;
}

export function can(role: Role, permission: Permission, overrides?: RoleOverrides | null): boolean {
  return permissionsFor(role, overrides).has(permission);
}

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Scopes usable by API keys. A key can never exceed its creator's role. */
export const API_KEY_SCOPES = ["read", "deploy", "write", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const SCOPE_PERMS: Record<ApiKeyScope, (p: Permission) => boolean> = {
  read: (p) => READ.includes(p),
  deploy: (p) => READ.includes(p) || p === "deploy:create" || p === "deploy:cancel" || p === "deploy:rollback",
  write: (p) => !["team:delete", "team:transfer", "billing:manage", "members:role", "members:remove", "apikey:manage"].includes(p),
  admin: () => true,
};

export function scopeAllows(scopes: ApiKeyScope[], permission: Permission): boolean {
  return scopes.some((s) => SCOPE_PERMS[s]?.(permission));
}
