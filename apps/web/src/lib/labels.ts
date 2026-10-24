import type { PlanFeatureKey, PlanLimitKey } from "@skyhost/shared";
import { t } from "./i18n";

const LIMITS: Record<PlanLimitKey, string> = {
  cpu: "vCPU",
  memoryMb: "Memory",
  storageMb: "Storage",
  bandwidthGb: "Bandwidth",
  buildMinutes: "Build minutes per month",
  services: "Services",
  databases: "Databases",
  members: "Team members",
  deploysPerDay: "Deployments per day",
  logRetentionDays: "Log retention (days)",
  backupRetentionDays: "Backup retention (days)",
  customDomains: "Custom domains",
  screenshotsPerMonth: "Screenshots per month",
  previewEnvironments: "Preview environments",
  projects: "Projects",
  volumesMb: "Volumes",
  buckets: "Buckets",
  bucketStorageMb: "Object storage",
  cronJobs: "Cron jobs",
};

const FEATURES: Record<PlanFeatureKey, string> = {
  sleepWhenIdle: "Sleep when idle",
  autoSleepForced: "Forced sleep when idle",
  previews: "Pull request previews",
  canary: "Canary releases",
  sso: "Single sign-on",
  waf: "Web application firewall",
  publicDatabaseAccess: "Public database access",
  prioritySupport: "Priority support",
  accessProtection: "Access protection",
  uptimeMonitoring: "Uptime monitoring",
  objectStorage: "Object storage",
};

const EVENTS: Record<string, string> = {
  "deployment.succeeded": "Deployment succeeded",
  "deployment.failed": "Deployment failed",
  "deployment.started": "Deployment started",
  "deployment.rolled_back": "Deployment rolled back",
  "database.ready": "Database ready",
  "database.backup.completed": "Database backup completed",
  "database.backup.failed": "Database backup failed",
  "service.crashed": "Application crashed",
  "service.unhealthy": "Application down",
  "alert.triggered": "Alert triggered",
  "quota.near_limit": "Quota almost reached",
  "spend.threshold": "Spending threshold reached",
  "invitation.received": "Team invitation",
  "billing.payment_succeeded": "Payment received",
  "billing.payment_failed": "Payment failed",
  "referral.reward": "Referral reward",
  "domain.verified": "Domain verified",
  "screenshot.captured": "Screenshot captured",
  "security.new_login": "New sign-in to your account",
};

export const eventLabel = (k: string) => t(EVENTS[k] ?? k);
export const limitLabel = (k: string) => t(LIMITS[k as PlanLimitKey] ?? k);
export const featureLabel = (k: string) => t(FEATURES[k as PlanFeatureKey] ?? k);

/** Limits at or above this value mean "no limit" (1 TB expressed in MB is still a real limit). */
const UNLIMITED = 1_000_000_000;

/** "2 GB", "Unlimited", "4 vCPU"… for a plan limit value. */
export function limitValue(k: string, v: number) {
  if (v >= UNLIMITED) return t("Unlimited");
  if (k.endsWith("Mb")) {
    if (v >= 1024 * 1024) return `${Math.round((v / 1024 / 1024) * 10) / 10} ${t("TB")}`;
    return v >= 1024 ? `${Math.round((v / 1024) * 10) / 10} ${t("GB")}` : `${v} ${t("MB")}`;
  }
  if (k.endsWith("Gb")) return `${v} ${t("GB")}`;
  return String(v);
}
