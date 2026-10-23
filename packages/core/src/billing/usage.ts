import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { creditTransactions, deployments, getDb, invoices, projects, services, teams, usageRecords } from "@skyhost/db";
import { audit } from "../audit";
import { notify } from "../notify";
import { getSetting } from "../settings";
import { getTeamPlan } from "../quotas";
import { addCredits, nextInvoiceNumber, paymentFailed } from "./service";

export interface UsageRates {
  /** Cents per unit; fractions allowed (e.g. 2.8 cents per vCPU-hour). */
  cpuHourCents: number;
  memoryGbHourCents: number;
  egressGbCents: number;
  buildMinuteCents: number;
}

export interface UsageLine {
  metric: "cpu" | "memory" | "egress" | "build";
  label: string;
  unit: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

export interface UsageCharge {
  enabled: boolean;
  lines: UsageLine[];
  usageCents: number;
  /** Part of the usage covered by the plan price (Railway-style: the plan fee is also a usage allowance). */
  includedCents: number;
  billableCents: number;
}

export function periodOf(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

/** What a team's resource usage costs over a period with the admin-defined rates. */
export async function usageCharge(teamId: string, start: Date, end: Date): Promise<UsageCharge> {
  const settings = await getSetting("billing");
  const usage = settings.usage;
  const db = getDb();
  const rows = await db
    .select({ metric: usageRecords.metric, q: sql<number>`coalesce(sum(${usageRecords.quantity}), 0)::float` })
    .from(usageRecords)
    .where(and(eq(usageRecords.teamId, teamId), gte(usageRecords.periodStart, start), lt(usageRecords.periodStart, end)))
    .groupBy(usageRecords.metric);
  const q = (m: string) => Number(rows.find((r) => r.metric === m)?.q ?? 0);
  const svcIds = (await db.select({ id: services.id }).from(services).innerJoin(projects, eq(projects.id, services.projectId)).where(eq(projects.teamId, teamId))).map((s) => s.id);
  const [b] = svcIds.length
    ? await db.select({ s: sql<number>`coalesce(sum(${deployments.buildSeconds}), 0)::float` }).from(deployments).where(and(inArray(deployments.serviceId, svcIds), gte(deployments.createdAt, start), lt(deployments.createdAt, end)))
    : [{ s: 0 }];
  const r = usage.rates;
  const line = (metric: UsageLine["metric"], label: string, unit: string, quantity: number, unitCents: number): UsageLine => ({ metric, label, unit, quantity: Math.round(quantity * 1000) / 1000, unitCents, amountCents: Math.round(quantity * unitCents) });
  const lines = [
    line("cpu", "CPU", "vCPU-hour", q("cpu_seconds") / 3600, r.cpuHourCents),
    line("memory", "Memory", "GB-hour", q("memory_mb_seconds") / 1024 / 3600, r.memoryGbHourCents),
    line("egress", "Outbound traffic", "GB", q("bandwidth_bytes") / 1024 ** 3, r.egressGbCents),
    line("build", "Build time", "minute", Number(b?.s ?? 0) / 60, r.buildMinuteCents),
  ];
  const usageCents = lines.reduce((a, l) => a + l.amountCents, 0);
  const plan = await getTeamPlan(teamId);
  const includedCents = usage.planIncludesUsage ? Math.min(usageCents, plan.priceCents) : 0;
  return { enabled: usage.enabled, lines, usageCents, includedCents, billableCents: usage.enabled ? usageCents - includedCents : 0 };
}

/**
 * Bills last month's usage beyond the plan allowance, once per team and month: paid from prepaid credits when they
 * cover it, else an open invoice and the usual payment-failed flow (grace period, reminders, then suspension).
 */
export async function closeUsagePeriod(now = new Date()) {
  const settings = await getSetting("billing");
  if (!settings.usage.enabled) return 0;
  const { start, end, key } = periodOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
  // Only months that started after pay-as-you-go was switched on (no retroactive bill).
  if (!settings.usage.startedAt || new Date(settings.usage.startedAt) > start) return 0;
  const db = getDb();
  let billed = 0;
  for (const team of await db.select().from(teams)) {
    const ref = `usage:${key}`;
    const [already] = await db.select({ id: creditTransactions.id }).from(creditTransactions).where(and(eq(creditTransactions.teamId, team.id), eq(creditTransactions.reference, ref)));
    const [openInvoice] = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.teamId, team.id), eq(invoices.provider, "usage"), eq(invoices.providerInvoiceId, ref)));
    if (already || openInvoice) continue;
    const charge = await usageCharge(team.id, start, end);
    if (charge.billableCents <= 0) continue;
    const lines = [...charge.lines.filter((l) => l.amountCents > 0).map((l) => ({ description: `${l.label}: ${l.quantity} ${l.unit} × ${l.unitCents}¢`, amountCents: l.amountCents, quantity: 1 })), ...(charge.includedCents ? [{ description: "Included in the plan", amountCents: -charge.includedCents, quantity: 1 }] : [])];
    const paid = team.creditBalanceCents >= charge.billableCents;
    await db.insert(invoices).values({
      teamId: team.id,
      number: await nextInvoiceNumber(),
      provider: "usage",
      providerInvoiceId: ref,
      status: paid ? "paid" : "open",
      subtotalCents: charge.billableCents,
      totalCents: charge.billableCents,
      currency: "usd",
      lines,
      periodStart: start,
      periodEnd: end,
      paidAt: paid ? new Date() : null,
    });
    if (paid) {
      await addCredits(team.id, -charge.billableCents, "usage", ref);
      await notify({ teamId: team.id, event: "billing.payment_succeeded", title: `Usage of ${key} paid with credits`, body: `${(charge.billableCents / 100).toFixed(2)} USD of usage beyond your plan was paid from your prepaid credits.`, link: "/billing?tab=invoices" });
    } else {
      await paymentFailed("usage" as never, null, team.id, `usage of ${key}: ${(charge.billableCents / 100).toFixed(2)} USD and not enough prepaid credits`);
    }
    await audit(null, team.id, "billing.usage_billed", { type: "team", id: team.id }, { period: key, cents: charge.billableCents, paid });
    billed++;
  }
  return billed;
}
