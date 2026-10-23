import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCents } from "@skyhost/shared";
import { download, get, post, put } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { featureLabel, limitLabel, limitValue } from "../lib/labels";
import { useSession } from "../lib/session";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, LoadingRows, Meter, Modal, PageHeader, Select, StatusBadge, Tabs, timeAgo, Unavailable, useToast } from "../components/ui";
import { t } from "../lib/i18n";

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
  pendingDiscount: { redemptionId: string; code: string; percentOff: number } | null;
  promoCodes: Array<{ id: string; code: string; status: string; amountCents: number; percentOff: number | null; createdAt: string; appliedAt: string | null }>;
}

interface Usage {
  period: { start: string; end: string };
  plan: { slug: string; name: string; priceCents: number; currency: string };
  estimate: {
    planCents: number;
    discountCents: number;
    totalCents: number;
    promo: { code: string; percentOff: number } | null;
    usage?: { enabled: boolean; lines: Array<{ metric: string; label: string; unit: string; quantity: number; unitCents: number; amountCents: number }>; usageCents: number; includedCents: number; billableCents: number };
  };
  daily: Array<{ day: string; cpuHours: number; memoryGbHours: number; egressGb: number; buildMinutes: number }>;
  services: Array<{ serviceId: string; service: string; project: string; projectId: string; cpuHours: number; memoryGbHours: number; egressGb: number; buildMinutes: number; share: number; attributedCents: number }>;
}

type Tab = "overview" | "usage" | "plans" | "invoices" | "payment";
const TABS: Tab[] = ["overview", "usage", "plans", "invoices", "payment"];
const SALES_EMAIL = import.meta.env.VITE_SALES_EMAIL as string | undefined;
const HIGHLIGHT_LIMITS = ["projects", "services", "databases", "cpu", "memoryMb", "storageMb", "deploysPerDay", "members"];
const num = (v: number, digits = 1) => v.toLocaleString(undefined, { maximumFractionDigits: digits });
// Usage quantities can be tiny (a few CPU seconds): keep two significant digits below 1.
const qty = (v: number) => (v === 0 ? "0" : Math.abs(v) < 1 ? Number(v.toPrecision(2)).toLocaleString(undefined, { maximumFractionDigits: 8 }) : num(v, 2));

