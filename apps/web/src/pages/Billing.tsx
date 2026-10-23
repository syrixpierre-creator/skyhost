import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatCents } from "@skyhost/shared";
import { download, get, post, put } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, LoadingRows, Meter, Modal, PageHeader, Select, StatusBadge, timeAgo, useToast } from "../components/ui";

interface Plan {
  id: string;
  slug: string;
  name: string;
  priceCents: number;
  currency: string;
  interval: string;
  limits: Record<string, number>;
  features: Record<string, boolean>;
  isContactSales: boolean;
  isFree: boolean;
  trialDays: number;
  providers: { stripe: boolean; paypal: boolean };
}

interface Overview {
  status: string;
  creditBalanceCents: number;
  graceEndsAt: string | null;
  spendCapCents: number | null;
  spendCapAction: string | null;
  subscription: { id: string; provider: string; status: string; planId: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  invoices: Array<{ id: string; number: string; status: string; totalCents: number; currency: string; createdAt: string; hostedUrl: string | null }>;
  paymentMethods: Array<{ id: string; provider: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean }>;
  credits: Array<{ id: string; amountCents: number; reason: string; reference: string | null; createdAt: string }>;
  usage: { plan: { id: string; slug: string; name: string }; items: Array<{ key: string; label: string; current: number; limit: number }> };
}

const SALES_EMAIL = import.meta.env.VITE_SALES_EMAIL as string | undefined;
const HIGHLIGHT_LIMITS = ["projects", "services", "databases", "cpu", "memoryMb", "storageGb", "deploysPerDay", "teamMembers"];

function limitText(k: string, v: number) {
  if (v >= 1_000_000) return "Unlimited";
  if (k === "memoryMb") return v >= 1024 ? `${v / 1024} GB RAM` : `${v} MB RAM`;
  if (k === "cpu") return `${v} vCPU`;
  if (k === "storageGb") return `${v} GB storage`;
  return `${v}`;
}

export default function Billing() {
  const { t } = useTranslation();
  const { team, refresh } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canManage = ["owner", "admin"].includes(team!.role);
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<{ plans: Plan[]; providers: { stripe: boolean; paypal: boolean; mobileMoney: boolean }; paymentsEnabled: boolean }>("/plans") });
  const ov = useQuery({ queryKey: ["billing", team!.id], queryFn: () => get<Overview>(`/teams/${team!.id}/billing`) });
  const [checkout, setCheckout] = useState<Plan | null>(null);
  const [credits, setCredits] = useState(false);
  const [amount, setAmount] = useState("20");
  const [creditProvider, setCreditProvider] = useState<"stripe" | "paypal" | "mobile_money">("stripe");
  const [cap, setCap] = useState<string>("");
  const [capAction, setCapAction] = useState("alert");

  // Return from a provider. Activation itself happens through verified webhooks.
  useEffect(() => {
    const token = params.get("token");
    if (params.get("paypal") === "return" && token) {
      void post(`/teams/${team!.id}/billing/paypal/capture`, { orderId: token })
        .then(() => toast("success", "Payment received. Credits added."))
        .catch((e) => toast("error", e.message))
        .finally(() => { setParams({}); void qc.invalidateQueries({ queryKey: ["billing"] }); refresh(); });
    } else if (params.get("checkout") === "success" || params.get("credits") === "success") {
      toast("success", "Payment submitted. Your account updates as soon as the provider confirms it.");
      setParams({});
    } else if (params.get("credits") === "pending") {
      toast("info", "Mobile Money payment pending: credits are added once the operator confirms it.");
      setParams({});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ov.data) {
      setCap(ov.data.spendCapCents === null ? "" : String(ov.data.spendCapCents / 100));
      setCapAction(ov.data.spendCapAction ?? "alert");
    }
  }, [ov.data]);

  const redirect = (r: { url?: string; switched?: boolean; ok?: boolean; message?: string }) => {
    if (r.url) window.location.href = r.url;
    else {
      toast("success", r.message ?? "Plan updated");
      setCheckout(null);
      void qc.invalidateQueries({ queryKey: ["billing"] });
      refresh();
    }
  };
  const subscribe = useMutation({
    mutationFn: ({ plan, provider }: { plan: Plan; provider: "stripe" | "paypal" | "credits" }) => {
      if (provider === "credits") return post(`/teams/${team!.id}/billing/pay-with-credits`, { planId: plan.id });
      if (ov.data?.subscription?.status === "active" && ov.data.subscription.provider === "stripe" && !plan.isFree) return post(`/teams/${team!.id}/billing/change-plan`, { planId: plan.id });
      return post(`/teams/${team!.id}/billing/checkout`, { planId: plan.id, provider });
    },
    onSuccess: redirect,
    onError: (e) => toast("error", (e as Error).message),
  });
  const buyCredits = useMutation({
    mutationFn: () => post<{ url: string }>(`/teams/${team!.id}/billing/credits`, { amountCents: Math.round(Number(amount) * 100), provider: creditProvider }),
    onSuccess: redirect,
    onError: (e) => toast("error", (e as Error).message),
  });

  if (plans.isLoading || ov.isLoading) return <LoadingRows rows={6} />;
  if (ov.error) return <ErrorState error={ov.error} onRetry={() => ov.refetch()} />;
  const o = ov.data!;
  const p = plans.data!;
  const currentPlanId = o.usage.plan.id;
  const sub = o.subscription;

  return (
    <>
      <PageHeader title={t("nav.billing")} subtitle={`${team!.name} · ${o.usage.plan.name} plan`} actions={canManage && sub?.provider === "stripe" && <Button onClick={() => post<{ url: string }>(`/teams/${team!.id}/billing/portal`).then(redirect).catch((e) => toast("error", e.message))}>Manage cards</Button>} />
      {!p.paymentsEnabled && <div className="mb-4"><Alert kind="info">Online payments are not enabled on this SKYHOST instance. Your administrator can assign plans.</Alert></div>}
      {o.status === "past_due" && <div className="mb-4"><Alert kind="error">Your last payment failed. Update your payment method{o.graceEndsAt ? ` before ${new Date(o.graceEndsAt).toLocaleDateString()}` : ""} to avoid service interruption.</Alert></div>}
      {sub?.cancelAtPeriodEnd && <div className="mb-4"><Alert kind="warn">Your subscription ends on {sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : "the end of the period"}. You will move to the free plan.</Alert></div>}

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card title="Current plan">
          <div className="text-2xl font-semibold">{o.usage.plan.name}</div>
          <div className="mt-1 text-sm text-muted">{sub ? <>via {sub.provider} · <StatusBadge status={sub.status} />{sub.currentPeriodEnd && ` · renews ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`}</> : "No subscription"}</div>
          {canManage && sub?.status === "active" && !sub.cancelAtPeriodEnd && <Button size="sm" className="mt-3" onClick={() => post(`/teams/${team!.id}/billing/cancel`).then(() => { toast("success", "Subscription will end at the end of the period"); void ov.refetch(); }).catch((e) => toast("error", e.message))}>Cancel subscription</Button>}
        </Card>
        <Card title="Prepaid credits">
          <div className="text-2xl font-semibold">{formatCents(o.creditBalanceCents)}</div>
          <div className="mt-1 text-sm text-muted">Use credits to pay for a plan without a card.</div>
          {canManage && p.paymentsEnabled && <Button size="sm" className="mt-3" onClick={() => setCredits(true)}>Add credits</Button>}
        </Card>
        <Card title="Spend cap">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void put(`/teams/${team!.id}/spend-cap`, { spendCapCents: cap === "" ? null : Math.round(Number(cap) * 100), action: capAction }).then(() => toast("success", "Spend cap saved")).catch((er) => toast("error", er.message)); }}>
            <div className="flex gap-2">
              <Input type="number" min={0} step="1" placeholder="No cap" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Monthly cap in USD" disabled={!canManage} />
              <Select value={capAction} onChange={(e) => setCapAction(e.target.value)} disabled={!canManage} aria-label="When reached">
                <option value="alert">Alert only</option>
                <option value="block_deploys">Block deploys</option>
                <option value="pause_services">Pause services</option>
              </Select>
            </div>
            {canManage && <Button size="sm">Save</Button>}
          </form>
        </Card>
      </div>

      <Card title="Usage this period" className="mb-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {o.usage.items.map((i) => <Meter key={i.key} value={i.current} max={i.limit} label={i.label} />)}
        </div>
      </Card>

      <h2 className="mb-3 text-lg font-semibold">Plans</h2>
      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {p.plans.map((plan) => {
          const current = plan.id === currentPlanId;
          return (
            <div key={plan.id} className={cx("flex flex-col rounded-lg border bg-panel p-4", current ? "border-accent" : "border-line")}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{plan.name}</h3>
                {current && <Badge className="text-accent">Current</Badge>}
              </div>
              <div className="my-3 text-2xl font-semibold">{plan.isContactSales ? "Custom" : plan.isFree ? "Free" : <>{formatCents(plan.priceCents, plan.currency.toUpperCase())}<span className="text-sm font-normal text-muted">/{plan.interval}</span></>}</div>
              <ul className="mb-4 flex-1 space-y-1 text-sm text-muted">
                {HIGHLIGHT_LIMITS.filter((k) => k in plan.limits).map((k) => <li key={k}>{limitText(k, plan.limits[k]!)} {["cpu", "memoryMb", "storageGb"].includes(k) ? "" : k.replace(/([A-Z])/g, " $1").toLowerCase()}</li>)}
                {Object.entries(plan.features).filter(([, v]) => v).slice(0, 5).map(([k]) => <li key={k}>✓ {k.replace(/([A-Z])/g, " $1").toLowerCase()}</li>)}
              </ul>
              {plan.isContactSales ? (
                SALES_EMAIL ? <a href={`mailto:${SALES_EMAIL}`} className="text-center text-sm text-accent">Contact sales</a> : <span className="text-center text-sm text-muted">Contact the platform administrator</span>
              ) : (
                <Button variant={current ? "secondary" : "primary"} disabled={current || !canManage || (!plan.isFree && !p.paymentsEnabled)} onClick={() => (plan.isFree ? subscribe.mutate({ plan, provider: "stripe" }) : setCheckout(plan))}>
                  {current ? "Current plan" : plan.isFree ? "Switch to free" : plan.trialDays && !sub ? `Start ${plan.trialDays}-day trial` : "Choose"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Invoices" padded={false}>
          {o.invoices.length === 0 ? <EmptyState title="No invoices yet" /> : (
            <table className="w-full text-sm">
              <tbody>
                {o.invoices.map((i) => (
                  <tr key={i.id} className="border-t border-line first:border-0">
                    <td className="p-3 font-mono text-xs">{i.number}</td>
                    <td className="p-3">{formatCents(i.totalCents, i.currency.toUpperCase())}</td>
                    <td className="p-3"><StatusBadge status={i.status} /></td>
                    <td className="p-3 text-muted">{new Date(i.createdAt).toLocaleDateString()}</td>
                    <td className="p-3 text-right"><Button size="sm" onClick={() => download(`/invoices/${i.id}/pdf`)}>PDF</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Credit history" padded={false}>
          {o.credits.length === 0 ? <EmptyState title="No credit movements" /> : (
            <table className="w-full text-sm">
              <tbody>
                {o.credits.map((c) => (
                  <tr key={c.id} className="border-t border-line first:border-0">
                    <td className={cx("p-3 font-medium", c.amountCents >= 0 ? "text-green-500" : "text-fg")}>{c.amountCents >= 0 ? "+" : ""}{formatCents(c.amountCents)}</td>
                    <td className="p-3">{c.reason}</td>
                    <td className="p-3 text-muted">{timeAgo(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Modal open={!!checkout} onClose={() => setCheckout(null)} title={`Subscribe to ${checkout?.name}`}>
        {checkout && (
          <div className="space-y-3 text-sm">
            <p>{formatCents(checkout.priceCents, checkout.currency.toUpperCase())} per {checkout.interval}. Taxes are calculated from your billing country. You can cancel at any time.</p>
            <div className="grid gap-2">
              <Button variant="primary" disabled={!checkout.providers.stripe || !p.providers.stripe} loading={subscribe.isPending} onClick={() => subscribe.mutate({ plan: checkout, provider: "stripe" })}>Pay by card (Stripe)</Button>
              <Button disabled={!checkout.providers.paypal || !p.providers.paypal} onClick={() => subscribe.mutate({ plan: checkout, provider: "paypal" })}>Pay with PayPal</Button>
              <Button disabled={o.creditBalanceCents < checkout.priceCents} onClick={() => subscribe.mutate({ plan: checkout, provider: "credits" })}>Pay one month with credits ({formatCents(o.creditBalanceCents)} available)</Button>
            </div>
            {!p.providers.stripe && !p.providers.paypal && <Alert kind="warn">No payment provider is configured on this instance yet.</Alert>}
          </div>
        )}
      </Modal>
      <Modal open={credits} onClose={() => setCredits(false)} title="Add prepaid credits" footer={<><Button onClick={() => setCredits(false)}>Cancel</Button><Button variant="primary" loading={buyCredits.isPending} disabled={Number(amount) < 5} onClick={() => buyCredits.mutate()}>Continue to payment</Button></>}>
        <div className="space-y-3">
          <Field label="Amount (USD)" hint="Minimum 5 USD"><Input type="number" min={5} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Payment method">
            <Select value={creditProvider} onChange={(e) => setCreditProvider(e.target.value as typeof creditProvider)}>
              <option value="stripe" disabled={!p.providers.stripe}>Card (Stripe)</option>
              <option value="paypal" disabled={!p.providers.paypal}>PayPal</option>
              <option value="mobile_money" disabled={!p.providers.mobileMoney}>Mobile Money (Flutterwave)</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  );
}
