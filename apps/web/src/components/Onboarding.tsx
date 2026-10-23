import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { get, post } from "../lib/api";
import { t } from "../lib/i18n";
import { useSession } from "../lib/session";
import { cx, useToast } from "./ui";

type Steps = { verifyEmail: boolean; connectGit: boolean; firstDeploy: boolean; addDatabase: boolean; customDomain: boolean; inviteTeammate: boolean };

/** Getting-started checklist on the dashboard, until every step is done or the user hides it. */
export function Onboarding() {
  const { team } = useSession();
  const toast = useToast();
  const key = `sh-onboarding-hidden:${team?.id}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const q = useQuery({ queryKey: ["onboarding", team?.id], queryFn: () => get<{ steps: Steps; done: boolean }>(`/teams/${team!.id}/onboarding`), enabled: !!team && !hidden });
  if (hidden || !q.data || q.data.done) return null;
  const s = q.data.steps;
  const items: Array<{ done: boolean; title: string; text: string; action: React.ReactNode }> = [
    { done: s.verifyEmail, title: t("Verify your email"), text: t("Needed to deploy and to receive alerts."), action: <button className="underline underline-offset-4" onClick={() => post("/auth/resend-verification").then(() => toast("success", t("Verification email sent")))}>{t("Resend email")}</button> },
    { done: s.connectGit, title: t("Connect GitHub"), text: t("Every push to your repository redeploys automatically."), action: <Link to="/new" className="underline underline-offset-4">{t("Connect")}</Link> },
    { done: s.firstDeploy, title: t("Deploy your first app"), text: t("From a repository, a ZIP, a Docker image or a template."), action: <Link to="/new" className="underline underline-offset-4">{t("Deploy")}</Link> },
    { done: s.addDatabase, title: t("Add a database"), text: t("PostgreSQL, MySQL, MongoDB or Redis, ready in seconds."), action: <Link to="/databases/new" className="underline underline-offset-4">{t("Create")}</Link> },
    { done: s.customDomain, title: t("Use your own domain"), text: t("In a service: Domains. HTTPS is automatic."), action: <Link to="/docs/custom-domains" className="underline underline-offset-4">{t("How")}</Link> },
    { done: s.inviteTeammate, title: t("Invite a teammate"), text: t("Work together with roles and permissions."), action: <Link to="/settings" className="underline underline-offset-4">{t("Invite")}</Link> },
  ];
  const doneCount = items.filter((i) => i.done).length;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
  };
  return (
    <section className="mb-6 rounded-lg border border-line bg-panel" aria-label={t("Getting started")}>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{t("Getting started")}</h2>
        <span className="text-xs text-muted">{t("{{done}} of {{total}} done", { done: doneCount, total: items.length })}</span>
        <div className="ml-2 h-1 w-24 rounded-full bg-panel-2"><div className="h-full rounded-full bg-fg" style={{ width: `${(doneCount / items.length) * 100}%` }} /></div>
        <button className="ml-auto rounded p-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label={t("Hide")} onClick={hide}><X className="size-4" /></button>
      </header>
      <ol className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
        {items.map((i) => (
          <li key={i.title} className="flex gap-3 bg-panel p-4">
            <span className={cx("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border", i.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-line-strong")} aria-hidden>{i.done && <Check className="size-3" />}</span>
            <div className="min-w-0 text-sm">
              <div className={cx("font-medium", i.done && "text-muted line-through")}>{i.title}</div>
              <div className="text-xs text-muted">{i.text}</div>
              {!i.done && <div className="mt-1.5 text-xs font-medium">{i.action}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
