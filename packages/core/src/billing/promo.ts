import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { discountRedemptions, discounts, getDb, teams } from "@skyhost/db";
import { audit } from "../audit";
import { badRequest, conflict, notFound } from "../errors";
import { addCredits } from "./service";

export type PendingDiscount = { redemptionId: string; code: string; percentOff: number };

const normalize = (code: string) => code.trim().toUpperCase();

/**
 * Redeems a promo code for a team. Fixed-amount codes become prepaid credits immediately; percentage codes wait
 * for the team's next plan payment (one at a time). Each team can use a code once; limits are enforced atomically.
 */
export async function redeemPromoCode(teamId: string, userId: string, rawCode: string) {
  const code = normalize(rawCode);
  if (!/^[A-Z0-9-]{3,32}$/.test(code)) throw badRequest("This promo code is not valid");
  const db = getDb();
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(discounts).where(eq(discounts.code, code));
    if (!d) throw notFound("Promo code");
    if (d.expiresAt && d.expiresAt < new Date()) throw badRequest("This promo code has expired");
    const [already] = await tx.select().from(discountRedemptions).where(and(eq(discountRedemptions.discountId, d.id), eq(discountRedemptions.teamId, teamId)));
    if (already) throw conflict("This team already used this promo code");
    const [team] = await tx.select().from(teams).where(eq(teams.id, teamId));
    if (d.percentOff && team?.pendingDiscountId) throw conflict("A promo code is already waiting for your next payment");
    // Atomic use count: concurrent redemptions cannot exceed maxRedemptions.
    const used = await tx
      .update(discounts)
      .set({ redemptions: sql`${discounts.redemptions} + 1` })
      .where(and(eq(discounts.id, d.id), or(isNull(discounts.maxRedemptions), lt(discounts.redemptions, sql`${discounts.maxRedemptions}`)), or(isNull(discounts.expiresAt), gt(discounts.expiresAt, new Date()))))
      .returning();
    if (!used.length) throw badRequest("This promo code has reached its usage limit");
    const status = d.amountOffCents ? "credits" : "pending";
    const [r] = await tx.insert(discountRedemptions).values({ discountId: d.id, teamId, userId, status, amountCents: d.amountOffCents ?? 0 }).returning();
    if (d.percentOff) await tx.update(teams).set({ pendingDiscountId: r!.id }).where(eq(teams.id, teamId));
    return { redemption: r!, discount: d };
  }).then(async ({ redemption, discount }) => {
    if (discount.amountOffCents) await addCredits(teamId, discount.amountOffCents, "promo", `promo:${redemption.id}`);
    await audit({ userId }, teamId, "billing.promo_redeemed", { type: "discount", id: discount.id }, { code: discount.code });
    return discount.amountOffCents
      ? { kind: "credits" as const, amountCents: discount.amountOffCents, code: discount.code }
      : { kind: "percent" as const, percentOff: discount.percentOff!, code: discount.code };
  });
}

/** The percentage code waiting for the team's next plan payment, if any. */
export async function pendingDiscount(teamId: string): Promise<PendingDiscount | null> {
  const db = getDb();
  const [row] = await db
    .select({ r: discountRedemptions, d: discounts })
    .from(teams)
    .innerJoin(discountRedemptions, eq(discountRedemptions.id, teams.pendingDiscountId))
    .innerJoin(discounts, eq(discounts.id, discountRedemptions.discountId))
    .where(eq(teams.id, teamId));
  if (!row || row.r.status !== "pending" || !row.d.percentOff) return null;
  return { redemptionId: row.r.id, code: row.d.code, percentOff: row.d.percentOff };
}

export function discountedCents(priceCents: number, d: PendingDiscount | null) {
  return d ? Math.max(0, Math.round((priceCents * (100 - d.percentOff)) / 100)) : priceCents;
}

/** Marks the pending code as used by a payment. Safe to call twice (only a pending redemption is consumed). */
export async function consumePendingDiscount(teamId: string, redemptionId: string) {
  const db = getDb();
  const done = await db
    .update(discountRedemptions)
    .set({ status: "applied", appliedAt: new Date() })
    .where(and(eq(discountRedemptions.id, redemptionId), eq(discountRedemptions.teamId, teamId), eq(discountRedemptions.status, "pending")))
    .returning();
  if (done.length) await db.update(teams).set({ pendingDiscountId: null }).where(and(eq(teams.id, teamId), eq(teams.pendingDiscountId, redemptionId)));
  return done.length > 0;
}

export async function listRedemptions(teamId: string) {
  return getDb()
    .select({ id: discountRedemptions.id, code: discounts.code, status: discountRedemptions.status, amountCents: discountRedemptions.amountCents, percentOff: discounts.percentOff, createdAt: discountRedemptions.createdAt, appliedAt: discountRedemptions.appliedAt })
    .from(discountRedemptions)
    .innerJoin(discounts, eq(discounts.id, discountRedemptions.discountId))
    .where(eq(discountRedemptions.teamId, teamId))
    .orderBy(sql`${discountRedemptions.createdAt} desc`);
}
