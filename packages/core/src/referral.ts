import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  creditTransactions, getDb, paymentMethods, payments, referralClicks, referralPayouts, referralRewards, referrals, sessions, teamMembers, teams, users,
} from "@skyhost/db";
import { sha256 } from "@skyhost/shared/node";
import { audit } from "./audit";
import { notify } from "./notify";
import { getSetting } from "./settings";
import { badRequest } from "./errors";

const ipHash = (ip: string | null | undefined) => (ip ? sha256(`skyhost-ref:${ip}`) : null);

export async function findReferrerByCode(code: string) {
  const [u] = await getDb().select({ id: users.id, email: users.email }).from(users).where(eq(users.referralCode, code.toLowerCase()));
  return u ?? null;
}

export async function recordReferralClick(code: string, ip: string | null, userAgent: string | null) {
  const ref = await findReferrerByCode(code);
  if (!ref) return null;
  await getDb().insert(referralClicks).values({ referrerUserId: ref.id, ipHash: ipHash(ip), userAgent: userAgent?.slice(0, 200) ?? null });
  return ref;
}

function normalizeEmail(email: string) {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  const base = local.split("+")[0]!;
  return `${domain === "gmail.com" || domain === "googlemail.com" ? base.replace(/\./g, "") : base}@${domain}`;
}

/**
 * Links a new user to a referrer at signup. Fraud signals (self-referral, same IP or device as the referrer,
 * too many referrals) flag the referral for manual review: flagged referrals never earn automatically.
 */
export async function attachReferral(newUser: { id: string; email: string }, code: string, ip: string | null, deviceId: string | null) {
  const db = getDb();
  const settings = await getSetting("referral");
  if (!settings.enabled) return null;
  const [referrer] = await db.select().from(users).where(eq(users.referralCode, code.toLowerCase()));
  if (!referrer || referrer.id === newUser.id) return null;
  const flags: string[] = [];
  if (normalizeEmail(referrer.email) === normalizeEmail(newUser.email)) flags.push("same_email");
  if (ip) {
    const ips = await db.select({ ip: sessions.ip }).from(sessions).where(eq(sessions.userId, referrer.id)).limit(200);
    if (referrer.signupIp === ip || ips.some((s) => s.ip === ip)) flags.push("same_ip");
  }
  if (deviceId && (referrer.signupDeviceId === deviceId || (await db.select({ c: count() }).from(sessions).where(and(eq(sessions.userId, referrer.id), eq(sessions.deviceId, deviceId))))[0]!.c > 0)) {
    flags.push("same_device");
  }
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [{ c: recent } = { c: 0 }] = await db.select({ c: count() }).from(referrals).where(and(eq(referrals.referrerUserId, referrer.id), gte(referrals.createdAt, monthAgo)));
  if (Number(recent) >= settings.maxRewardsPerReferrerPerMonth) flags.push("referrer_limit");
  const [r] = await db
    .insert(referrals)
    .values({ referrerUserId: referrer.id, referredUserId: newUser.id, status: flags.length ? "flagged" : "signed_up", fraudFlags: flags })
    .onConflictDoNothing()
    .returning();
  await db.update(users).set({ referredByUserId: referrer.id }).where(eq(users.id, newUser.id));
  await audit({ userId: newUser.id, ip }, null, "referral.signup", { type: "referral", id: r?.id ?? "" }, { referrerId: referrer.id, flags });
  return r ?? null;
}

/** Owner of a team (the payer) */
async function teamOwner(teamId: string) {
  const [t] = await getDb().select({ ownerId: teams.ownerId }).from(teams).where(eq(teams.id, teamId));
  return t?.ownerId ?? null;
}

/**
 * Called once per verified, successful payment. Creates a pending reward held until the refund window ends.
 * Percent rewards recur for N months after the first conversion; fixed rewards only apply to the first payment.
 */
