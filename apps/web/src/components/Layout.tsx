import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Bell, Boxes, ChevronDown, CreditCard, Gift, LayoutGrid, LogOut, Moon, Plus, Search, Settings, Shield, Sun, User, Languages, FileCode2 } from "lucide-react";
import { get, post } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { useRealtimeInvalidate, useSession } from "../lib/session";
import { Button, cx, timeAgo, useToast } from "./ui";
import { t } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { Logo } from "./Logo";
import { useCapabilities } from "../lib/capabilities";

function HomeLogo() {
  return (
    <Link to="/" className="flex items-center px-3">
      <Logo size="sm" />
    </Link>
  );
}

function TeamSwitcher() {
  const { teams, team, setTeamId } = useSession();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  return (
    <div className="relative px-2">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between rounded-md border border-line px-2.5 py-2 text-left text-sm hover:border-line-strong" aria-haspopup="listbox">
        <span className="min-w-0">
          <span className="block truncate font-medium">{team?.name ?? "—"}</span>
          <span className="block text-xs text-muted">{team?.plan?.name ?? ""}</span>
        </span>
        <ChevronDown className="size-4 text-muted" />
      </button>
      {open && (
        <div className="absolute left-2 right-2 z-30 mt-1 rounded-md border border-line bg-panel py-1 shadow-lg" role="listbox">
          {teams.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTeamId(t.id);
                setOpen(false);
                void qc.invalidateQueries();
                nav("/");
              }}
              className={cx("block w-full px-3 py-1.5 text-left text-sm hover:bg-panel-2", t.id === team?.id && "font-medium text-fg")}
            >
              {t.name} <span className="text-xs text-muted">· {t.role}</span>
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <Link to="/settings?new=1" onClick={() => setOpen(false)} className="block px-3 py-1.5 text-sm text-muted hover:bg-panel-2 hover:text-fg">
            {t("+ Create a team")}
          </Link>
        </div>
      )}
    </div>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const nav = useNavigate();
  const { team } = useSession();
  const { data } = useQuery({ queryKey: ["search", q, team?.id], queryFn: () => get<{ results: Array<{ id: string; type: string; title: string; subtitle: string; url: string }> }>(`/search?q=${encodeURIComponent(q)}`), enabled: open && q.length > 0 });
  const quick = [
    { id: "new", type: "action", title: t("New project"), subtitle: t("Deploy from GitHub, ZIP, image or template"), url: "/new" },
    { id: "billing", type: "action", title: t("Billing"), subtitle: t("Plans, usage and invoices"), url: "/billing" },
    { id: "settings", type: "action", title: t("Team settings"), subtitle: t("Members, security, API keys"), url: "/settings" },
    { id: "account", type: "action", title: t("Account"), subtitle: t("Profile, 2FA, sessions"), url: "/account" },
  ];
  const results = q ? (data?.results ?? []) : quick;
  useEffect(() => {
    setIdx(0);
  }, [q]);
  if (!open) return null;
  const go = (url: string) => {
    onClose();
    setQ("");
    nav(url);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") setIdx((i) => Math.min(i + 1, results.length - 1));
              if (e.key === "ArrowUp") setIdx((i) => Math.max(i - 1, 0));
              if (e.key === "Enter" && results[idx]) go(results[idx]!.url);
            }}
            placeholder={t("Search projects, services, databases, domains…")}
            className="h-12 flex-1 bg-transparent text-sm outline-none"
          />
          <kbd className="rounded border border-line px-1.5 text-xs text-muted">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {results.map((r, i) => (
            <li key={`${r.type}-${r.id}`}>
              <button onMouseEnter={() => setIdx(i)} onClick={() => go(r.url)} className={cx("flex w-full items-center justify-between px-3 py-2 text-left text-sm", i === idx && "bg-panel-2")}>
                <span>
                  <span className="font-medium">{r.title}</span>
                  <span className="ml-2 text-xs text-muted">{r.subtitle}</span>
                </span>
                <span className="text-xs text-faint">{r.type}</span>
              </button>
            </li>
          ))}
          {q && !results.length && <li className="px-3 py-6 text-center text-sm text-muted">{t("No results")}</li>}
        </ul>
      </div>
    </div>
  );
}

