import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS, getDb, systemSettings } from "@skyhost/db";

export interface ReferralSettings {
  enabled: boolean;
  rewardType: "percent" | "fixed";
  percent: number;
  recurringMonths: number;
  fixedCents: number;
  refereeBonusCents: number;
  refundWindowDays: number;
  minPayoutCents: number;
  maxRewardsPerReferrerPerMonth: number;
  payoutMethods: string[];
}

export interface BillingSettings {
  graceDays: number;
  dunningDays: number[];
  defaultTaxPercent: number;
  trialPlan: string;
  /** Pay as you go (Railway-style): resource usage beyond the plan price is billed monthly. */
  usage: { enabled: boolean; planIncludesUsage: boolean; /** Set when first enabled: earlier months are never billed. */ startedAt?: string | null; rates: { cpuHourCents: number; memoryGbHourCents: number; egressGbCents: number; buildMinuteCents: number } };
}

export interface SignupSettings {
  enabled: boolean;
  maxAccountsPerIpPerDay: number;
}

export interface MaintenanceSettings {
  enabled: boolean;
  message: string;
  blockDeploys: boolean;
  /** Only administrators can sign in and use the dashboard; everyone else sees the maintenance page. */
  closeDashboard: boolean;
  /** ISO date shown to users as the expected end. */
  endsAt: string | null;
}

interface Settings {
  referral: ReferralSettings;
  billing: BillingSettings;
  signup: SignupSettings;
  maintenance: MaintenanceSettings;
}

/**
 * The maintenance settings when the dashboard is closed to non-administrators, else null. Read on every API request,
 * so cached for a few seconds (and refreshed at once by setSetting on this instance).
 */
let closedCache: { at: number; value: MaintenanceSettings | null } | null = null;
export async function dashboardClosed(): Promise<MaintenanceSettings | null> {
  if (closedCache && Date.now() - closedCache.at < 5_000) return closedCache.value;
  const m = await getSetting("maintenance");
  closedCache = { at: Date.now(), value: m.enabled && m.closeDashboard ? m : null };
  return closedCache.value;
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const [row] = await getDb().select().from(systemSettings).where(eq(systemSettings.key, key));
  return { ...(DEFAULT_SETTINGS[key] as object), ...((row?.value as object) ?? {}) } as Settings[K];
}

export async function setSetting<K extends keyof Settings>(key: K, value: Partial<Settings[K]>) {
  const merged = { ...(await getSetting(key)), ...value };
  await getDb()
    .insert(systemSettings)
    .values({ key, value: merged })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: merged, updatedAt: new Date() } });
  if (key === "maintenance") closedCache = null;
  return merged;
}
