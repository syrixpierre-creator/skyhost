import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PlanFeatures, PlanLimits, RoleOverrides, ServiceConfig } from "@skyhost/shared";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export const regions = pgTable("regions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
});

export const nodes = pgTable("nodes", {
  id: id(),
  name: text("name").notNull().unique(),
  regionId: text("region_id").notNull(),
  roles: jsonb("roles").$type<string[]>().notNull().default([]),
  dockerHost: text("docker_host"),
  status: text("status").notNull().default("online"),
  lastHeartbeatAt: ts("last_heartbeat_at"),
  info: jsonb("info").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  /** Optional list of team ids the flag is limited to. */
  teamIds: jsonb("team_ids").$type<string[]>().notNull().default([]),
  updatedAt: updatedAt(),
});

export const announcements = pgTable("announcements", {
  id: id(),
  kind: text("kind").notNull().default("info"), // info | maintenance | incident
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  startsAt: ts("starts_at").notNull().defaultNow(),
  endsAt: ts("ends_at"),
  createdAt: createdAt(),
});

export const plans = pgTable("plans", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  interval: text("interval").notNull().default("month"),
  limits: jsonb("limits").$type<PlanLimits>().notNull(),
  features: jsonb("features").$type<PlanFeatures>().notNull(),
  /** Overage rates in cents (per unit) applied to metered usage above the included limits. */
  overage: jsonb("overage").$type<Record<string, number>>().notNull().default({}),
  isPublic: boolean("is_public").notNull().default(true),
  isContactSales: boolean("is_contact_sales").notNull().default(false),
  isFree: boolean("is_free").notNull().default(false),
  trialDays: integer("trial_days").notNull().default(0),
  stripePriceId: text("stripe_price_id"),
  paypalPlanId: text("paypal_plan_id"),
  sort: integer("sort").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    emailVerifiedAt: ts("email_verified_at"),
    avatarUrl: text("avatar_url"),
    locale: text("locale").notNull().default("en"),
    isAdmin: boolean("is_admin").notNull().default(false),
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabledAt: ts("totp_enabled_at"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    referralCode: text("referral_code").notNull(),
    referredByUserId: uuid("referred_by_user_id"),
    signupIp: text("signup_ip"),
    signupDeviceId: text("signup_device_id"),
    tosAcceptedAt: ts("tos_accepted_at"),
    suspendedAt: ts("suspended_at"),
    suspendedReason: text("suspended_reason"),
    personalCreditCents: integer("personal_credit_cents").notNull().default(0),
    payoutDetails: jsonb("payout_details").$type<{ method?: "stripe_connect" | "paypal"; accountId?: string; email?: string }>(),
    notificationPrefs: jsonb("notification_prefs").$type<Record<string, unknown>>().notNull().default({}),
    lastLoginAt: ts("last_login_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), uniqueIndex("users_referral_code_uq").on(t.referralCode)],
);

export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    deviceId: text("device_id"),
    impersonatorId: uuid("impersonator_id"),
    impersonationReason: text("impersonation_reason"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const emailTokens = pgTable(
  "email_tokens",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // verify | reset
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_tokens_hash_uq").on(t.tokenHash)],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // github | gitlab | bitbucket
    providerUserId: text("provider_user_id").notNull(),
    username: text("username"),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: ts("token_expires_at"),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("oauth_provider_user_uq").on(t.provider, t.providerUserId), index("oauth_user_idx").on(t.userId)],
);

export const cliAuthRequests = pgTable("cli_auth_requests", {
  id: id(),
  codeHash: text("code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  approvedByUserId: uuid("approved_by_user_id"),
  teamId: uuid("team_id"),
  apiKeyEnc: text("api_key_enc"),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const teams = pgTable("teams", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  ownerId: uuid("owner_id").notNull(),
  personal: boolean("personal").notNull().default(false),
  planId: uuid("plan_id"),
  defaultRegion: text("default_region").notNull().default("eu-west"),
  billingEmail: text("billing_email"),
  billingStatus: text("billing_status").notNull().default("none"), // none | trialing | active | past_due | suspended | cancelled
  billingCountry: text("billing_country"),
  taxId: text("tax_id"),
  creditBalanceCents: integer("credit_balance_cents").notNull().default(0),
  /** Percentage promo code redeemed by the team, applied once to its next plan payment. */
  pendingDiscountId: uuid("pending_discount_id"),
  stripeCustomerId: text("stripe_customer_id"),
  spendCapCents: integer("spend_cap_cents"),
  spendCapAction: text("spend_cap_action").notNull().default("block_deploys"), // alert | block_deploys | pause_services
  spendAlertsSent: jsonb("spend_alerts_sent").$type<Record<string, number[]>>().notNull().default({}),
  roleOverrides: jsonb("role_overrides").$type<RoleOverrides>().notNull().default({}),
  require2fa: boolean("require_2fa").notNull().default(false),
  sessionTtlHours: integer("session_ttl_hours"),
  dashboardIpAllowlist: jsonb("dashboard_ip_allowlist").$type<string[]>().notNull().default([]),
  deployFreeze: jsonb("deploy_freeze").$type<DeployFreeze>().notNull().default({ enabled: false, windows: [] }),
  retention: jsonb("retention").$type<RetentionSettings>().notNull().default({}),
  suspendedAt: ts("suspended_at"),
  suspendedReason: text("suspended_reason"),
  graceEndsAt: ts("grace_ends_at"),
  deletedAt: ts("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface DeployFreeze {
  enabled: boolean;
  /** mode "deny": deploys forbidden during windows. mode "allow": deploys only allowed during windows. */
  mode?: "deny" | "allow";
  timezone?: string;
  windows: Array<{ days: number[]; start: string; end: string }>;
}

export interface RetentionSettings {
  logsDays?: number;
  screenshotsDays?: number;
  backupsDays?: number;
  previewsDays?: number;
}

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index("team_members_user_idx").on(t.userId)],
);

export const teamInvites = pgTable(
  "team_invites",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    declinedAt: ts("declined_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("team_invites_team_idx").on(t.teamId), index("team_invites_email_idx").on(t.email)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    teamId: uuid("team_id"),
    actorUserId: uuid("actor_user_id"),
    actorApiKeyId: uuid("actor_api_key_id"),
    impersonatorId: uuid("impersonator_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_team_idx").on(t.teamId, t.createdAt), index("audit_actor_idx").on(t.actorUserId, t.createdAt)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull().unique(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    projectId: uuid("project_id"),
    serviceId: uuid("service_id"),
    expiresAt: ts("expires_at"),
    lastUsedAt: ts("last_used_at"),
    lastUsedIp: text("last_used_ip"),
    revokedAt: ts("revoked_at"),
    rotatedFromId: uuid("rotated_from_id"),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_team_idx").on(t.teamId)],
);

// ---------------------------------------------------------------------------
// Git providers
// ---------------------------------------------------------------------------

export const gitInstallations = pgTable(
  "git_installations",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type"),
    connectedByUserId: uuid("connected_by_user_id"),
    /** For OAuth based providers (GitLab/Bitbucket) the token used to access repositories. */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: ts("token_expires_at"),
    suspendedAt: ts("suspended_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("git_inst_team_provider_ext_uq").on(t.teamId, t.provider, t.externalId)],
);

export const webhookReceipts = pgTable(
  "webhook_receipts",
  {
    id: id(),
    source: text("source").notNull(), // github | gitlab | bitbucket | stripe | paypal | flutterwave
    deliveryId: text("delivery_id").notNull(),
    event: text("event"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    error: text("error"),
  },
  (t) => [uniqueIndex("webhook_receipts_uq").on(t.source, t.deliveryId)],
);

export const uploads = pgTable("uploads", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: uuid("user_id"),
  kind: text("kind").notNull(), // source-zip | screenshot | logo
  objectKey: text("object_key").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  fileCount: integer("file_count"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Projects, environments, services
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    regionId: text("region_id").notNull().default("eu-west"),
    canvas: jsonb("canvas").$type<Record<string, { x: number; y: number }>>().notNull().default({}),
    statusPageEnabled: boolean("status_page_enabled").notNull().default(false),
    statusPageSlug: text("status_page_slug"),
    statusPageDomain: text("status_page_domain"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_team_idx").on(t.teamId),
    uniqueIndex("projects_status_slug_uq").on(t.statusPageSlug),
    uniqueIndex("projects_team_slug_uq").on(t.teamId, t.slug).where(sql`deleted_at is null`),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const environments = pgTable(
  "environments",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    isEphemeral: boolean("is_ephemeral").notNull().default(false),
    prNumber: integer("pr_number"),
    branch: text("branch"),
    clonedFromId: uuid("cloned_from_id"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("environments_project_idx").on(t.projectId)],
);

export const services = pgTable(
  "services",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    type: text("type").notNull(),
    source: jsonb("source").$type<Record<string, unknown> & { kind: string }>().notNull(),
    config: jsonb("config").$type<ServiceConfig>().notNull(),
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),
    /** Stable random part of the generated hostname: <slug>-<subdomainId>.<base domain>. */
    subdomain: text("subdomain").notNull().unique(),
    createdBy: uuid("created_by"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_project_idx").on(t.projectId)],
);

/** Runtime state of a service in a given environment. */
export const serviceInstances = pgTable(
  "service_instances",
  {
    id: id(),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("idle"), // idle | deploying | running | sleeping | crashed | stopped | paused
    liveDeploymentId: uuid("live_deployment_id"),
    canaryDeploymentId: uuid("canary_deployment_id"),
    canaryWeight: integer("canary_weight").notNull().default(0),
    sleeping: boolean("sleeping").notNull().default(false),
    pausedReason: text("paused_reason"),
    lastRequestAt: ts("last_request_at"),
    restartCount: integer("restart_count").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("service_instances_uq").on(t.serviceId, t.environmentId)],
);

export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    phase: text("phase"),
    trigger: text("trigger").notNull().default("manual"), // manual | git | rollback | api | cli | template | redeploy | preview
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    commitAuthor: text("commit_author"),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    image: text("image"),
    sourceRef: jsonb("source_ref").$type<Record<string, unknown>>(),
    configSnapshot: jsonb("config_snapshot").$type<ServiceConfig>(),
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),
    containers: jsonb("containers").$type<string[]>().notNull().default([]),
    phases: jsonb("phases").$type<Record<string, { startedAt?: string; finishedAt?: string }>>().notNull().default({}),
    rollbackOfId: uuid("rollback_of_id"),
    isCanary: boolean("is_canary").notNull().default(false),
    createdBy: uuid("created_by"),
    createdByApiKeyId: uuid("created_by_api_key_id"),
    error: text("error"),
    errorAnalysis: jsonb("error_analysis").$type<unknown[]>(),
    buildSeconds: integer("build_seconds"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("deployments_service_idx").on(t.serviceId, t.createdAt), index("deployments_status_idx").on(t.status)],
);

export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade" }),
    stream: text("stream").notNull(), // build | deploy
    level: text("level").notNull().default("info"),
    line: text("line").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("deployment_logs_dep_idx").on(t.deploymentId, t.id)],
);

export const deploymentComments = pgTable("deployment_comments", {
  id: id(),
  deploymentId: uuid("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const variables = pgTable(
  "variables",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    /** null = shared by every service of the environment */
    serviceId: uuid("service_id"),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
    isSealed: boolean("is_sealed").notNull().default(false),
    /** Set for variables managed by SKYHOST (database connections). */
    managedBy: text("managed_by"),
    updatedBy: uuid("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("variables_scope_key_uq").on(t.environmentId, sql`coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key),
  ],
);

export const variableGroups = pgTable("variable_groups", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /** Optional parent group: items are inherited and can be overridden. */
  parentId: uuid("parent_id"),
  createdAt: createdAt(),
});

export const variableGroupItems = pgTable(
  "variable_group_items",
  {
    id: id(),
    groupId: uuid("group_id").notNull().references(() => variableGroups.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
  },
  (t) => [uniqueIndex("vg_items_uq").on(t.groupId, t.key)],
);

export const variableGroupLinks = pgTable(
  "variable_group_links",
  {
    id: id(),
    groupId: uuid("group_id").notNull().references(() => variableGroups.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    environmentType: text("environment_type"),
  },
  (t) => [index("vg_links_group_idx").on(t.groupId)],
);

export const domains = pgTable(
  "domains",
  {
    id: id(),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** service | status_page */
    target: text("target").notNull().default("service"),
    hostname: text("hostname").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    isWildcard: boolean("is_wildcard").notNull().default(false),
    redirectTo: text("redirect_to"),
    verificationToken: text("verification_token").notNull(),
    status: text("status").notNull().default("pending"),
    verifiedAt: ts("verified_at"),
    certIssuedAt: ts("cert_issued_at"),
    lastCheckedAt: ts("last_checked_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("domains_hostname_uq").on(t.hostname)],
);

export const volumes = pgTable("volumes", {
  id: id(),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mountPath: text("mount_path").notNull(),
  sizeMb: integer("size_mb").notNull(),
  dockerVolume: text("docker_volume").notNull().unique(),
  createdAt: createdAt(),
});

export const volumeSnapshots = pgTable("volume_snapshots", {
  id: id(),
  volumeId: uuid("volume_id").notNull().references(() => volumes.id, { onDelete: "cascade" }),
  objectKey: text("object_key"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  status: text("status").notNull().default("pending"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Databases & object storage
// ---------------------------------------------------------------------------

export const databases = pgTable(
  "databases",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    environmentId: uuid("environment_id").references(() => environments.id),
    name: text("name").notNull(),
    engine: text("engine").notNull(),
    version: text("version").notNull(),
    regionId: text("region_id").notNull(),
    status: text("status").notNull().default("provisioning"), // provisioning | available | error | stopped | deleting | restoring
    containerName: text("container_name").notNull(),
    dockerVolume: text("docker_volume").notNull(),
    internalHost: text("internal_host").notNull(),
    port: integer("port").notNull(),
    dbName: text("db_name").notNull(),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    storageMb: integer("storage_mb").notNull().default(1024),
    publicAccess: boolean("public_access").notNull().default(false),
    publicPort: integer("public_port"),
    ipAllowlist: jsonb("ip_allowlist").$type<string[]>().notNull().default([]),
    deletionProtection: boolean("deletion_protection").notNull().default(true),
    backupSchedule: text("backup_schedule").notNull().default("0 3 * * *"),
    backupRetentionDays: integer("backup_retention_days").notNull().default(7),
    backupsEnabled: boolean("backups_enabled").notNull().default(true),
    clonedFromId: uuid("cloned_from_id"),
    error: text("error"),
    readyAt: ts("ready_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("databases_team_idx").on(t.teamId), index("databases_project_idx").on(t.projectId)],
);

export const databaseConnections = pgTable(
  "database_connections",
  {
    id: id(),
    databaseId: uuid("database_id").notNull().references(() => databases.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    variableName: text("variable_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("db_conn_uq").on(t.databaseId, t.serviceId)],
);

export const databaseBackups = pgTable(
  "database_backups",
  {
    id: id(),
    databaseId: uuid("database_id").notNull().references(() => databases.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // manual | scheduled | pre-restore
    status: text("status").notNull().default("pending"), // pending | running | completed | failed
    objectKey: text("object_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksum: text("checksum"),
    encrypted: boolean("encrypted").notNull().default(true),
    verifiedAt: ts("verified_at"),
    error: text("error"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    expiresAt: ts("expires_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("db_backups_db_idx").on(t.databaseId, t.createdAt)],
);

export const databaseRestores = pgTable("database_restores", {
  id: id(),
  databaseId: uuid("database_id").notNull().references(() => databases.id, { onDelete: "cascade" }),
  backupId: uuid("backup_id").notNull(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  createdBy: uuid("created_by"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  createdAt: createdAt(),
});

export const buckets = pgTable(
  "buckets",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    /** Physical bucket name in the backing S3/MinIO store. */
    physicalName: text("physical_name").notNull().unique(),
    isPublic: boolean("is_public").notNull().default(false),
    accessKey: text("access_key").notNull(),
    secretKeyEnc: text("secret_key_enc").notNull(),
    quotaMb: integer("quota_mb").notNull(),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("buckets_team_idx").on(t.teamId)],
);

// ---------------------------------------------------------------------------
// Jobs, crons, shell
// ---------------------------------------------------------------------------

export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // cron | oneoff
    command: text("command").notNull(),
    status: text("status").notNull().default("queued"), // queued | running | succeeded | failed | timeout | cancelled
    exitCode: integer("exit_code"),
    output: text("output").notNull().default(""),
    triggeredBy: uuid("triggered_by"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("job_runs_service_idx").on(t.serviceId, t.createdAt)],
);

export const shellSessions = pgTable("shell_sessions", {
  id: id(),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  environmentId: uuid("environment_id").notNull(),
  userId: uuid("user_id").notNull(),
  containerId: text("container_id"),
  ip: text("ip"),
  transcript: jsonb("transcript").$type<Array<{ at: string; cmd: string; exitCode?: number | null; rejected?: boolean }>>().notNull().default([]),
  startedAt: ts("started_at").notNull().defaultNow(),
  endedAt: ts("ended_at"),
  endReason: text("end_reason"),
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export const metricSamples = pgTable(
  "metric_samples",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serviceId: uuid("service_id"),
    environmentId: uuid("environment_id"),
    databaseId: uuid("database_id"),
    cpuPercent: doublePrecision("cpu_percent").notNull().default(0),
    memoryBytes: bigint("memory_bytes", { mode: "number" }).notNull().default(0),
    memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }).notNull().default(0),
    netRxBytes: bigint("net_rx_bytes", { mode: "number" }).notNull().default(0),
    netTxBytes: bigint("net_tx_bytes", { mode: "number" }).notNull().default(0),
    diskBytes: bigint("disk_bytes", { mode: "number" }).notNull().default(0),
    requests: integer("requests").notNull().default(0),
    avgResponseMs: doublePrecision("avg_response_ms"),
    restarts: integer("restarts").notNull().default(0),
    up: boolean("up").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("metrics_service_idx").on(t.serviceId, t.createdAt), index("metrics_db_idx").on(t.databaseId, t.createdAt)],
);

export const alertRules = pgTable("alert_rules", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id"),
  metric: text("metric").notNull(), // cpu | memory | crash | unhealthy | deploy_failed | quota
  threshold: doublePrecision("threshold"),
  durationMinutes: integer("duration_minutes").notNull().default(5),
  enabled: boolean("enabled").notNull().default(true),
  lastTriggeredAt: ts("last_triggered_at"),
  createdAt: createdAt(),
});

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const notificationChannels = pgTable("notification_channels", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // email | slack | discord | webhook
  name: text("name").notNull(),
  configEnc: text("config_enc").notNull(),
  events: jsonb("events").$type<string[]>().notNull().default([]),
  quietHours: jsonb("quiet_hours").$type<{ start: string; end: string; timezone: string } | null>(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const outgoingWebhooks = pgTable("outgoing_webhooks", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  events: jsonb("events").$type<string[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    webhookId: uuid("webhook_id").notNull().references(() => outgoingWebhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    responseCode: integer("response_code"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    deliveredAt: ts("delivered_at"),
  },
  (t) => [index("webhook_deliveries_hook_idx").on(t.webhookId, t.createdAt)],
);

export const uptimeChecks = pgTable("uptime_checks", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id"),
  name: text("name").notNull(),
  url: text("url").notNull(),
  intervalSeconds: integer("interval_seconds").notNull().default(60),
  expectedStatus: integer("expected_status").notNull().default(200),
  enabled: boolean("enabled").notNull().default(true),
  lastStatus: text("last_status"),
  lastCheckedAt: ts("last_checked_at"),
  createdAt: createdAt(),
});

export const uptimeResults = pgTable(
  "uptime_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    checkId: uuid("check_id").notNull().references(() => uptimeChecks.id, { onDelete: "cascade" }),
    up: boolean("up").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("uptime_results_check_idx").on(t.checkId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export const screenshots = pgTable(
  "screenshots",
  {
    id: id(),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    deploymentId: uuid("deployment_id"),
    commitSha: text("commit_sha"),
    kind: text("kind").notNull(), // auto | manual | upload
    status: text("status").notNull().default("pending"), // pending | completed | failed
    path: text("path").notNull().default("/"),
    viewport: text("viewport").notNull().default("desktop"), // desktop | tablet | mobile
    fullPage: boolean("full_page").notNull().default(false),
    delayMs: integer("delay_ms").notNull().default(0),
    mimeType: text("mime_type").notNull().default("image/png"),
    objectKey: text("object_key"),
    sizeBytes: integer("size_bytes"),
    title: text("title"),
    description: text("description"),
    shareTokenHash: text("share_token_hash"),
    shareExpiresAt: ts("share_expires_at"),
    shareRevokedAt: ts("share_revoked_at"),
    error: text("error"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("screenshots_service_idx").on(t.serviceId, t.createdAt), uniqueIndex("screenshots_share_uq").on(t.shareTokenHash)],
);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull(),
    provider: text("provider").notNull(), // stripe | paypal | credits | manual
    providerSubscriptionId: text("provider_subscription_id"),
    status: text("status").notNull(), // incomplete | trialing | active | past_due | cancelled | unpaid
    currentPeriodStart: ts("current_period_start"),
    currentPeriodEnd: ts("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    failedPaymentCount: integer("failed_payment_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("subscriptions_team_idx").on(t.teamId), uniqueIndex("subscriptions_provider_uq").on(t.provider, t.providerSubscriptionId)],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    userId: uuid("user_id"),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    kind: text("kind").notNull().default("subscription"), // subscription | credits
    amountCents: integer("amount_cents").notNull(),
    taxCents: integer("tax_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull(), // succeeded | failed | refunded | partially_refunded | disputed
    refundedCents: integer("refunded_cents").notNull().default(0),
    paymentMethodFingerprint: text("payment_method_fingerprint"),
    invoiceId: uuid("invoice_id"),
    subscriptionId: uuid("subscription_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("payments_provider_uq").on(t.provider, t.providerPaymentId), index("payments_team_idx").on(t.teamId)],
);

export const paymentMethods = pgTable("payment_methods", {
  id: id(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerPaymentMethodId: text("provider_payment_method_id").notNull(),
  brand: text("brand"),
  last4: text("last4"),
  expMonth: integer("exp_month"),
  expYear: integer("exp_year"),
  fingerprint: text("fingerprint"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
});

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    number: text("number").notNull().unique(),
    provider: text("provider").notNull(),
    providerInvoiceId: text("provider_invoice_id"),
    status: text("status").notNull(), // draft | open | paid | void | refunded
    subtotalCents: integer("subtotal_cents").notNull(),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    lines: jsonb("lines").$type<Array<{ description: string; amountCents: number; quantity?: number }>>().notNull().default([]),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    hostedUrl: text("hosted_url"),
    paidAt: ts("paid_at"),
    createdAt: createdAt(),
  },
  (t) => [index("invoices_team_idx").on(t.teamId)],
);

export const billingEvents = pgTable(
  "billing_events",
  {
    id: id(),
    teamId: uuid("team_id"),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: ts("processed_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("billing_events_uq").on(t.provider, t.eventId)],
);

export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: id(),
    teamId: uuid("team_id"),
    userId: uuid("user_id"),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(), // topup | usage | referral | refund | adjustment | subscription
    reference: text("reference"),
    createdAt: createdAt(),
  },
  (t) => [index("credit_tx_team_idx").on(t.teamId, t.createdAt), uniqueIndex("credit_tx_ref_uq").on(t.reason, t.reference)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    teamId: uuid("team_id").notNull(),
    serviceId: uuid("service_id"),
    metric: text("metric").notNull(), // cpu_seconds | memory_mb_seconds | bandwidth_bytes | build_seconds | storage_mb_hours
    quantity: doublePrecision("quantity").notNull(),
    periodStart: ts("period_start").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("usage_team_idx").on(t.teamId, t.periodStart)],
);

export const taxRates = pgTable("tax_rates", {
  id: id(),
  country: text("country").notNull().unique(),
  name: text("name").notNull(),
  percent: doublePrecision("percent").notNull(),
  reverseCharge: boolean("reverse_charge").notNull().default(false),
});

export const discounts = pgTable("discounts", {
  id: id(),
  code: text("code").notNull().unique(),
  percentOff: integer("percent_off"),
  amountOffCents: integer("amount_off_cents"),
  maxRedemptions: integer("max_redemptions"),
  redemptions: integer("redemptions").notNull().default(0),
  expiresAt: ts("expires_at"),
  createdAt: createdAt(),
});

/** One redemption of a promo code per team. */
export const discountRedemptions = pgTable(
  "discount_redemptions",
  {
    id: id(),
    discountId: uuid("discount_id").notNull().references(() => discounts.id),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** credits: amount added to the balance; pending: waiting for the next payment; applied: used on a payment. */
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    appliedAt: ts("applied_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("discount_redemptions_team_uq").on(t.discountId, t.teamId)],
);

// ---------------------------------------------------------------------------
// Referral
// ---------------------------------------------------------------------------

export const referralClicks = pgTable(
  "referral_clicks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    referrerUserId: uuid("referrer_user_id").notNull(),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("ref_clicks_user_idx").on(t.referrerUserId, t.createdAt)],
);

export const referrals = pgTable(
  "referrals",
  {
    id: id(),
    referrerUserId: uuid("referrer_user_id").notNull(),
    referredUserId: uuid("referred_user_id").notNull().unique(),
    status: text("status").notNull().default("signed_up"), // signed_up | converted | flagged | rejected
    fraudFlags: jsonb("fraud_flags").$type<string[]>().notNull().default([]),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: ts("reviewed_at"),
    convertedAt: ts("converted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("referrals_referrer_idx").on(t.referrerUserId)],
);

export const referralRewards = pgTable(
  "referral_rewards",
  {
    id: id(),
    referralId: uuid("referral_id").notNull().references(() => referrals.id, { onDelete: "cascade" }),
    referrerUserId: uuid("referrer_user_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** pending (refund window) -> approved (credited) -> paid (payout) | cancelled (refund/chargeback) | held (fraud review) */
    status: text("status").notNull().default("pending"),
    holdUntil: ts("hold_until").notNull(),
    approvedAt: ts("approved_at"),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    payoutId: uuid("payout_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ref_rewards_payment_uq").on(t.paymentId), index("ref_rewards_user_idx").on(t.referrerUserId)],
);

export const referralPayouts = pgTable("referral_payouts", {
  id: id(),
  userId: uuid("user_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  method: text("method").notNull(), // credit | stripe_connect | paypal
  status: text("status").notNull().default("pending"), // pending | processing | paid | failed
  providerReference: text("provider_reference"),
  teamId: uuid("team_id"),
  error: text("error"),
  createdAt: createdAt(),
  paidAt: ts("paid_at"),
});

// ---------------------------------------------------------------------------
// Abuse
// ---------------------------------------------------------------------------

export const abuseReports = pgTable("abuse_reports", {
  id: id(),
  reporterEmail: text("reporter_email"),
  reporterUserId: uuid("reporter_user_id"),
  targetUrl: text("target_url").notNull(),
  category: text("category").notNull(), // phishing | spam | malware | mining | ddos | copyright | other
  description: text("description").notNull(),
  serviceId: uuid("service_id"),
  teamId: uuid("team_id"),
  status: text("status").notNull().default("open"), // open | investigating | actioned | dismissed
  source: text("source").notNull().default("report"), // report | detector
  createdAt: createdAt(),
});

export const abuseDecisions = pgTable("abuse_decisions", {
  id: id(),
  reportId: uuid("report_id"),
  teamId: uuid("team_id"),
  userId: uuid("user_id"),
  action: text("action").notNull(), // suspend | unsuspend | warn | dismiss
  reason: text("reason").notNull(),
  automatic: boolean("automatic").notNull().default(false),
  decidedBy: uuid("decided_by"),
  createdAt: createdAt(),
});

export const statusIncidents = pgTable("status_incidents", {
  id: id(),
  projectId: uuid("project_id"),
  title: text("title").notNull(),
  status: text("status").notNull().default("investigating"), // investigating | identified | monitoring | resolved
  impact: text("impact").notNull().default("minor"),
  body: text("body").notNull().default(""),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Deploy hooks: secret URLs that trigger a deployment (CI, CMS, cron outside SKYHOST)
// ---------------------------------------------------------------------------

export const deployHooks = pgTable(
  "deploy_hooks",
  {
    id: id(),
    serviceId: uuid("service_id").notNull().references(() => services.id),
    environmentId: uuid("environment_id").notNull().references(() => environments.id),
    name: text("name").notNull(),
    /** sha256 of the secret token; the URL is shown once. */
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("deploy_hooks_service_idx").on(t.serviceId)],
);