function Notifications() {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notifications"], queryFn: () => get<{ notifications: Array<{ id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }>; unread: number }>("/notifications"), refetchInterval: 60_000 });
  useRealtimeInvalidate(me ? `user:${me.user.id}` : null, [["notifications"]]);
  const readAll = useMutation({ mutationFn: () => post("/notifications/read-all"), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-label={t("Notifications")}>
        <Bell className="size-4" />
        {!!data?.unread && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 text-accent-fg">{data.unread}</span>}
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-96 rounded-lg border border-line bg-panel shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-sm font-semibold">{t("Notifications")}</span>
            <Button size="sm" variant="ghost" onClick={() => readAll.mutate()}>
              {t("Mark all read")}
            </Button>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {data?.notifications.map((n) => (
              <li key={n.id} className={cx("border-b border-line px-3 py-2 text-sm last:border-0", !n.readAt && "bg-panel-2")}>
                {n.link ? (
                  <Link to={n.link} onClick={() => setOpen(false)} className="font-medium hover:underline">
                    {n.title}
                  </Link>
                ) : (
                  <span className="font-medium">{n.title}</span>
                )}
                <p className="text-xs text-muted">{n.body}</p>
                <p className="mt-0.5 text-[11px] text-faint">{timeAgo(n.createdAt)}</p>
              </li>
            ))}
            {!data?.notifications.length && <li className="px-3 py-8 text-center text-sm text-muted">{t("You're all caught up.")}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function Banners() {
  const { me } = useSession();
  const toast = useToast();
  const { t } = useTranslation();
  const caps = useCapabilities();
  const { data } = useQuery({ queryKey: ["announcements"], queryFn: () => get<{ announcements: Array<{ id: string; kind: string; title: string; body: string }> }>("/public/announcements"), staleTime: 300_000 });
  const bar = "flex items-center justify-center gap-2 border-b px-4 py-2 text-center text-sm";
  return (
    <>
      {caps.maintenance.enabled && (
        <div className={cx(bar, "border-amber-500/30 bg-amber-500/10")}>
          <span className="size-1.5 rounded-full bg-amber-500" />
          <strong>{t("Scheduled maintenance")}</strong>
          <span className="text-muted">
            {caps.maintenance.message}
            {caps.maintenance.blockDeploys ? ` ${t("New deployments are paused; running services are not affected.")}` : ""}
            {caps.maintenance.endsAt ? ` ${t("Expected end: {{time}}", { time: new Date(caps.maintenance.endsAt).toLocaleString() })}` : ""}
          </span>
        </div>
      )}
      {me?.impersonating && (
        <div className="bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-black">
          {t("You are viewing SKYHOST as")} {me.user.email} {t("(support session:")} {me.impersonating.reason}).{" "}
          <button className="underline" onClick={() => post("/auth/logout").then(() => (location.href = "/login"))}>
            {t("End session")}
          </button>
        </div>
      )}
      {data?.announcements.map((a) => (
        <div key={a.id} className={cx(bar, a.kind === "incident" ? "border-red-500/30 bg-red-500/10" : a.kind === "maintenance" ? "border-amber-500/30 bg-amber-500/10" : "border-line bg-panel")}>
          <span className={cx("size-1.5 rounded-full", a.kind === "incident" ? "bg-red-500" : a.kind === "maintenance" ? "bg-amber-500" : "bg-brand")} />
          <strong>{a.title}</strong> <span className="text-muted">{a.body}</span>
        </div>
      ))}
      {me && !me.user.emailVerified && caps.email.verificationRequired && (
        <div className={cx(bar, "border-line bg-panel")}>
          {t("auth.verifyBanner")}{" "}
          <button className="font-medium underline underline-offset-2" onClick={() => post("/auth/resend-verification").then(() => toast("success", t("Verification email sent")))}>
            {t("auth.resend")}
          </button>
        </div>
      )}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { me, team } = useSession();
  const { t, i18n } = useTranslation();
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark";
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "n" && e.altKey) nav("/new");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  const toggleTheme = () => setTheme(dark ? "light" : "dark");
  const item = (to: string, icon: ReactNode, label: string) => (
    <NavLink to={to} end={to === "/"} className={({ isActive }) => cx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm", isActive ? "bg-panel-2 font-medium text-fg [&>svg]:text-fg" : "text-muted hover:text-fg [&>svg]:text-faint")}>
      {icon}
      {label}
    </NavLink>
  );
  return (
    <div className="flex min-h-full flex-col">
      <Banners />
      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-5 border-r border-line bg-bg py-4 md:flex">
          <HomeLogo />
          <TeamSwitcher />
          <nav className="flex flex-1 flex-col gap-0.5 px-2">
            {item("/", <LayoutGrid className="size-4" />, t("nav.projects"))}
            {item("/new", <Plus className="size-4" />, t("nav.new"))}
            {item("/templates", <Boxes className="size-4" />, t("nav.templates"))}
            {item("/billing", <CreditCard className="size-4" />, t("nav.billing"))}
            {item("/referrals", <Gift className="size-4" />, t("nav.referrals"))}
            {item("/settings", <Settings className="size-4" />, t("nav.settings"))}
            {me?.user.isAdmin && !me.impersonating && item("/admin", <Shield className="size-4" />, t("nav.admin"))}
            <a href="/api/docs" target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-panel-2 hover:text-fg">
              <FileCode2 className="size-4" /> {t("nav.docs")}
            </a>
          </nav>
          <div className="px-5 text-[11px] leading-4 text-faint">{t("SKYHOST by SYRIX VISION COMPANY")}</div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur">
            <div className="md:hidden">
              <HomeLogo />
            </div>
            <button onClick={() => setPalette(true)} className="flex h-9 w-full max-w-sm items-center gap-2 rounded-md border border-line px-3 text-sm text-faint hover:border-line-strong hover:text-fg">
              <Search className="size-4" />
              <span className="flex-1 text-left">{t("nav.search")}</span>
              <kbd className="hidden rounded border border-line px-1.5 text-xs sm:inline">Ctrl K</kbd>
            </button>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setLanguage(i18n.language === "fr" ? "en" : "fr")} aria-label={t("Language")}>
                <Languages className="size-4" />
                <span className="hidden sm:inline">{t("lang.toggle")}</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={toggleTheme} aria-label={t("theme.toggle")}>
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
              <Notifications />
              <Link to="/account" className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-panel-2">
                {me?.user.avatarUrl ? <img src={me.user.avatarUrl} alt="" className="size-6 rounded-full" /> : <User className="size-4" />}
                <span className="hidden max-w-32 truncate lg:inline">{me?.user.name}</span>
              </Link>
              <Button variant="ghost" size="sm" aria-label={t("nav.logout")} onClick={() => post("/auth/logout").finally(() => (location.href = "/login"))}>
                <LogOut className="size-4" />
              </Button>
            </div>
          </header>
          {team?.suspended && <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm">{t("This team is suspended. Contact support to restore access to deployments.")}</div>}
          {team?.billingStatus === "past_due" && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
              {t("A payment failed.")} <Link to="/billing" className="underline">{t("Update your payment method")}</Link> {t("to avoid suspension.")}
            </div>
          )}
          <nav className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1 md:hidden">
            {[["/", t("nav.projects")], ["/new", t("nav.new")], ["/billing", t("nav.billing")], ["/settings", t("nav.settings")]].map(([to, l]) => (
              <NavLink key={to} to={to!} className="whitespace-nowrap rounded px-2 py-1 text-sm text-muted">
                {l}
              </NavLink>
            ))}
          </nav>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">{children}</main>
        </div>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