export async function onPaymentSucceeded(payment: typeof payments.$inferSelect) {
  const db = getDb();
  const settings = await getSetting("referral");
  if (!settings.enabled) return null;
  const payerId = payment.userId ?? (await teamOwner(payment.teamId));
  if (!payerId) return null;
  const [ref] = await db.select().from(referrals).where(eq(referrals.referredUserId, payerId));
  if (!ref || ref.status === "rejected") return null;

  const firstConversion = !ref.convertedAt;
  if (firstConversion) await db.update(referrals).set({ convertedAt: new Date(), status: ref.status === "flagged" ? "flagged" : "converted" }).where(eq(referrals.id, ref.id));
  else if (ref.convertedAt && Date.now() - ref.convertedAt.getTime() > settings.recurringMonths * 31 * 24 * 3600 * 1000) return null;

  let amount = 0;
  if (settings.rewardType === "fixed") amount = firstConversion ? settings.fixedCents : 0;
  else amount = Math.floor(((payment.amountCents - payment.taxCents) * settings.percent) / 100);
  if (amount <= 0) return null;

  const flags = [...ref.fraudFlags];
  // Same card used by the referrer's own teams: classic self-referral pattern.
  if (payment.paymentMethodFingerprint) {
    const referrerTeams = (await db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, ref.referrerUserId))).map((t) => t.id);
    if (referrerTeams.length) {
      const [{ c } = { c: 0 }] = await db.select({ c: count() }).from(paymentMethods).where(and(inArray(paymentMethods.teamId, referrerTeams), eq(paymentMethods.fingerprint, payment.paymentMethodFingerprint)));
      if (Number(c) > 0) flags.push("same_card");
    }
  }
  if (flags.length && !ref.fraudFlags.includes("same_card") && flags.includes("same_card")) {
    await db.update(referrals).set({ status: "flagged", fraudFlags: flags }).where(eq(referrals.id, ref.id));
  }
  const held = flags.length > 0 && ref.reviewedAt == null;
  const [reward] = await db
    .insert(referralRewards)
    .values({
      referralId: ref.id,
      referrerUserId: ref.referrerUserId,
      paymentId: payment.id,
      amountCents: amount,
      status: held ? "held" : "pending",
      holdUntil: new Date(Date.now() + settings.refundWindowDays * 24 * 3600 * 1000),
    })
    .onConflictDoNothing()
    .returning();

  if (firstConversion && settings.refereeBonusCents > 0 && !held) {
    await db.insert(creditTransactions).values({ teamId: payment.teamId, amountCents: settings.refereeBonusCents, reason: "referral", reference: `referee-bonus:${ref.id}` }).onConflictDoNothing();
    await db.update(teams).set({ creditBalanceCents: sql`${teams.creditBalanceCents} + ${settings.refereeBonusCents}` }).where(eq(teams.id, payment.teamId));
  }
  if (reward) await audit(null, null, "referral.reward_created", { type: "referral_reward", id: reward.id }, { referrerId: ref.referrerUserId, amountCents: amount, status: reward.status });
  return reward ?? null;
}

/** A refund or chargeback cancels the reward. An already credited reward is clawed back. */
export async function onPaymentRefunded(paymentId: string, reason: "refund" | "chargeback") {
  const db = getDb();
  const [reward] = await db.select().from(referralRewards).where(eq(referralRewards.paymentId, paymentId));
  if (!reward || reward.status === "cancelled") return null;
  if (reward.status === "approved") {
    await db.insert(creditTransactions).values({ userId: reward.referrerUserId, amountCents: -reward.amountCents, reason: "referral", reference: `clawback:${reward.id}` }).onConflictDoNothing();
    await db.update(users).set({ personalCreditCents: sql`${users.personalCreditCents} - ${reward.amountCents}` }).where(eq(users.id, reward.referrerUserId));
  }
  await db.update(referralRewards).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason }).where(eq(referralRewards.id, reward.id));
  await audit(null, null, "referral.reward_cancelled", { type: "referral_reward", id: reward.id }, { reason });
  return reward;
}

/** Scheduler task: rewards past the refund window become approved and are credited to the referrer. */
export async function approveDueRewards(now = new Date()) {
  const db = getDb();
  const due = await db.select().from(referralRewards).where(and(eq(referralRewards.status, "pending"), lte(referralRewards.holdUntil, now)));
  let approved = 0;
  for (const r of due) {
    const [p] = await db.select().from(payments).where(eq(payments.id, r.paymentId));
    if (!p || p.status !== "succeeded") {
      await db.update(referralRewards).set({ status: "cancelled", cancelledAt: now, cancelReason: "payment_not_settled" }).where(eq(referralRewards.id, r.id));
      continue;
    }
    const res = await db.update(referralRewards).set({ status: "approved", approvedAt: now }).where(and(eq(referralRewards.id, r.id), eq(referralRewards.status, "pending"))).returning();
    if (!res.length) continue;
    await db.insert(creditTransactions).values({ userId: r.referrerUserId, amountCents: r.amountCents, reason: "referral", reference: `reward:${r.id}` }).onConflictDoNothing();
    await db.update(users).set({ personalCreditCents: sql`${users.personalCreditCents} + ${r.amountCents}` }).where(eq(users.id, r.referrerUserId));
    const [team] = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, r.referrerUserId)).limit(1);
    if (team) await notify({ teamId: team.teamId, userIds: [r.referrerUserId], event: "referral.reward", title: "Referral reward credited", body: `You earned ${(r.amountCents / 100).toFixed(2)} USD from a referral.`, link: "/referrals" });
    await audit(null, null, "referral.reward_approved", { type: "referral_reward", id: r.id }, { amountCents: r.amountCents });
    approved++;
  }
  return approved;
}

