export const SERVICE_TYPES = ["web", "static", "worker", "cron", "private", "docker", "job"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const DEPLOYMENT_STATUSES = ["queued", "building", "deploying", "live", "failed", "cancelled", "stopped", "superseded"] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];
export const TERMINAL_DEPLOYMENT_STATUSES: DeploymentStatus[] = ["live", "failed", "cancelled", "stopped", "superseded"];

export const DEPLOYMENT_PHASES = ["clone", "analyze", "install", "build", "test", "image", "deploy", "healthcheck", "live"] as const;
export type DeploymentPhase = (typeof DEPLOYMENT_PHASES)[number];

export const ENVIRONMENT_TYPES = ["production", "staging", "preview", "development"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export const DATABASE_ENGINES = ["postgres", "mariadb", "mongodb", "redis"] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

export const DATABASE_VERSIONS: Record<DatabaseEngine, string[]> = {
  postgres: ["17", "16", "15"],
  mariadb: ["11.4", "10.11"],
  mongodb: ["8.0", "7.0"],
  redis: ["7.4", "7.2"],
};

/** Variable name injected when connecting a database to a service. */
export const DATABASE_ENV_VAR: Record<DatabaseEngine, string> = {
  postgres: "DATABASE_URL",
  mariadb: "DATABASE_URL",
  mongodb: "MONGODB_URI",
  redis: "REDIS_URL",
};

export const DOMAIN_STATUSES = ["pending", "verified", "ssl_issued", "error"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export const SOURCE_KINDS = ["github", "gitlab", "bitbucket", "git", "zip", "image", "template"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const NOTIFICATION_CHANNELS = ["email", "web", "slack", "discord", "webhook", "telegram", "whatsapp"] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNELS)[number];

export const EVENT_TYPES = [
  "deployment.succeeded",
  "deployment.failed",
  "deployment.started",
  "deployment.rolled_back",
  "database.ready",
  "database.backup.completed",
  "database.backup.failed",
  "service.crashed",
  "service.unhealthy",
  "alert.triggered",
  "quota.near_limit",
  "spend.threshold",
  "invitation.received",
  "billing.payment_succeeded",
  "billing.payment_failed",
  "referral.reward",
  "domain.verified",
  "screenshot.captured",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const PLAN_LIMIT_KEYS = [
  "cpu",
  "memoryMb",
  "storageMb",
  "bandwidthGb",
  "buildMinutes",
  "services",
  "databases",
  "members",
  "deploysPerDay",
  "logRetentionDays",
  "backupRetentionDays",
  "customDomains",
  "screenshotsPerMonth",
  "previewEnvironments",
  "projects",
  "volumesMb",
  "buckets",
  "bucketStorageMb",
  "cronJobs",
] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export type PlanLimits = Record<PlanLimitKey, number>;

export const PLAN_FEATURE_KEYS = [
  "sleepWhenIdle",
  "autoSleepForced",
  "previews",
  "canary",
  "sso",
  "waf",
  "publicDatabaseAccess",
  "prioritySupport",
  "accessProtection",
  "uptimeMonitoring",
  "objectStorage",
] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];
export type PlanFeatures = Record<PlanFeatureKey, boolean>;

export const REGIONS = [
  { id: "eu-west", name: "Europe West", default: true },
  { id: "us-east", name: "US East", default: false },
  { id: "af-west", name: "Africa West", default: false },
] as const;
