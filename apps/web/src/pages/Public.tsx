import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { get, post } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Button, Card, cx, ErrorState, Field, Input, LoadingRows, Select, StatusBadge, Textarea, timeAgo } from "../components/ui";
import { t } from "../lib/i18n";

type Page = "invite" | "status" | "project-status" | "shared-screenshot" | "abuse" | "terms" | "privacy" | "cli" | "404";

function Shell({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold"><img src="/favicon.svg" alt="" className="size-6" /> SKYHOST</Link>
          <nav className="flex gap-4 text-sm text-muted"><Link to="/status">{t("Status")}</Link><Link to="/report-abuse">{t("Report abuse")}</Link></nav>
        </div>
      </header>
      <main className={cx("mx-auto px-4 py-10", narrow ? "max-w-lg" : "max-w-3xl")}>{children}</main>
    </div>
  );
}

function Invite() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { me, loading, setTeamId, refresh } = useSession();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["invite", token], queryFn: () => get<{ invite: { teamName: string; role: string; email: string; expiresAt: string } }>(`/invites/${encodeURIComponent(token)}`), enabled: !!me && !!token, retry: false });
  const act = useMutation({
    mutationFn: (action: "accept" | "decline") => post<{ ok: boolean; teamId?: string }>(`/invites/${encodeURIComponent(token)}/${action}`),
    onSuccess: (r) => {
      refresh();
      if (r.teamId) setTeamId(r.teamId);
      nav("/");
    },
  });
  if (loading) return <Shell narrow><LoadingRows /></Shell>;
  const next = encodeURIComponent(`/invite?token=${token}`);
  if (!me)
    return (
      <Shell narrow>
        <Card title={t("You have been invited to a team")}>
          <p className="mb-4 text-sm text-muted">{t("Sign in or create an account with the invited email address to join.")}</p>
          <div className="flex gap-2"><Link to={`/login?next=${next}`}><Button variant="primary">{t("Sign in")}</Button></Link><Link to={`/signup?next=${next}`}><Button>{t("Create an account")}</Button></Link></div>
        </Card>
      </Shell>
    );
  return (
    <Shell narrow>
      {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} /> : (
        <Card title={t("Join {{team}}", { team: q.data!.invite.teamName })}>
          <p className="mb-4 text-sm text-muted">{t("You are invited as")} <strong>{q.data!.invite.role}</strong>{t(". The invitation was sent to")} {q.data!.invite.email} {t("and expires")} {new Date(q.data!.invite.expiresAt).toLocaleDateString()}.</p>
          {act.error && <div className="mb-3"><Alert kind="error">{(act.error as Error).message}</Alert></div>}
          <div className="flex gap-2"><Button variant="primary" loading={act.isPending} onClick={() => act.mutate("accept")}>{t("Accept")}</Button><Button onClick={() => act.mutate("decline")}>{t("Decline")}</Button></div>
        </Card>
      )}
    </Shell>
  );
}

const COMPONENT_COLOR: Record<string, string> = { operational: "text-green-500", degraded: "text-amber-500", outage: "text-red-500", unknown: "text-faint" };

function PlatformStatus() {
  const q = useQuery({ queryKey: ["public-status"], queryFn: () => get<{ components: Array<{ name: string; status: string }>; announcements: Array<{ id: string; kind: string; title: string; body: string }>; incidents: Array<{ id: string; title: string; status: string; body: string; createdAt: string }>; updatedAt: string }>("/public/status"), refetchInterval: 30_000 });
  return (
    <Shell>
      <h1 className="mb-6 text-2xl font-semibold">{t("SKYHOST status")}</h1>
      {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} /> : (
        <div className="space-y-4">
          <Alert kind={q.data!.components.every((c) => c.status === "operational") ? "success" : "warn"}>{q.data!.components.every((c) => c.status === "operational") ? t("All systems operational") : t("Some systems are degraded")}</Alert>
          {q.data!.announcements.map((a) => <Alert key={a.id} kind={a.kind === "incident" ? "error" : a.kind === "maintenance" ? "warn" : "info"}><strong>{a.title}</strong> {a.body}</Alert>)}
          <Card padded={false}>
            <ul>{q.data!.components.map((c) => <li key={c.name} className="flex justify-between border-t border-line p-3 text-sm first:border-0"><span>{c.name}</span><span className={COMPONENT_COLOR[c.status]}>{c.status}</span></li>)}</ul>
          </Card>
          {q.data!.incidents.length > 0 && (
            <Card title={t("Past incidents")}>
              <ul className="space-y-3 text-sm">{q.data!.incidents.map((i) => <li key={i.id}><strong>{i.title}</strong> <span className="text-xs text-muted">{i.status} · {timeAgo(i.createdAt)}</span><p className="text-muted">{i.body}</p></li>)}</ul>
            </Card>
          )}
          <p className="text-xs text-faint">{t("Updated")} {timeAgo(q.data!.updatedAt)}</p>
        </div>
      )}
    </Shell>
  );
}