export async function referralDashboard(userId: string) {
  const db = getDb();
  const [u] = await db.select({ code: users.referralCode, credit: users.personalCreditCents, payout: users.payoutDetails }).from(users).where(eq(users.id, userId));
  const [{ c: clicks } = { c: 0 }] = await db.select({ c: count() }).from(referralClicks).where(eq(referralClicks.referrerUserId, userId));
  const refs = await db.select().from(referrals).where(eq(referrals.referrerUserId, userId)).orderBy(desc(referrals.createdAt));
  const rewards = await db.select().from(referralRewards).where(eq(referralRewards.referrerUserId, userId)).orderBy(desc(referralRewards.createdAt));
  const payouts = await db.select().from(referralPayouts).where(eq(referralPayouts.userId, userId)).orderBy(desc(referralPayouts.createdAt));
  const sumBy = (s: string[]) => rewards.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.amountCents, 0);
  const settings = await getSetting("referral");
  return {
    code: u?.code,
    clicks: Number(clicks),
    signups: refs.length,
    conversions: refs.filter((r) => r.convertedAt).length,
    pendingCents: sumBy(["pending", "held"]),
    approvedCents: sumBy(["approved"]),
    paidCents: sumBy(["paid"]),
    availableCents: u?.credit ?? 0,
    minPayoutCents: settings.minPayoutCents,
    payoutMethods: settings.payoutMethods,
    payoutDetails: u?.payout ? { method: u.payout.method, configured: true } : null,
    program: { rewardType: settings.rewardType, percent: settings.percent, recurringMonths: settings.recurringMonths, fixedCents: settings.fixedCents, refereeBonusCents: settings.refereeBonusCents },
    rewards: rewards.map((r) => ({ id: r.id, amountCents: r.amountCents, status: r.status, holdUntil: r.holdUntil, createdAt: r.createdAt, cancelReason: r.cancelReason })),
    payouts,
  };
}

/** Moves the available referral balance either to a team's credit balance or to an external payout record. */
export async function requestPayout(userId: string, method: "credit" | "stripe_connect" | "paypal", teamId?: string) {
  const db = getDb();
  const settings = await getSetting("referral");
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw badRequest("Unknown user");
  if (!settings.payoutMethods.includes(method)) throw badRequest("This payout method is not available");
  const amount = u.personalCreditCents;
  if (amount < settings.minPayoutCents) throw badRequest(`The minimum payout is ${(settings.minPayoutCents / 100).toFixed(2)} USD`);
  if (method !== "credit" && !u.payoutDetails?.method) throw badRequest("Add your payout details first");
  if (method === "credit") {
    if (!teamId) throw badRequest("Choose a team to credit");
    const [m] = await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    if (!m) throw badRequest("You are not a member of this team");
  }
  const updated = await db.update(users).set({ personalCreditCents: sql`${users.personalCreditCents} - ${amount}` }).where(and(eq(users.id, userId), gte(users.personalCreditCents, amount))).returning();
  if (!updated.length) throw badRequest("Balance changed, try again");
  const [payout] = await db.insert(referralPayouts).values({ userId, amountCents: amount, method, status: method === "credit" ? "paid" : "pending", teamId: teamId ?? null, paidAt: method === "credit" ? new Date() : null }).returning();
  if (method === "credit") {
    await db.insert(creditTransactions).values({ teamId: teamId!, amountCents: amount, reason: "referral", reference: `payout:${payout!.id}` });
    await db.update(teams).set({ creditBalanceCents: sql`${teams.creditBalanceCents} + ${amount}` }).where(eq(teams.id, teamId!));
  }
  await db.update(referralRewards).set({ status: "paid", payoutId: payout!.id }).where(and(eq(referralRewards.referrerUserId, userId), eq(referralRewards.status, "approved")));
  await audit({ userId }, teamId ?? null, "referral.payout_requested", { type: "referral_payout", id: payout!.id }, { method, amountCents: amount });
  return payout!;
}
