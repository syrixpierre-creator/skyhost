import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PlanFeatures, PlanLimits } from "@skyhost/shared";
import { REGIONS } from "@skyhost/shared";
import { plans, regions, systemSettings, taxRates } from "./schema";

type Db = PostgresJsDatabase<Record<string, unknown>>;

const features = (f: Partial<PlanFeatures>): PlanFeatures => ({
  sleepWhenIdle: true,
  autoSleepForced: false,
  previews: false,
  canary: false,
  sso: false,
  waf: false,
  publicDatabaseAccess: false,
  prioritySupport: false,
  accessProtection: false,
  uptimeMonitoring: false,
  objectStorage: false,
  ...f,
});

export const DEFAULT_PLANS: Array<{
  slug: string;
  name: string;
  priceCents: number;
  limits: PlanLimits;
  features: PlanFeatures;
  overage: Record<string, number>;
  isContactSales?: boolean;
  isFree?: boolean;
  isPublic?: boolean;
  sort: number;
}> = [
  {
    slug: "free",
    name: "Free trial",
    priceCents: 0,
    isFree: true,
    isPublic: true,
    sort: 0,
    limits: {
      cpu: 1, memoryMb: 1024, storageMb: 2048, bandwidthGb: 10, buildMinutes: 100, services: 2, databases: 1, members: 1,
      deploysPerDay: 20, logRetentionDays: 1, backupRetentionDays: 1, customDomains: 0, screenshotsPerMonth: 20,
      previewEnvironments: 0, projects: 1, volumesMb: 512, buckets: 0, bucketStorageMb: 0, cronJobs: 1,
    },
    features: features({ autoSleepForced: true }),
    overage: {},
  },
  {
    slug: "starter",
    name: "Starter",
    priceCents: 500,
    sort: 1,
    limits: {
      cpu: 3, memoryMb: 3072, storageMb: 10240, bandwidthGb: 100, buildMinutes: 500, services: 5, databases: 2, members: 3,
      deploysPerDay: 100, logRetentionDays: 7, backupRetentionDays: 7, customDomains: 3, screenshotsPerMonth: 200,
      previewEnvironments: 2, projects: 5, volumesMb: 5120, buckets: 1, bucketStorageMb: 5120, cronJobs: 5,
    },
    features: features({ previews: true, accessProtection: true, uptimeMonitoring: true, objectStorage: true }),
    overage: { bandwidthGb: 10, buildMinutes: 1 },
  },
  {
    slug: "pro",
    name: "Pro",
    priceCents: 1500,
    sort: 2,
    limits: {
      cpu: 8, memoryMb: 16384, storageMb: 51200, bandwidthGb: 500, buildMinutes: 2000, services: 20, databases: 5, members: 10,
      deploysPerDay: 500, logRetentionDays: 14, backupRetentionDays: 14, customDomains: 20, screenshotsPerMonth: 1000,
      previewEnvironments: 10, projects: 20, volumesMb: 20480, buckets: 5, bucketStorageMb: 51200, cronJobs: 20,
    },
    features: features({ previews: true, canary: true, waf: true, publicDatabaseAccess: true, accessProtection: true, uptimeMonitoring: true, objectStorage: true }),
    overage: { bandwidthGb: 8, buildMinutes: 1 },
  },
  {
    slug: "business",
    name: "Business",
    priceCents: 3000,
    sort: 3,
    limits: {
      cpu: 32, memoryMb: 65536, storageMb: 204800, bandwidthGb: 2000, buildMinutes: 6000, services: 100, databases: 20, members: 50,
      deploysPerDay: 2000, logRetentionDays: 30, backupRetentionDays: 30, customDomains: 100, screenshotsPerMonth: 5000,
      previewEnvironments: 50, projects: 100, volumesMb: 102400, buckets: 20, bucketStorageMb: 204800, cronJobs: 100,
    },
    features: features({
      previews: true, canary: true, waf: true, publicDatabaseAccess: true, prioritySupport: true, accessProtection: true,
      uptimeMonitoring: true, objectStorage: true,
    }),
    overage: { bandwidthGb: 5, buildMinutes: 1 },
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    priceCents: 0,
    isContactSales: true,
    sort: 4,
    limits: {
      cpu: 64, memoryMb: 262144, storageMb: 1048576, bandwidthGb: 20000, buildMinutes: 100000, services: 1000, databases: 200, members: 1000,
      deploysPerDay: 20000, logRetentionDays: 90, backupRetentionDays: 90, customDomains: 1000, screenshotsPerMonth: 50000,
      previewEnvironments: 500, projects: 1000, volumesMb: 1048576, buckets: 200, bucketStorageMb: 1048576, cronJobs: 1000,
    },
    features: features({
      previews: true, canary: true, sso: true, waf: true, publicDatabaseAccess: true, prioritySupport: true, accessProtection: true,
      uptimeMonitoring: true, objectStorage: true,
    }),
    overage: {},
  },
];

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  referral: {
    enabled: true,
    rewardType: "percent", // percent | fixed
    percent: 20,
    recurringMonths: 6,
    fixedCents: 500,
    refereeBonusCents: 500,
    refundWindowDays: 14,
    minPayoutCents: 2000,
    maxRewardsPerReferrerPerMonth: 50,
    payoutMethods: ["credit", "stripe_connect", "paypal"],
  },
  billing: {
    graceDays: 7,
    dunningDays: [1, 3, 5],
    defaultTaxPercent: 0,
    trialPlan: "free",
  },
  signup: {
    enabled: true,
    maxAccountsPerIpPerDay: 3,
  },
};

/** Idempotent: inserts defaults, never overwrites admin-edited values. */
export async function seed(db: Db) {
  for (const r of REGIONS) {
    await db.insert(regions).values({ id: r.id, name: r.name, isDefault: r.default }).onConflictDoNothing();
  }
  for (const p of DEFAULT_PLANS) {
    await db
      .insert(plans)
      .values({
        slug: p.slug,
        name: p.name,
        priceCents: p.priceCents,
        limits: p.limits,
        features: p.features,
        overage: p.overage,
        isContactSales: p.isContactSales ?? false,
        isFree: p.isFree ?? false,
        isPublic: p.isPublic ?? true,
        sort: p.sort,
      })
      .onConflictDoNothing();
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.insert(systemSettings).values({ key, value }).onConflictDoNothing();
  }
  await db.insert(taxRates).values({ country: "FR", name: "TVA", percent: 20 }).onConflictDoNothing();
  await db.execute(sql`select 1`);
}