function ProjectStatus() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ["status-page", slug], queryFn: () => get<{ name: string; checks: Array<{ name: string; status: string; uptime90d: number | null; days: Array<{ day: string; uptime: number | null }> }>; incidents: Array<{ title: string; status: string; body: string; createdAt: string }> }>(`/public/status-pages/${slug}`), refetchInterval: 60_000 });
  const color = (u: number | null) => (u === null ? "bg-panel-2" : u >= 0.999 ? "bg-green-600" : u >= 0.95 ? "bg-amber-500" : "bg-red-600");
  return (
    <Shell>
      {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} /> : (
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">{q.data!.name}</h1>
          <Alert kind={q.data!.checks.every((c) => c.status === "up") ? "success" : "warn"}>{q.data!.checks.every((c) => c.status === "up") ? t("All systems operational") : t("Some systems are degraded")}</Alert>
          {q.data!.checks.map((c) => (
            <Card key={c.name} title={<span className="flex items-center gap-2">{c.name} <StatusBadge status={c.status} /></span>} actions={<span className="text-xs text-muted">{c.uptime90d ?? "–"}{t("% uptime (90 days)")}</span>}>
              <div className="flex gap-px">{c.days.map((d) => <span key={d.day} title={`${d.day}: ${d.uptime === null ? t("no data") : `${Math.round(d.uptime * 1000) / 10}%`}`} className={cx("h-7 flex-1 rounded-sm", color(d.uptime))} />)}</div>
            </Card>
          ))}
          {q.data!.incidents.length > 0 && <Card title={t("Incidents")}><ul className="space-y-3 text-sm">{q.data!.incidents.map((i, n) => <li key={n}><strong>{i.title}</strong> <span className="text-xs text-muted">{i.status} · {new Date(i.createdAt).toLocaleDateString()}</span><p className="text-muted">{i.body}</p></li>)}</ul></Card>}
          <p className="text-xs text-faint">{t("Powered by SKYHOST")}</p>
        </div>
      )}
    </Shell>
  );
}

function SharedScreenshot() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ["shared-shot", token], queryFn: () => get<{ title: string | null; description: string | null; viewport: string; createdAt: string; commitSha: string | null }>(`/public/screenshots/${token}/meta`), retry: false });
  return (
    <Shell>
      {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={new Error("This link has expired or was revoked.")} /> : (
        <div className="space-y-3">
          <h1 className="text-xl font-semibold">{q.data!.title ?? t("Screenshot")}</h1>
          <p className="text-sm text-muted">{q.data!.viewport} · {new Date(q.data!.createdAt).toLocaleString()}{q.data!.commitSha && ` · commit ${q.data!.commitSha.slice(0, 7)}`}</p>
          {q.data!.description && <p className="text-sm">{q.data!.description}</p>}
          <img src={`/api/v1/public/screenshots/${token}`} alt={q.data!.title ?? t("Shared screenshot")} className="w-full rounded-lg border border-line" />
        </div>
      )}
    </Shell>
  );
}

function Abuse() {
  const [form, setForm] = useState({ targetUrl: "", category: "phishing", description: "", email: "" });
  const send = useMutation({ mutationFn: () => post<{ message: string }>("/public/abuse-reports", { ...form, email: form.email || undefined }) });
  return (
    <Shell narrow>
      <h1 className="mb-2 text-2xl font-semibold">{t("Report abuse")}</h1>
      <p className="mb-6 text-sm text-muted">{t("Report phishing, malware, spam or any other abuse of a site hosted on SKYHOST.")}</p>
      {send.isSuccess ? <Alert kind="success">{send.data.message}</Alert> : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
          <Field label="URL"><Input type="url" required value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} placeholder="https://…" /></Field>
          <Field label={t("Category")}>
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {["phishing", "spam", "malware", "mining", "ddos", "copyright", "other"].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label={t("Description")} hint={t("At least 10 characters")}><Textarea rows={5} required minLength={10} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label={t("Your email (optional)")}><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          {send.error && <Alert kind="error">{(send.error as Error).message}</Alert>}
          <Button variant="primary" loading={send.isPending}>{t("Send report")}</Button>
        </form>
      )}
    </Shell>
  );
}

