import { and, count, eq, inArray } from "drizzle-orm";
import { getDb, paymentMethods, payments, referralRewards, referrals, teamMembers } from "@skyhost/db";

/**
 * Card fingerprints can arrive after the payment event. When they do, re-check the referral reward:
 * the same card used by the referrer's own teams puts the reward on hold for manual review.
 */
export async function recheckRewardCard(provider: string, providerPaymentId: string, fingerprint: string | null | undefined) {
  if (!fingerprint) return;
  const db = getDb();
  const [p] = await db.select().from(payments).where(and(eq(payments.provider, provider), eq(payments.providerPaymentId, providerPaymentId)));
  if (!p) return;
  const [reward] = await db.select().from(referralRewards).where(eq(referralRewards.paymentId, p.id));
  if (!reward || reward.status !== "pending") return;
  const referrerTeams = (await db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, reward.referrerUserId))).map((t) => t.id);
  if (!referrerTeams.length) return;
  const [{ c } = { c: 0 }] = await db.select({ c: count() }).from(paymentMethods).where(and(inArray(paymentMethods.teamId, referrerTeams), eq(paymentMethods.fingerprint, fingerprint)));
  if (Number(c) === 0) return;
  await db.update(referralRewards).set({ status: "held" }).where(eq(referralRewards.id, reward.id));
  const [ref] = await db.select().from(referrals).where(eq(referrals.id, reward.referralId));
  if (ref && !ref.fraudFlags.includes("same_card")) await db.update(referrals).set({ status: "flagged", fraudFlags: [...ref.fraudFlags, "same_card"] }).where(eq(referrals.id, ref.id));
}
