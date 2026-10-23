import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatCents } from "@skyhost/shared";
import { get, post, put } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Button, Card, CodeField, EmptyState, ErrorState, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, timeAgo, useToast } from "../components/ui";
import { t } from "../lib/i18n";

interface ReferralData {
  code: string;
  link: string;
  clicks: number;
  signups: number;
  conversions: number;
  pendingCents: number;
  approvedCents: number;
  paidCents: number;
  availableCents: number;
  minPayoutCents: number;
  payoutMethods: Array<"credit" | "stripe_connect" | "paypal">;
  payoutDetails: { method: string; configured: boolean } | null;
  program: { rewardType: "percent" | "fixed"; percent: number; recurringMonths: number; fixedCents: number; refereeBonusCents: number };
  rewards: Array<{ id: string; amountCents: number; status: string; holdUntil: string | null; createdAt: string; cancelReason: string | null }>;
  payouts: Array<{ id: string; amountCents: number; method: string; status: string; createdAt: string }>;
}

const METHOD_LABEL = { credit: "Team credits", stripe_connect: "Stripe Connect", paypal: "PayPal" } as const;

export default function Referrals() {
  const { t } = useTranslation();
  const { teams, team } = useSession();
  const toast = useToast();
  const q = useQuery({ queryKey: ["referrals"], queryFn: () => get<ReferralData>("/referrals") });
  const [payout, setPayout] = useState(false);
  const [method, setMethod] = useState<"credit" | "stripe_connect" | "paypal">("credit");
  const [teamId, setTeamId] = useState(team?.id ?? "");
  const [details, setDetails] = useState(false);
  const [dMethod, setDMethod] = useState<"paypal" | "stripe_connect">("paypal");
  const [dValue, setDValue] = useState("");

  const request = useMutation({
    mutationFn: () => post("/referrals/payout", { method, teamId: method === "credit" ? teamId : undefined }),
    onSuccess: () => { setPayout(false); void q.refetch(); toast("success", method === "credit" ? "Credits added to the team" : "Payout requested"); },
    onError: (e) => toast("error", (e as Error).message),
  });

  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const reward = d.program.rewardType === "percent" ? t("{{percent}}% of every payment for {{months}} months", { percent: d.program.percent, months: d.program.recurringMonths }) : t("{{amount}} per paying customer", { amount: formatCents(d.program.fixedCents) });
  return (
    <>
      <PageHeader title={t("nav.referrals")} subtitle={`${t("Earn {{reward}}.", { reward })}${d.program.refereeBonusCents ? ` ${t("Your friends get {{amount}} of credits.", { amount: formatCents(d.program.refereeBonusCents) })}` : ""}`} />
      <Card title={t("Your referral link")} className="mb-6">
        <CodeField value={d.link} />
        <p className="mt-2 text-xs text-muted">{t("Rewards are confirmed after the refund window. Self-referrals and duplicate accounts are rejected.")}</p>
      </Card>
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
        {[
          ["Clicks", d.clicks],
          ["Sign-ups", d.signups],
          ["Paying", d.conversions],
          ["Pending", formatCents(d.pendingCents)],
          ["Approved", formatCents(d.approvedCents)],
          ["Paid", formatCents(d.paidCents)],
          ["Available", formatCents(d.availableCents)],
        ].map(([label, v]) => (
          <div key={label as string} className="rounded-lg border border-line bg-panel p-3">
            <div className="text-xs text-muted">{label}</div>
            <div className="mt-1 text-lg font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <Card title={t("Payout")} className="mb-6" actions={<Button size="sm" onClick={() => setDetails(true)}>{t("Payout details")}</Button>}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>{t("Minimum payout:")} {formatCents(d.minPayoutCents)}.</span>
          <span className="text-muted">{d.payoutDetails ? t("External payouts go to your {{method}} account.", { method: t(METHOD_LABEL[d.payoutDetails.method as keyof typeof METHOD_LABEL] ?? d.payoutDetails.method) }) : t("Add payout details to receive money outside SKYHOST.")}</span>
          <Button variant="primary" size="sm" disabled={d.availableCents < d.minPayoutCents} onClick={() => setPayout(true)}>{t("Request payout")}</Button>
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("Rewards")} padded={false}>
          {d.rewards.length === 0 ? <EmptyState title={t("No rewards yet")} description={t("Share your link: rewards appear when a referred team pays.")} /> : (
            <table className="w-full text-sm">
              <tbody>
                {d.rewards.map((r) => (
                  <tr key={r.id} className="border-t border-line first:border-0">
                    <td className="p-3 font-medium">{formatCents(r.amountCents)}</td>
                    <td className="p-3"><StatusBadge status={r.status} /></td>
                    <td className="p-3 text-xs text-muted">{r.status === "pending" && r.holdUntil ? `confirmed ${new Date(r.holdUntil).toLocaleDateString()}` : r.cancelReason ?? ""}</td>
                    <td className="p-3 text-muted">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title={t("Payouts")} padded={false}>
          {d.payouts.length === 0 ? <EmptyState title={t("No payouts yet")} /> : (
            <table className="w-full text-sm">
              <tbody>
                {d.payouts.map((p) => (
                  <tr key={p.id} className="border-t border-line first:border-0">
                    <td className="p-3 font-medium">{formatCents(p.amountCents)}</td>
                    <td className="p-3">{t(METHOD_LABEL[p.method as keyof typeof METHOD_LABEL] ?? p.method)}</td>
                    <td className="p-3"><StatusBadge status={p.status} /></td>
                    <td className="p-3 text-muted">{timeAgo(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Modal open={payout} onClose={() => setPayout(false)} title={t("Pay out {{amount}}", { amount: formatCents(d.availableCents) })} footer={<><Button onClick={() => setPayout(false)}>{t("Cancel")}</Button><Button variant="primary" loading={request.isPending} onClick={() => request.mutate()}>{t("Confirm")}</Button></>}>
        <div className="space-y-3">
          <Field label={t("Method")}>
            <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {d.payoutMethods.map((m) => <option key={m} value={m}>{t(METHOD_LABEL[m])}</option>)}
            </Select>
          </Field>
          {method === "credit" && (
            <Field label={t("Credit this team")}>
              <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}</Select>
            </Field>
          )}
          {method !== "credit" && !d.payoutDetails && <Alert kind="warn">{t("Add your payout details first.")}</Alert>}
          {method !== "credit" && <p className="text-xs text-muted">{t("External payouts are reviewed and sent by the SKYHOST team.")}</p>}
        </div>
      </Modal>
      <Modal open={details} onClose={() => setDetails(false)} title={t("Payout details")} footer={<><Button onClick={() => setDetails(false)}>{t("Cancel")}</Button><Button variant="primary" onClick={() => put("/account/payout", dMethod === "paypal" ? { method: dMethod, email: dValue } : { method: dMethod, accountId: dValue }).then(() => { setDetails(false); void q.refetch(); toast("success", t("Payout details saved")); }).catch((e) => toast("error", e.message))}>{t("Save")}</Button></>}>
        <div className="space-y-3">
          <Field label={t("Method")}>
            <Select value={dMethod} onChange={(e) => setDMethod(e.target.value as typeof dMethod)}>
              <option value="paypal">{t("PayPal")}</option>
              <option value="stripe_connect">{t("Stripe Connect")}</option>
            </Select>
          </Field>
          <Field label={dMethod === "paypal" ? t("PayPal email") : t("Stripe account id")}><Input value={dValue} onChange={(e) => setDValue(e.target.value)} placeholder={dMethod === "paypal" ? "you@example.com" : "acct_..."} /></Field>
        </div>
      </Modal>
    </>
  );
}
