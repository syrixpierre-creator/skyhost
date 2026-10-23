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
}

export interface SignupSettings {
  enabled: boolean;
  maxAccountsPerIpPerDay: number;
}

export interface MaintenanceSettings {
  enabled: boolean;
  message: string;
  blockDeploys: boolean;
  /** ISO date shown to users as the expected end. */
  endsAt: string | null;
}

interface Settings {
  referral: ReferralSettings;
  billing: BillingSettings;
  signup: SignupSettings;
  maintenance: MaintenanceSettings;
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
  return merged;
}
