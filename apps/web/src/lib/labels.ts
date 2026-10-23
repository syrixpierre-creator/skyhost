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

export const limitLabel = (k: string) => t(LIMITS[k as PlanLimitKey] ?? k);
export const featureLabel = (k: string) => t(FEATURES[k as PlanFeatureKey] ?? k);

/** "2 GB", "Unlimited", "4 vCPU"… for a plan limit value. */
export function limitValue(k: string, v: number) {
  if (v >= 1_000_000) return t("Unlimited");
  if (k.endsWith("Mb")) return v >= 1024 ? `${Math.round((v / 1024) * 10) / 10} ${t("GB")}` : `${v} ${t("MB")}`;
  if (k.endsWith("Gb")) return `${v} ${t("GB")}`;
  return String(v);
}