export default function Billing() {
  const { t } = useTranslation();
  const { team, refresh } = useSession();
  const caps = useCapabilities();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get("tab") as Tab) ? params.get("tab") : "overview") as Tab;
  const setTab = (v: Tab) => setParams(v === "overview" ? {} : { tab: v });
  const canManage = ["owner", "admin"].includes(team!.role);
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<{ plans: Plan[]; providers: { stripe: boolean; paypal: boolean; mobileMoney: boolean }; paymentsEnabled: boolean }>("/plans") });
  const ov = useQuery({ queryKey: ["billing", team!.id], queryFn: () => get<Overview>(`/teams/${team!.id}/billing`) });
  const usage = useQuery({ queryKey: ["billing", team!.id, "usage"], queryFn: () => get<Usage>(`/teams/${team!.id}/billing/usage`) });
  const [checkout, setCheckout] = useState<Plan | null>(null);
  const [credits, setCredits] = useState(false);
  const [amount, setAmount] = useState("20");
  const [creditProvider, setCreditProvider] = useState<"stripe" | "paypal" | "mobile_money">("stripe");
  const [cap, setCap] = useState<string>("");
  const [capAction, setCapAction] = useState("alert");
  const [code, setCode] = useState("");

  // Return from a provider. Activation itself happens through verified webhooks.
  useEffect(() => {
    const token = params.get("token");
    if (params.get("paypal") === "return" && token) {
      void post(`/teams/${team!.id}/billing/paypal/capture`, { orderId: token })
        .then(() => toast("success", t("Payment received. Credits added.")))
        .catch((e) => toast("error", e.message))
        .finally(() => { setParams({}); void qc.invalidateQueries({ queryKey: ["billing"] }); refresh(); });
    } else if (params.get("checkout") === "success" || params.get("credits") === "success") {
      toast("success", t("Payment submitted. Your account updates as soon as the provider confirms it."));
      setParams({});
    } else if (params.get("credits") === "pending") {
      toast("info", t("Mobile Money payment pending: credits are added once the operator confirms it."));
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
      toast("success", r.message ?? t("Plan updated"));
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
  const redeem = useMutation({
    mutationFn: () => post<{ promo: { kind: "credits"; amountCents: number; code: string } | { kind: "percent"; percentOff: number; code: string } }>(`/teams/${team!.id}/billing/promo`, { code }),
    onSuccess: ({ promo }) => {
      toast("success", promo.kind === "credits" ? t("{{amount}} of credits added", { amount: formatCents(promo.amountCents) }) : t("{{percent}}% off your next plan payment", { percent: promo.percentOff }));
      setCode("");
      void qc.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (e) => toast("error", (e as Error).message),
  });

  if (plans.isLoading || ov.isLoading) return <LoadingRows rows={6} />;
  if (ov.error) return <ErrorState error={ov.error} onRetry={() => ov.refetch()} />;
  const o = ov.data!;
  const p = plans.data!;
  const u = usage.data;
  const currentPlanId = o.usage.plan.id;
  const sub = o.subscription;
  const providers = { stripe: caps.payments.stripe && p.providers.stripe, paypal: caps.payments.paypal && p.providers.paypal, mobileMoney: caps.payments.mobileMoney && p.providers.mobileMoney };
  const anyProvider = providers.stripe || providers.paypal || providers.mobileMoney;

  const promoForm = (
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) redeem.mutate(); }}>
      <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="WELCOME-2026" aria-label={t("Promo code")} className="font-mono uppercase" disabled={!canManage} maxLength={32} />
      <Button type="submit" loading={redeem.isPending} disabled={!canManage || !code.trim()}>{t("Apply")}</Button>
    </form>
  );

  return (
    <>
      <PageHeader title={t("nav.billing")} subtitle={t("{{team}} · {{plan}} plan", { team: team!.name, plan: o.usage.plan.name })} actions={canManage && sub?.provider === "stripe" && <Button onClick={() => post<{ url: string }>(`/teams/${team!.id}/billing/portal`).then(redirect).catch((e) => toast("error", e.message))}>{t("Manage cards")}</Button>} />
      {o.status === "past_due" && <div className="mb-4"><Alert kind="error">{t("Your last payment failed. Update your payment method")}{o.graceEndsAt ? ` (${new Date(o.graceEndsAt).toLocaleDateString()})` : ""} {t("to avoid service interruption.")}</Alert></div>}
      {sub?.cancelAtPeriodEnd && <div className="mb-4"><Alert kind="warn">{t("Your subscription ends on")} {sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : t("the end of the period")}{t(". You will move to the free plan.")}</Alert></div>}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: t("Overview") },
          { id: "usage", label: t("Usage") },
          { id: "plans", label: t("Plans") },
          { id: "invoices", label: t("Invoices") },
          { id: "payment", label: t("Payment methods") },
        ]}
      />

      {tab === "overview" && (
        <div className="space-y-6">
          <section className="grid overflow-hidden rounded-lg border border-line bg-panel md:grid-cols-[1.4fr_1fr_1fr]">
            <div className="border-b border-line p-5 md:border-b-0 md:border-r">
              <div className="text-xs font-medium uppercase tracking-wider text-faint">{t("Estimated bill this period")}</div>
              <div className="mt-2 text-4xl font-semibold tabular-nums tracking-tight">{u ? formatCents(u.estimate.totalCents, u.plan.currency.toUpperCase()) : "—"}</div>
              {u && <PeriodBar start={u.period.start} end={u.period.end} />}
            </div>
            <Stat label={t("Prepaid credits")} value={formatCents(o.creditBalanceCents)} hint={t("Use credits to pay for a plan without a card.")} action={canManage && <Button size="sm" disabled={!anyProvider} onClick={() => setCredits(true)}>{t("Add credits")}</Button>} />
            <Stat label={t("Current plan")} value={o.usage.plan.name} hint={sub ? <span className="inline-flex items-center gap-1.5">{t("via")} {sub.provider} <StatusBadge status={sub.status} /></span> : t("No subscription")} action={<Button size="sm" onClick={() => setTab("plans")}>{t("Change plan")}</Button>} />
          </section>

          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <Card title={t("Breakdown")} padded={false}>
              {u ? (
                <dl className="divide-y divide-line text-sm">
                  <Line label={t("{{plan}} plan", { plan: u.plan.name })} value={formatCents(u.estimate.planCents, u.plan.currency.toUpperCase())} />
                  {u.estimate.promo && <Line label={<span className="flex items-center gap-2">{t("Promo code")} <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs">{u.estimate.promo.code}</code> <span className="text-muted">−{u.estimate.promo.percentOff}%</span></span>} value={`−${formatCents(u.estimate.discountCents, u.plan.currency.toUpperCase())}`} />}
                  {u.estimate.usage?.enabled ? (
                    <>
                      {u.estimate.usage.lines.map((l) => (
                        <Line key={l.metric} label={<span>{t(l.label)} <span className="text-xs text-faint">{l.quantity} {t(l.unit)} × {l.unitCents}¢</span></span>} value={formatCents(l.amountCents, u.plan.currency.toUpperCase())} muted />
                      ))}
                      {u.estimate.usage.includedCents > 0 && <Line label={t("Usage included in the plan")} value={`−${formatCents(u.estimate.usage.includedCents, u.plan.currency.toUpperCase())}`} muted />}
                    </>
                  ) : (
                    <Line label={t("Usage included in the plan")} value={formatCents(0, u.plan.currency.toUpperCase())} muted />
                  )}
                  <Line label={<span className="font-medium text-fg">{t("Total")}</span>} value={<span className="font-semibold text-fg">{formatCents(u.estimate.totalCents, u.plan.currency.toUpperCase())}</span>} />
                </dl>
              ) : usage.error ? <div className="p-4"><ErrorState error={usage.error} onRetry={() => usage.refetch()} /></div> : <div className="p-4"><LoadingRows rows={3} /></div>}
            </Card>
            <Card title={t("Promo code")}>
              {promoForm}
              <p className="mt-2 text-xs text-muted">{t("Fixed-amount codes become credits right away. Percentage codes apply to your next plan payment.")}</p>
              {o.pendingDiscount && <div className="mt-3 flex items-center justify-between rounded-md border border-line bg-panel-2 px-3 py-2 text-sm"><span className="font-mono">{o.pendingDiscount.code}</span><span className="text-muted">{t("{{percent}}% off your next plan payment", { percent: o.pendingDiscount.percentOff })}</span></div>}
              {o.promoCodes.length > 0 && (
                <ul className="mt-3 divide-y divide-line border-t border-line text-sm">
                  {o.promoCodes.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="font-mono text-xs">{r.code}</span>
                      <span className="text-muted">{r.amountCents ? `+${formatCents(r.amountCents)}` : `−${r.percentOff}%`}</span>
                      <StatusBadge status={r.status === "pending" ? "pending" : "paid"} label={r.status === "credits" ? t("Credited") : r.status === "pending" ? t("Next payment") : t("Applied")} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title={t("Cost by service")} padded={false} actions={<span className="text-xs text-faint">{t("Plan price split by CPU and memory used")}</span>}>
            {!u || u.services.length === 0 ? <EmptyState title={t("No usage recorded yet this period")} description={t("Usage appears here as your services run.")} /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-faint">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium">{t("Service")}</th>
                      <th className="px-4 py-2 text-right font-medium">{t("CPU hours")}</th>
                      <th className="px-4 py-2 text-right font-medium">{t("Memory GB-hours")}</th>
                      <th className="px-4 py-2 text-right font-medium">{t("Egress GB")}</th>
                      <th className="px-4 py-2 text-right font-medium">{t("Build minutes")}</th>
                      <th className="w-40 px-4 py-2 font-medium">{t("Share")}</th>
                      <th className="px-4 py-2 text-right font-medium">{t("Cost")}</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-xs">
                    {u.services.map((s) => (
                      <tr key={s.serviceId} className="border-b border-line last:border-0 hover:bg-panel-2">
                        <td className="px-4 py-2.5 font-sans text-sm"><Link to={`/projects/${s.projectId}/services/${s.serviceId}`} className="hover:underline">{s.service}</Link> <span className="text-faint">· {s.project}</span></td>
                        <td className="px-4 py-2.5 text-right">{num(s.cpuHours, 2)}</td>
                        <td className="px-4 py-2.5 text-right">{num(s.memoryGbHours, 2)}</td>
                        <td className="px-4 py-2.5 text-right">{num(s.egressGb, 2)}</td>
                        <td className="px-4 py-2.5 text-right">{num(s.buildMinutes)}</td>
                        <td className="px-4 py-2.5"><div className="flex items-center gap-2"><div className="h-1 flex-1 rounded-full bg-panel-2"><div className="h-full rounded-full bg-fg" style={{ width: `${s.share}%` }} /></div><span className="w-10 text-right text-muted">{num(s.share)}%</span></div></td>
                        <td className="px-4 py-2.5 text-right">{formatCents(s.attributedCents, u.plan.currency.toUpperCase())}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title={t("Spend cap")}>
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void put(`/teams/${team!.id}/spend-cap`, { spendCapCents: cap === "" ? null : Math.round(Number(cap) * 100), action: capAction }).then(() => toast("success", t("Spend cap saved"))).catch((er) => toast("error", er.message)); }}>
              <Field label={t("Monthly cap in USD")} className="w-40"><Input type="number" min={0} step="1" placeholder={t("No cap")} value={cap} onChange={(e) => setCap(e.target.value)} disabled={!canManage} /></Field>
              <Field label={t("When reached")} className="w-48">
                <Select value={capAction} onChange={(e) => setCapAction(e.target.value)} disabled={!canManage}>
                  <option value="alert">{t("Alert only")}</option>
                  <option value="block_deploys">{t("Block deploys")}</option>
                  <option value="pause_services">{t("Pause services")}</option>
                </Select>
              </Field>
              {canManage && <Button>{t("Save")}</Button>}
            </form>
          </Card>
        </div>
      )}

      {tab === "usage" && (
        <div className="space-y-6">
          <Card title={t("Plan limits")}>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {o.usage.items.map((i) => <Meter key={i.key} value={i.current} max={i.limit} label={limitLabel(i.key)} format={(v) => limitValue(i.key, v)} />)}
            </div>
          </Card>
          {u ? (
            <div className="grid gap-4 md:grid-cols-2">
              <UsageChart data={u.daily} dataKey="cpuHours" title={t("CPU hours")} />
              <UsageChart data={u.daily} dataKey="memoryGbHours" title={t("Memory GB-hours")} />
              <UsageChart data={u.daily} dataKey="egressGb" title={t("Egress GB")} />
              <UsageChart data={u.daily} dataKey="buildMinutes" title={t("Build minutes")} />
            </div>
          ) : usage.error ? <ErrorState error={usage.error} onRetry={() => usage.refetch()} /> : <LoadingRows rows={4} />}
        </div>
      )}

      {tab === "plans" && (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="w-48 p-4" />
                {p.plans.map((plan) => {
                  const current = plan.id === currentPlanId;
                  return (
                    <th key={plan.id} className={cx("p-4 text-left align-top font-normal", current && "bg-panel-2")}>
                      <div className="flex items-center gap-2 font-semibold">{plan.name}{current && <Badge>{t("Current")}</Badge>}</div>
                      <div className="mt-2 text-xl font-semibold tabular-nums">{plan.isContactSales ? t("Custom") : plan.isFree ? t("Free") : <>{formatCents(plan.priceCents, plan.currency.toUpperCase())}<span className="text-xs font-normal text-muted"> /{plan.interval}</span></>}</div>
                      <div className="mt-3">
                        {plan.isContactSales ? (
                          SALES_EMAIL || caps.support.email ? <a href={`mailto:${SALES_EMAIL || caps.support.email}`} className="text-sm underline underline-offset-4">{t("Contact sales")}</a> : <span className="text-xs text-muted">{t("Contact the platform administrator")}</span>
                        ) : (
                          <Button size="sm" className="w-full" variant={current ? "secondary" : "primary"} disabled={current || !canManage} onClick={() => (plan.isFree ? subscribe.mutate({ plan, provider: "stripe" }) : setCheckout(plan))}>
                            {current ? t("Current plan") : plan.isFree ? t("Switch to free") : plan.trialDays && !sub ? t("Start {{days}}-day trial", { days: plan.trialDays }) : t("Choose")}
                          </Button>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {HIGHLIGHT_LIMITS.filter((k) => p.plans.some((pl) => k in pl.limits)).map((k) => (
                <tr key={k} className="border-b border-line">
                  <td className="px-4 py-2.5 text-muted">{limitLabel(k)}</td>
                  {p.plans.map((plan) => <td key={plan.id} className={cx("px-4 py-2.5 font-mono text-xs", plan.id === currentPlanId && "bg-panel-2")}>{k in plan.limits ? limitValue(k, plan.limits[k]!) : "—"}</td>)}
                </tr>
              ))}
              {[...new Set(p.plans.flatMap((pl) => Object.keys(pl.features)))].map((k) => (
                <tr key={k} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 text-muted">{featureLabel(k)}</td>
                  {p.plans.map((plan) => <td key={plan.id} className={cx("px-4 py-2.5", plan.id === currentPlanId && "bg-panel-2")}>{plan.features[k] ? <Check /> : <span className="text-faint">—</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "invoices" && (
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <Card title={t("Invoices")} padded={false}>
            {o.invoices.length === 0 ? <EmptyState title={t("No invoices yet")} /> : (
              <table className="w-full text-sm">
                <tbody>
                  {o.invoices.map((i) => (
                    <tr key={i.id} className="border-t border-line first:border-0">
                      <td className="p-3 font-mono text-xs">{i.number}</td>
                      <td className="p-3 font-mono text-xs">{formatCents(i.totalCents, i.currency.toUpperCase())}</td>
                      <td className="p-3"><StatusBadge status={i.status} /></td>
                      <td className="p-3 text-muted">{new Date(i.createdAt).toLocaleDateString()}</td>
                      <td className="p-3 text-right"><Button size="sm" onClick={() => download(`/invoices/${i.id}/pdf`)}>PDF</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title={t("Credit history")} padded={false}>
            {o.credits.length === 0 ? <EmptyState title={t("No credit movements")} /> : (
              <table className="w-full text-sm">
                <tbody>
                  {o.credits.map((c) => (
                    <tr key={c.id} className="border-t border-line first:border-0">
                      <td className={cx("p-3 font-mono text-xs", c.amountCents >= 0 ? "text-emerald-500" : "text-fg")}>{c.amountCents >= 0 ? "+" : ""}{formatCents(c.amountCents)}</td>
                      <td className="p-3">{c.reason}</td>
                      <td className="p-3 text-muted">{timeAgo(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      )}

      {tab === "payment" && (
        <div className="space-y-6">
          <Card title={t("Payment providers")} padded={false}>
            <ul className="divide-y divide-line text-sm">
              <ProviderRow name={t("Card (Stripe)")} description={t("Visa, Mastercard, American Express. Subscriptions renew automatically.")} available={providers.stripe} />
              <ProviderRow name={t("PayPal")} description={t("Pay a plan or buy credits with your PayPal account.")} available={providers.paypal} />
              <ProviderRow name={t("Mobile Money (Flutterwave)")} description={t("MTN, Orange, Airtel, M-Pesa: buy prepaid credits from your phone.")} available={providers.mobileMoney} />
              <ProviderRow name={t("Prepaid credits")} description={t("Always available: pay a month of any plan from your credit balance.")} available />
            </ul>
          </Card>
          <Card title={t("Saved cards")} padded={false}>
            {o.paymentMethods.length === 0 ? <EmptyState title={t("No saved payment method")} description={providers.stripe ? t("Cards are saved when you subscribe by card.") : undefined} /> : (
              <ul className="divide-y divide-line text-sm">
                {o.paymentMethods.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] uppercase">{m.brand ?? m.provider}</span>
                    <span className="font-mono">•••• {m.last4 ?? "----"}</span>
                    {m.expMonth && <span className="text-muted">{String(m.expMonth).padStart(2, "0")}/{m.expYear}</span>}
                    {m.isDefault && <Badge className="ml-auto">{t("Default")}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <Modal open={!!checkout} onClose={() => setCheckout(null)} title={t("Subscribe to {{name}}", { name: checkout?.name })}>
        {checkout && (
          <div className="space-y-3 text-sm">
            <p>
              {o.pendingDiscount ? <><s className="text-faint">{formatCents(checkout.priceCents, checkout.currency.toUpperCase())}</s> {formatCents(Math.round((checkout.priceCents * (100 - o.pendingDiscount.percentOff)) / 100), checkout.currency.toUpperCase())}</> : formatCents(checkout.priceCents, checkout.currency.toUpperCase())} {t("per")} {checkout.interval}{t(". Taxes are calculated from your billing country. You can cancel at any time.")}
            </p>
            <div className="grid gap-2">
              <PayButton available={checkout.providers.stripe && providers.stripe} primary loading={subscribe.isPending} onClick={() => subscribe.mutate({ plan: checkout, provider: "stripe" })}>{t("Pay by card (Stripe)")}</PayButton>
              <PayButton available={checkout.providers.paypal && providers.paypal} onClick={() => subscribe.mutate({ plan: checkout, provider: "paypal" })}>{t("Pay with PayPal")}</PayButton>
              <Button disabled={o.creditBalanceCents < checkout.priceCents} onClick={() => subscribe.mutate({ plan: checkout, provider: "credits" })}>{t("Pay one month with credits ({{amount}} available)", { amount: formatCents(o.creditBalanceCents) })}</Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={credits} onClose={() => setCredits(false)} title={t("Add prepaid credits")} footer={<><Button onClick={() => setCredits(false)}>{t("Cancel")}</Button><Button variant="primary" loading={buyCredits.isPending} disabled={Number(amount) < 5} onClick={() => buyCredits.mutate()}>{t("Continue to payment")}</Button></>}>
        <div className="space-y-3">
          <Field label={t("Amount (USD)")} hint={t("Minimum 5 USD")}><Input type="number" min={5} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label={t("Payment method")}>
            <Select value={creditProvider} onChange={(e) => setCreditProvider(e.target.value as typeof creditProvider)}>
              <option value="stripe" disabled={!providers.stripe}>{t("Card (Stripe)")}{providers.stripe ? "" : ` · ${t("Not available yet")}`}</option>
              <option value="paypal" disabled={!providers.paypal}>{t("PayPal")}{providers.paypal ? "" : ` · ${t("Not available yet")}`}</option>
              <option value="mobile_money" disabled={!providers.mobileMoney}>{t("Mobile Money (Flutterwave)")}{providers.mobileMoney ? "" : ` · ${t("Not available yet")}`}</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  );
}

function Stat({ label, value, hint, action }: { label: ReactNode; value: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col border-b border-line p-5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
      {action && <div className="mt-auto pt-3">{action}</div>}
    </div>
  );
}

function Line({ label, value, muted }: { label: ReactNode; value: ReactNode; muted?: boolean }) {
  return (
    <div className={cx("flex items-center justify-between px-4 py-3", muted && "text-muted")}>
      <dt>{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  );
}

function PeriodBar({ start, end }: { start: string; end: string }) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const pct = Math.min(100, Math.max(0, ((Date.now() - s) / (e - s)) * 100));
  const days = Math.max(0, Math.ceil((e - Date.now()) / 86400_000));
  const fmt = (d: number) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className="mt-4">
      <div className="h-1 rounded-full bg-panel-2"><div className="h-full rounded-full bg-fg" style={{ width: `${pct}%` }} /></div>
      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>{fmt(s)} – {fmt(e - 1)}</span>
        <span>{t("{{count}} days left", { count: days })}</span>
      </div>
    </div>
  );
}

function UsageChart({ data, dataKey, title }: { data: Usage["daily"]; dataKey: "cpuHours" | "memoryGbHours" | "egressGb" | "buildMinutes"; title: string }) {
  const total = data.reduce((a, d) => a + d[dataKey], 0);
  const rows = data.map((d) => ({ ...d, label: d.day.slice(5) }));
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm font-medium">{title}</span>
        <span className="font-mono text-sm">{qty(total)}</span>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <CartesianGrid stroke="var(--sh-line)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--sh-faint)" }} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis tick={{ fontSize: 10, fill: "var(--sh-faint)" }} tickLine={false} axisLine={false} width={60} tickFormatter={(v) => qty(Number(v))} />
            <Tooltip cursor={{ fill: "var(--sh-panel-2)" }} contentStyle={{ background: "var(--sh-panel)", border: "1px solid var(--sh-line-strong)", borderRadius: 6, fontSize: 12 }} formatter={(v) => qty(Number(v))} />
            <Bar dataKey={dataKey} fill="var(--sh-fg)" radius={[2, 2, 0, 0]} isAnimationActive={false} name={title} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ProviderRow({ name, description, available }: { name: string; description: string; available: boolean }) {
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className={cx("font-medium", !available && "text-muted")}>{name}</div>
        <div className="text-xs text-muted">{description}</div>
      </div>
      {available ? <StatusBadge status="active" label={t("Available")} /> : <Unavailable />}
    </li>
  );
}

function PayButton({ available, primary, loading, onClick, children }: { available: boolean; primary?: boolean; loading?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant={primary && available ? "primary" : "secondary"} disabled={!available} loading={loading} onClick={onClick} className="justify-between">
      <span>{children}</span>
      {!available && <Unavailable />}
    </Button>
  );
}

function Check() {
  return <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-label={t("Included")}><path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
