import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatCents, PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS } from "@skyhost/shared";
import { del, get, patch, post, put } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Textarea, Toggle, timeAgo, useToast } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */

function useReason() {
  const [state, setState] = useState<{ title: string; min: number; run: (reason: string) => Promise<unknown> } | null>(null);
  const [reason, setReason] = useState("");
  const toast = useToast();
  const modal = (
    <Modal
      open={!!state}
      onClose={() => setState(null)}
      title={state?.title ?? ""}
      footer={<><Button onClick={() => setState(null)}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < (state?.min ?? 3)} onClick={() => state!.run(reason).then(() => { setState(null); toast("success", "Done"); }).catch((e) => toast("error", e.message))}>Confirm</Button></>}
    >
      <Field label="Reason" hint={`Required (at least ${state?.min ?? 3} characters). Recorded in the audit log.`}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
  return { modal, ask: (title: string, run: (reason: string) => Promise<unknown>, min = 3) => { setReason(""); setState({ title, run, min }); } };
}

function Overview() {
  const q = useQuery({ queryKey: ["admin", "overview"], queryFn: () => get("/admin/overview"), refetchInterval: 15_000 });
  if (q.isLoading) return <LoadingRows rows={4} />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  const stats: Array<[string, string | number]> = [
    ["Users", d.users],
    ["Teams", d.teams],
    ["Services", d.services],
    ["Running instances", d.runningInstances],
    ["Queued deploys", d.deployments.queued],
    ["Building", d.deployments.building],
    ["Revenue (30 days)", formatCents(d.revenue30dCents)],
    ["Open abuse reports", d.openAbuseReports],
    ["Flagged referrals", d.flaggedReferrals],
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {stats.map(([l, v]) => <div key={l} className="rounded-lg border border-line bg-panel p-3"><div className="text-xs text-muted">{l}</div><div className="mt-1 text-xl font-semibold">{v}</div></div>)}
      </div>
      <Card title="Queues" padded={false}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="p-3">Queue</th><th className="p-3">Waiting</th><th className="p-3">Active</th><th className="p-3">Delayed</th><th className="p-3">Failed</th></tr></thead>
          <tbody>{Object.entries(d.queues as Record<string, any>).map(([k, v]) => <tr key={k} className="border-t border-line"><td className="p-3 font-mono text-xs">{k}</td><td className="p-3">{v.waiting}</td><td className="p-3">{v.active}</td><td className="p-3">{v.delayed}</td><td className={cx("p-3", v.failed && "text-red-500")}>{v.failed}</td></tr>)}</tbody>
        </table>
      </Card>
      <Card title="Worker nodes" padded={false}>
        {d.nodes.length === 0 ? <EmptyState title="No worker has reported yet" /> : (
          <table className="w-full text-sm">
            <tbody>{d.nodes.map((n: any) => <tr key={n.id} className="border-t border-line first:border-0"><td className="p-3 font-mono text-xs">{n.name}</td><td className="p-3">{n.roles.join(", ")}</td><td className="p-3">{n.status}</td><td className="p-3 text-muted">heartbeat {timeAgo(n.lastHeartbeatAt)}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Users() {
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["admin", "users", q], queryFn: () => get(`/admin/users?q=${encodeURIComponent(q)}`) });
  const { modal, ask } = useReason();
  return (
    <Card title="Users" actions={<Input placeholder="Search email or name" value={q} onChange={(e) => setQ(e.target.value)} />} padded={false}>
      {list.isLoading ? <LoadingRows /> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="p-3">User</th><th className="p-3">Status</th><th className="p-3">Created</th><th className="p-3">Last login</th><th className="p-3" /></tr></thead>
          <tbody>
            {list.data?.users.map((u: any) => (
              <tr key={u.id} className="border-t border-line">
                <td className="p-3"><div>{u.name}</div><div className="text-xs text-muted">{u.email}</div></td>
                <td className="space-x-1 p-3">{u.isAdmin && <Badge>admin</Badge>}{u.suspendedAt && <Badge className="text-red-500">suspended</Badge>}{u.deletedAt && <Badge>deleted</Badge>}{u.twoFactor && <Badge>2FA</Badge>}{!u.emailVerified && <Badge>unverified</Badge>}</td>
                <td className="p-3 text-muted">{timeAgo(u.createdAt)}</td>
                <td className="p-3 text-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "never"}</td>
                <td className="space-x-2 whitespace-nowrap p-3 text-right">
                  {!u.isAdmin && !u.deletedAt && <Button size="sm" onClick={() => ask(`Sign in as ${u.email}`, (r) => post(`/admin/users/${u.id}/impersonate`, { reason: r }).then(() => { window.location.href = "/"; }), 10)}>Impersonate</Button>}
                  {!u.isAdmin && <Button size="sm" variant={u.suspendedAt ? "secondary" : "danger"} onClick={() => ask(`${u.suspendedAt ? "Unsuspend" : "Suspend"} ${u.email}`, (r) => post(`/admin/users/${u.id}/${u.suspendedAt ? "unsuspend" : "suspend"}`, { reason: r }).then(() => list.refetch()))}>{u.suspendedAt ? "Unsuspend" : "Suspend"}</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {modal}
    </Card>
  );
}

function Teams() {
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["admin", "teams", q], queryFn: () => get(`/admin/teams?q=${encodeURIComponent(q)}`) });
  const { modal, ask } = useReason();
  const [credit, setCredit] = useState<{ id: string; name: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const toast = useToast();
  return (
    <Card title="Teams" actions={<Input placeholder="Search teams" value={q} onChange={(e) => setQ(e.target.value)} />} padded={false}>
      {list.isLoading ? <LoadingRows /> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="p-3">Team</th><th className="p-3">Plan</th><th className="p-3">Billing</th><th className="p-3">Credits</th><th className="p-3" /></tr></thead>
          <tbody>
            {list.data?.teams.map((t: any) => (
              <tr key={t.id} className="border-t border-line">
                <td className="p-3"><div>{t.name}</div><div className="text-xs text-muted">{t.slug}{t.suspendedAt && <span className="text-red-500"> · suspended: {t.suspendedReason}</span>}</div></td>
                <td className="p-3">{t.plan ?? "–"}</td>
                <td className="p-3"><StatusBadge status={t.billingStatus} /></td>
                <td className="p-3">{formatCents(t.creditBalanceCents)}</td>
                <td className="space-x-2 whitespace-nowrap p-3 text-right">
                  <Button size="sm" onClick={() => { setCredit(t); setAmount(""); setReason(""); }}>Credits</Button>
                  <Button size="sm" variant={t.suspendedAt ? "secondary" : "danger"} onClick={() => ask(`${t.suspendedAt ? "Unsuspend" : "Suspend"} ${t.name}`, (r) => post(`/admin/teams/${t.id}/${t.suspendedAt ? "unsuspend" : "suspend"}`, { reason: r }).then(() => list.refetch()))}>{t.suspendedAt ? "Unsuspend" : "Suspend"}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {modal}
      <Modal open={!!credit} onClose={() => setCredit(null)} title={`Adjust credits of ${credit?.name}`} footer={<><Button onClick={() => setCredit(null)}>Cancel</Button><Button variant="primary" disabled={!amount || reason.length < 3} onClick={() => post(`/admin/teams/${credit!.id}/credits`, { amountCents: Math.round(Number(amount) * 100), reason }).then(() => { setCredit(null); void list.refetch(); toast("success", "Credits adjusted"); }).catch((e) => toast("error", e.message))}>Apply</Button></>}>
        <div className="space-y-3">
          <Field label="Amount (USD)" hint="Negative to remove credits"><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

const EMPTY_PLAN = () => ({
  slug: "",
  name: "",
  priceCents: 0,
  currency: "usd",
  limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, 0])),
  features: Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, false])),
  isPublic: true,
  isContactSales: false,
  isFree: false,
  trialDays: 0,
  stripePriceId: null,
  paypalPlanId: null,
  sort: 100,
  archived: false,
});

function Plans() {
  const toast = useToast();
  const list = useQuery({ queryKey: ["admin", "plans"], queryFn: () => get("/admin/plans") });
  const [edit, setEdit] = useState<any | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const { id, createdAt, updatedAt, overage, ...body } = edit; // eslint-disable-line @typescript-eslint/no-unused-vars
      return id ? patch(`/admin/plans/${id}`, body) : post("/admin/plans", body);
    },
    onSuccess: () => { setEdit(null); void list.refetch(); toast("success", "Plan saved"); },
    onError: (e) => toast("error", (e as Error).message),
  });
  if (list.isLoading) return <LoadingRows />;
  const set = (k: string, v: unknown) => setEdit({ ...edit, [k]: v });
  return (
    <Card title="Plans" actions={<Button size="sm" variant="primary" onClick={() => setEdit(EMPTY_PLAN())}>New plan</Button>} padded={false}>
      <table className="w-full text-sm">
        <tbody>
          {list.data.plans.map((p: any) => (
            <tr key={p.id} className="border-t border-line first:border-0">
              <td className="p-3 font-medium">{p.name} <span className="font-mono text-xs text-muted">{p.slug}</span></td>
              <td className="p-3">{p.isContactSales ? "Contact sales" : formatCents(p.priceCents, p.currency.toUpperCase())}</td>
              <td className="space-x-1 p-3">{!p.isPublic && <Badge>hidden</Badge>}{p.archived && <Badge>archived</Badge>}{p.stripePriceId && <Badge>Stripe</Badge>}{p.paypalPlanId && <Badge>PayPal</Badge>}</td>
              <td className="p-3 text-right"><Button size="sm" onClick={() => setEdit({ ...p })}>Edit</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : "New plan"} wide footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Name"><Input value={edit.name} onChange={(e) => set("name", e.target.value)} /></Field>
              <Field label="Slug"><Input value={edit.slug} onChange={(e) => set("slug", e.target.value)} disabled={!!edit.id} /></Field>
              <Field label="Price (cents)"><Input type="number" value={edit.priceCents} onChange={(e) => set("priceCents", Number(e.target.value))} /></Field>
              <Field label="Trial days"><Input type="number" value={edit.trialDays} onChange={(e) => set("trialDays", Number(e.target.value))} /></Field>
              <Field label="Stripe price id"><Input value={edit.stripePriceId ?? ""} onChange={(e) => set("stripePriceId", e.target.value || null)} /></Field>
              <Field label="PayPal plan id"><Input value={edit.paypalPlanId ?? ""} onChange={(e) => set("paypalPlanId", e.target.value || null)} /></Field>
              <Field label="Sort order"><Input type="number" value={edit.sort} onChange={(e) => set("sort", Number(e.target.value))} /></Field>
            </div>
            <div className="flex flex-wrap gap-4">
              <Toggle label="Public" checked={edit.isPublic} onChange={(v) => set("isPublic", v)} />
              <Toggle label="Free" checked={edit.isFree} onChange={(v) => set("isFree", v)} />
              <Toggle label="Contact sales" checked={edit.isContactSales} onChange={(v) => set("isContactSales", v)} />
              <Toggle label="Archived" checked={edit.archived} onChange={(v) => set("archived", v)} />
            </div>
            <h4 className="text-sm font-semibold">Limits</h4>
            <div className="grid gap-3 md:grid-cols-4">
              {PLAN_LIMIT_KEYS.map((k) => <Field key={k} label={k}><Input type="number" value={edit.limits[k] ?? 0} onChange={(e) => set("limits", { ...edit.limits, [k]: Number(e.target.value) })} /></Field>)}
            </div>
            <h4 className="text-sm font-semibold">Features</h4>
            <div className="grid gap-2 md:grid-cols-3">
              {PLAN_FEATURE_KEYS.map((k) => <Toggle key={k} label={k} checked={!!edit.features[k]} onChange={(v) => set("features", { ...edit.features, [k]: v })} />)}
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function JsonSetting({ k, value, onSaved }: { k: string; value: unknown; onSaved: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return (
    <Card title={`${k[0]!.toUpperCase()}${k.slice(1)} settings`}>
      <Textarea rows={12} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      <Button className="mt-2" variant="primary" size="sm" onClick={() => {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          toast("error", "Invalid JSON");
          return;
        }
        void put(`/admin/settings/${k}`, body).then(() => { toast("success", "Saved"); onSaved(); }).catch((e) => toast("error", e.message));
      }}>Save</Button>
    </Card>
  );
}

function Settings() {
  const q = useQuery({ queryKey: ["admin", "settings"], queryFn: () => get("/admin/settings") });
  const taxes = useQuery({ queryKey: ["admin", "tax"], queryFn: () => get("/admin/tax-rates") });
  const discounts = useQuery({ queryKey: ["admin", "discounts"], queryFn: () => get("/admin/discounts") });
  const toast = useToast();
  const [tax, setTax] = useState({ country: "", name: "VAT", percent: "20", reverseCharge: false });
  const [disc, setDisc] = useState({ code: "", percentOff: "", maxRedemptions: "" });
  if (q.isLoading) return <LoadingRows />;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-3">
        {(["referral", "billing", "signup"] as const).map((k) => <JsonSetting key={k} k={k} value={q.data[k]} onSaved={() => void q.refetch()} />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Tax rates">
          <ul className="mb-3 space-y-1 text-sm">{taxes.data?.taxRates.map((t: any) => <li key={t.country}><span className="font-mono">{t.country}</span> {t.name} {t.percent}%{t.reverseCharge && " (reverse charge for businesses)"}</li>)}</ul>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void put("/admin/tax-rates", { ...tax, percent: Number(tax.percent) }).then(() => { void taxes.refetch(); toast("success", "Tax rate saved"); }).catch((er) => toast("error", er.message)); }}>
            <Field label="Country"><Input className="w-20" maxLength={2} value={tax.country} onChange={(e) => setTax({ ...tax, country: e.target.value })} /></Field>
            <Field label="Name"><Input className="w-24" value={tax.name} onChange={(e) => setTax({ ...tax, name: e.target.value })} /></Field>
            <Field label="%"><Input className="w-20" type="number" value={tax.percent} onChange={(e) => setTax({ ...tax, percent: e.target.value })} /></Field>
            <Toggle label="Reverse charge" checked={tax.reverseCharge} onChange={(v) => setTax({ ...tax, reverseCharge: v })} />
            <Button size="sm">Save</Button>
          </form>
        </Card>
        <Card title="Discount codes">
          <ul className="mb-3 space-y-1 text-sm">{discounts.data?.discounts.map((d: any) => <li key={d.id}><span className="font-mono">{d.code}</span> {d.percentOff ? `${d.percentOff}%` : formatCents(d.amountOffCents)} · {d.redemptions ?? 0}/{d.maxRedemptions ?? "∞"}</li>)}</ul>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void post("/admin/discounts", { code: disc.code.toUpperCase(), percentOff: Number(disc.percentOff), maxRedemptions: disc.maxRedemptions ? Number(disc.maxRedemptions) : undefined }).then(() => { void discounts.refetch(); toast("success", "Discount created"); }).catch((er) => toast("error", er.message)); }}>
            <Field label="Code"><Input className="w-32" value={disc.code} onChange={(e) => setDisc({ ...disc, code: e.target.value })} /></Field>
            <Field label="% off"><Input className="w-20" type="number" value={disc.percentOff} onChange={(e) => setDisc({ ...disc, percentOff: e.target.value })} /></Field>
            <Field label="Max uses"><Input className="w-24" type="number" value={disc.maxRedemptions} onChange={(e) => setDisc({ ...disc, maxRedemptions: e.target.value })} /></Field>
            <Button size="sm">Create</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function Abuse() {
  const [status, setStatus] = useState("open");
  const q = useQuery({ queryKey: ["admin", "abuse", status], queryFn: () => get(`/admin/abuse${status ? `?status=${status}` : ""}`) });
  const { modal, ask } = useReason();
  const toast = useToast();
  return (
    <Card title="Abuse reports" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="open">Open</option><option value="investigating">Investigating</option><option value="actioned">Actioned</option><option value="dismissed">Dismissed</option></Select>} padded={false}>
      {q.isLoading ? <LoadingRows /> : q.data.reports.length === 0 ? <EmptyState title="No reports" /> : (
        <ul>
          {q.data.reports.map((r: any) => (
            <li key={r.id} className="border-t border-line p-4 first:border-0">
              <div className="flex flex-wrap items-center gap-2 text-sm"><Badge>{r.category}</Badge><StatusBadge status={r.status} /><a className="font-mono text-xs text-accent" href={r.targetUrl} target="_blank" rel="noopener noreferrer nofollow">{r.targetUrl}</a><span className="text-xs text-muted">{timeAgo(r.createdAt)}{r.reporterEmail && ` · ${r.reporterEmail}`}</span></div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{r.description}</p>
              <div className="mt-2 flex gap-2">
                {r.status === "open" && <Button size="sm" onClick={() => patch(`/admin/abuse/${r.id}`, { status: "investigating" }).then(() => q.refetch())}>Investigate</Button>}
                {r.teamId && <Button size="sm" variant="danger" onClick={() => ask("Suspend the team behind this report", (reason) => post(`/admin/teams/${r.teamId}/suspend`, { reason, reportId: r.id }).then(() => q.refetch()))}>Suspend team</Button>}
                {!["dismissed", "actioned"].includes(r.status) && <Button size="sm" onClick={() => patch(`/admin/abuse/${r.id}`, { status: "dismissed", note: "No violation found" }).then(() => { void q.refetch(); toast("success", "Dismissed"); })}>Dismiss</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {modal}
    </Card>
  );
}

function ReferralReview() {
  const [status, setStatus] = useState("flagged");
  const q = useQuery({ queryKey: ["admin", "referrals", status], queryFn: () => get(`/admin/referrals${status ? `?status=${status}` : ""}`) });
  const toast = useToast();
  const review = (id: string, decision: "approve" | "reject") => post(`/admin/referrals/${id}/review`, { decision }).then(() => { void q.refetch(); toast("success", decision === "approve" ? "Approved" : "Rejected"); }).catch((e) => toast("error", e.message));
  return (
    <Card title="Referral review" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="flagged">Flagged</option><option value="">All</option><option value="signed_up">Signed up</option><option value="converted">Converted</option><option value="rejected">Rejected</option></Select>} padded={false}>
      {q.isLoading ? <LoadingRows /> : q.data.referrals.length === 0 ? <EmptyState title="Nothing to review" /> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="p-3">Referral</th><th className="p-3">Signals</th><th className="p-3">Rewards</th><th className="p-3" /></tr></thead>
          <tbody>
            {q.data.referrals.map((r: any) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="p-3"><StatusBadge status={r.status} /><div className="mt-1 font-mono text-xs text-muted">{r.referrerUserId.slice(0, 8)} → {r.referredUserId.slice(0, 8)}</div><div className="text-xs text-muted">{timeAgo(r.createdAt)}</div></td>
                <td className="p-3 text-xs">{(r.fraudFlags ?? []).join(", ") || "–"}</td>
                <td className="p-3 text-xs">{r.rewards.map((w: any) => <div key={w.id}>{formatCents(w.amountCents)} · {w.status}</div>)}</td>
                <td className="space-x-2 whitespace-nowrap p-3 text-right">{r.status === "flagged" && <><Button size="sm" onClick={() => review(r.id, "approve")}>Approve</Button><Button size="sm" variant="danger" onClick={() => review(r.id, "reject")}>Reject</Button></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Payments() {
  const q = useQuery({ queryKey: ["admin", "payments"], queryFn: () => get("/admin/payments") });
  const toast = useToast();
  const [refund, setRefund] = useState<any | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Card title="Payments" padded={false}>
      {q.isLoading ? <LoadingRows /> : q.data.payments.length === 0 ? <EmptyState title="No payments yet" /> : (
        <table className="w-full text-sm">
          <tbody>
            {q.data.payments.map((p: any) => (
              <tr key={p.id} className="border-t border-line first:border-0">
                <td className="p-3 font-medium">{formatCents(p.amountCents, p.currency.toUpperCase())}{p.refundedCents ? <span className="text-xs text-muted"> ({formatCents(p.refundedCents)} refunded)</span> : null}</td>
                <td className="p-3">{p.provider} · {p.kind}</td>
                <td className="p-3"><StatusBadge status={p.status} /></td>
                <td className="p-3 font-mono text-xs text-muted">{p.providerPaymentId}</td>
                <td className="p-3 text-muted">{timeAgo(p.createdAt)}</td>
                <td className="p-3 text-right">{p.status === "succeeded" && ["stripe", "paypal"].includes(p.provider) && <Button size="sm" onClick={() => { setRefund(p); setAmount(""); setReason(""); }}>Refund</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={!!refund} onClose={() => setRefund(null)} title="Refund payment" footer={<><Button onClick={() => setRefund(null)}>Cancel</Button><Button variant="danger" disabled={reason.length < 3} onClick={() => post(`/admin/payments/${refund.id}/refund`, { amountCents: amount ? Math.round(Number(amount) * 100) : undefined, reason }).then((r: any) => { setRefund(null); toast("success", r.message); }).catch((e) => toast("error", e.message))}>Refund</Button></>}>
        <div className="space-y-3">
          <Field label="Amount (leave empty for a full refund)"><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Alert kind="info">The refund is applied when the provider confirms it. Related referral rewards are cancelled automatically.</Alert>
        </div>
      </Modal>
    </Card>
  );
}

function Flags() {
  const q = useQuery({ queryKey: ["admin", "flags"], queryFn: () => get("/admin/feature-flags") });
  const ann = useQuery({ queryKey: ["announcements"], queryFn: () => get("/public/announcements") });
  const toast = useToast();
  const [key, setKey] = useState("");
  const [a, setA] = useState({ kind: "info", title: "", body: "" });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Feature flags">
        <ul className="mb-3 space-y-2">
          {q.data?.flags.map((f: any) => <li key={f.key} className="flex items-center justify-between text-sm"><span className="font-mono">{f.key}</span><Toggle checked={f.enabled} onChange={(v) => put(`/admin/feature-flags/${f.key}`, { enabled: v, description: f.description ?? undefined, teamIds: f.teamIds ?? [] }).then(() => q.refetch())} /></li>)}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void put(`/admin/feature-flags/${key}`, { enabled: false }).then(() => { setKey(""); void q.refetch(); }).catch((er) => toast("error", er.message)); }}>
          <Input placeholder="new_flag_key" value={key} onChange={(e) => setKey(e.target.value)} />
          <Button size="sm">Add</Button>
        </form>
      </Card>
      <Card title="Announcements">
        <ul className="mb-3 space-y-2 text-sm">
          {ann.data?.announcements.map((x: any) => <li key={x.id} className="flex items-center justify-between"><span><Badge>{x.kind}</Badge> {x.title}</span><Button size="sm" onClick={() => del(`/admin/announcements/${x.id}`).then(() => ann.refetch())}>End</Button></li>)}
        </ul>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void post("/admin/announcements", a).then(() => { setA({ kind: "info", title: "", body: "" }); void ann.refetch(); toast("success", "Published"); }).catch((er) => toast("error", er.message)); }}>
          <div className="flex gap-2">
            <Select value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value })}><option value="info">Info</option><option value="maintenance">Maintenance</option><option value="incident">Incident</option></Select>
            <Input placeholder="Title" value={a.title} onChange={(e) => setA({ ...a, title: e.target.value })} required />
          </div>
          <Textarea rows={3} placeholder="Details" value={a.body} onChange={(e) => setA({ ...a, body: e.target.value })} />
          <Button size="sm" variant="primary">Publish</Button>
        </form>
      </Card>
    </div>
  );
}

const SECTIONS = [
  ["", "Overview"],
  ["users", "Users"],
  ["teams", "Teams"],
  ["plans", "Plans"],
  ["settings", "Settings"],
  ["abuse", "Abuse"],
  ["referrals", "Referrals"],
  ["payments", "Payments"],
  ["flags", "Flags & announcements"],
] as const;

export default function Admin() {
  const { me } = useSession();
  if (!me?.user.isAdmin || me.impersonating) return <ErrorState error={new Error("This area is reserved to SKYHOST administrators.")} />;
  return (
    <>
      <PageHeader title="Administration" />
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {SECTIONS.map(([path, label]) => (
          <NavLink key={path} end to={`/admin${path ? `/${path}` : ""}`} className={({ isActive }) => cx("-mb-px border-b-2 px-3 py-2 text-sm", isActive ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>{label}</NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="users" element={<Users />} />
        <Route path="teams" element={<Teams />} />
        <Route path="plans" element={<Plans />} />
        <Route path="settings" element={<Settings />} />
        <Route path="abuse" element={<Abuse />} />
        <Route path="referrals" element={<ReferralReview />} />
        <Route path="payments" element={<Payments />} />
        <Route path="flags" element={<Flags />} />
      </Routes>
    </>
  );
}