function Legal({ kind }: { kind: "terms" | "privacy" }) {
  return (
    <Shell>
      <article className="space-y-4 text-sm leading-6 text-muted [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:text-fg [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-fg">
        {kind === "terms" ? (
          <>
            <h1>{t("Terms of service")}</h1>
            <p>{t("SKYHOST is operated by SYRIX VISION COMPANY. By creating an account you agree to these terms.")}</p>
            <h2>{t("Acceptable use")}</h2>
            <p>{t("You may not host phishing pages, malware, spam, cryptocurrency mining, denial of service tools, or content that infringes the rights of others. Accounts that break these rules can be suspended without notice.")}</p>
            <h2>{t("Your content")}</h2>
            <p>{t("You keep every right on your code and data. We process it only to build, run and back up your services.")}</p>
            <h2>{t("Billing")}</h2>
            <p>{t("Paid plans renew automatically until cancelled. Downgrades are refused while your usage exceeds the target plan, so nothing is deleted silently.")}</p>
            <h2>{t("Availability")}</h2>
            <p>{t("We do our best to keep the platform available and publish incidents on the status page. Keep your own backups of critical data.")}</p>
          </>
        ) : (
          <>
            <h1>{t("Privacy policy")}</h1>
            <p>{t("We collect what is needed to run the service: your account details, the projects you deploy, logs and metrics, and billing records.")}</p>
            <h2>{t("Security")}</h2>
            <p>{t("Passwords are hashed with Argon2id. Secrets, environment variables and backups are encrypted at rest with AES-256-GCM.")}</p>
            <h2>{t("Your rights")}</h2>
            <p>{t("You can export all of your data and delete your account at any time from your account settings. Invoices and audit records are kept as long as the law requires.")}</p>
            <h2>{t("Processors")}</h2>
            <p>{t("Payments are handled by Stripe, PayPal and Flutterwave. We never store card numbers.")}</p>
          </>
        )}
      </article>
    </Shell>
  );
}

function CliApprove() {
  const [params] = useSearchParams();
  const { teams, team } = useSession();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [teamId, setTeamId] = useState(team?.id ?? "");
  const approve = useMutation({ mutationFn: () => post("/auth/cli/approve", { userCode: code.trim().toUpperCase(), teamId }) });
  return (
    <div className="mx-auto max-w-lg">
      <Card title={t("Authorize the SKYHOST CLI")}>
        {approve.isSuccess ? (
          <div className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-5 text-green-500" /> {t("The CLI is signed in. You can close this tab and go back to your terminal.")}</div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); approve.mutate(); }}>
            <p className="text-sm text-muted">{t("Check that this code matches the one displayed in your terminal. Only approve requests you started.")}</p>
            <Field label={t("Code")}><Input className="font-mono text-lg tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
            <Field label={t("Team")}><Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            {approve.error && <Alert kind="error">{(approve.error as Error).message}</Alert>}
            <Button variant="primary" loading={approve.isPending}>{t("Approve")}</Button>
          </form>
        )}
      </Card>
    </div>
  );
}

function NotFound() {
  return (
    <Shell narrow>
      <div className="text-center">
        <p className="text-5xl font-semibold">404</p>
        <p className="mt-2 text-muted">{t("This page does not exist.")}</p>
        <Link to="/" className="mt-6 inline-block"><Button variant="primary">{t("Back to the dashboard")}</Button></Link>
      </div>
    </Shell>
  );
}

export default function Public({ page }: { page: Page }) {
  switch (page) {
    case "invite": return <Invite />;
    case "status": return <PlatformStatus />;
    case "project-status": return <ProjectStatus />;
    case "shared-screenshot": return <SharedScreenshot />;
    case "abuse": return <Abuse />;
    case "terms": return <Legal kind="terms" />;
    case "privacy": return <Legal kind="privacy" />;
    case "cli": return <CliApprove />;
    default: return <NotFound />;
  }
}
