import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { del, download, get, patch, post, put } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { useSession } from "../lib/session";
import { Alert, Badge, Button, Card, CodeField, ConfirmDialog, Field, Input, LoadingRows, Modal, PageHeader, Select, Tabs, Toggle, timeAgo, useToast } from "../components/ui";
import { ApiKeys } from "./TeamSettings";
import { t } from "../lib/i18n";

type Tab = "profile" | "security" | "sessions" | "notifications" | "apikeys" | "privacy";

function Profile() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState(me!.user.name);
  const [locale, setLocale] = useState(me!.user.locale);
  const save = useMutation({
    mutationFn: () => patch("/account", { name, locale }),
    onSuccess: () => {
      void setLanguage(locale as "en" | "fr");
      refresh();
      toast("success", t("Profile saved"));
    },
    onError: (e) => toast("error", (e as Error).message),
  });
  return (
    <Card title={t("Profile")} className="max-w-xl">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t("Email")} hint={me!.user.emailVerified ? t("Verified") : t("Not verified yet: check your inbox")}><Input value={me!.user.email} disabled /></Field>
        <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label={t("Language")}>
          <Select value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="en">{t("English")}</option>
            <option value="fr">{t("Français")}</option>
          </Select>
        </Field>
        <Button variant="primary" loading={save.isPending}>{t("Save")}</Button>
      </form>
    </Card>
  );
}

function Security() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disable, setDisable] = useState(false);
  const [disablePw, setDisablePw] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [regen, setRegen] = useState(false);
  const enabled = me!.user.twoFactorEnabled;

  const changePw = useMutation({
    mutationFn: () => post("/account/password", { currentPassword: current || undefined, newPassword: next }),
    onSuccess: () => { setCurrent(""); setNext(""); toast("success", t("Password changed. Other devices were signed out.")); },
    onError: (e) => toast("error", (e as Error).message),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t("Password")}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); changePw.mutate(); }}>
          <Field label={t("Current password")}><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label={t("New password")} hint={t("At least 10 characters")}><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} required /></Field>
          <Button variant="primary" loading={changePw.isPending}>{t("Change password")}</Button>
        </form>
      </Card>
      <Card title={<span className="flex items-center gap-2">{t("Two-factor authentication")} {enabled ? <Badge className="text-green-500">{t("Enabled")}</Badge> : <Badge>{t("Disabled")}</Badge>}</span>}>
        {!enabled && !setup && (
          <div className="space-y-3 text-sm">
            <p className="text-muted">{t("Protect your account with a code from an authenticator app (1Password, Authy, Google Authenticator…).")}</p>
            <Button variant="primary" onClick={() => post<{ secret: string; qrDataUrl: string }>("/account/2fa/setup").then(setSetup).catch((e) => toast("error", e.message))}>{t("Set up 2FA")}</Button>
          </div>
        )}
        {!enabled && setup && (
          <form className="space-y-3 text-sm" onSubmit={(e) => {
            e.preventDefault();
            void post<{ recoveryCodes: string[] }>("/account/2fa/enable", { code }).then((r) => { setCodes(r.recoveryCodes); setSetup(null); setCode(""); refresh(); }).catch((er) => toast("error", er.message));
          }}>
            <p>{t("Scan this QR code with your authenticator app, then enter the 6-digit code.")}</p>
            <img src={setup.qrDataUrl} alt={t("2FA QR code")} className="size-44 rounded bg-white p-2" />
            <Field label={t("Or enter this key manually")}><CodeField value={setup.secret} /></Field>
            <Field label={t("Code")}><Input inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
            <Button variant="primary">{t("Enable")}</Button>
          </form>
        )}
        {enabled && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => { setRegen(true); setDisableCode(""); }}>{t("New recovery codes")}</Button>
            <Button variant="danger" onClick={() => { setDisable(true); setDisableCode(""); setDisablePw(""); }}>{t("Disable 2FA")}</Button>
          </div>
        )}
      </Card>
      <Modal open={!!codes} onClose={() => setCodes(null)} title={t("Save your recovery codes")} footer={<Button variant="primary" onClick={() => setCodes(null)}>{t("I saved them")}</Button>}>
        <Alert kind="warn">{t("Each code works once if you lose your device. They are shown only now.")}</Alert>
        <pre className="mt-3 grid grid-cols-2 gap-1 rounded bg-panel-2 p-3 font-mono text-sm">{codes?.map((c) => <span key={c}>{c}</span>)}</pre>
        <Button className="mt-2" size="sm" onClick={() => void navigator.clipboard.writeText(codes!.join("\n"))}>{t("Copy all")}</Button>
      </Modal>
      <Modal open={disable} onClose={() => setDisable(false)} title={t("Disable two-factor authentication")} footer={<><Button onClick={() => setDisable(false)}>{t("Cancel")}</Button><Button variant="danger" onClick={() => post("/account/2fa/disable", { password: disablePw || undefined, code: disableCode }).then(() => { setDisable(false); refresh(); toast("success", t("2FA disabled")); }).catch((e) => toast("error", e.message))}>{t("Disable")}</Button></>}>
        <div className="space-y-3">
          <Field label={t("Password")}><Input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} /></Field>
          <Field label={t("Authenticator code")}><Input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} /></Field>
        </div>
      </Modal>
      <Modal open={regen} onClose={() => setRegen(false)} title={t("Generate new recovery codes")} footer={<><Button onClick={() => setRegen(false)}>{t("Cancel")}</Button><Button variant="primary" onClick={() => post<{ recoveryCodes: string[] }>("/account/2fa/recovery-codes", { code: disableCode }).then((r) => { setRegen(false); setCodes(r.recoveryCodes); }).catch((e) => toast("error", e.message))}>{t("Generate")}</Button></>}>
        <p className="mb-3 text-sm text-muted">{t("Your previous recovery codes stop working.")}</p>
        <Field label={t("Authenticator code")}><Input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

function Sessions() {
  const toast = useToast();
  const q = useQuery({ queryKey: ["sessions"], queryFn: () => get<{ sessions: Array<{ id: string; userAgent: string | null; ip: string | null; createdAt: string; lastSeenAt: string; current: boolean; impersonation: boolean }> }>("/account/sessions") });
  if (q.isLoading) return <LoadingRows />;
  return (
    <Card title={t("Active sessions")} actions={<Button size="sm" onClick={() => post("/account/sessions/revoke-others").then(() => { void q.refetch(); toast("success", t("Other sessions signed out")); })}>{t("Sign out other devices")}</Button>} padded={false}>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted"><tr><th className="p-3">{t("Device")}</th><th className="p-3">IP</th><th className="p-3">{t("Last active")}</th><th className="p-3" /></tr></thead>
        <tbody>
          {q.data?.sessions.map((s) => (
            <tr key={s.id} className="border-t border-line">
              <td className="max-w-md truncate p-3" title={s.userAgent ?? ""}>{s.userAgent ?? t("Unknown")} {s.current && <Badge className="ml-1 text-accent">{t("This device")}</Badge>} {s.impersonation && <Badge className="ml-1 text-amber-500">{t("Support")}</Badge>}</td>
              <td className="p-3 font-mono text-xs">{s.ip ?? "–"}</td>
              <td className="p-3 text-muted">{timeAgo(s.lastSeenAt)}</td>
              <td className="p-3 text-right">{!s.current && <Button size="sm" onClick={() => del(`/account/sessions/${s.id}`).then(() => q.refetch())}>{t("Revoke")}</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

type Prefs = Record<string, { email?: boolean; web?: boolean } | { start: string; end: string; timezone: string } | null>;

function NotificationPrefs() {
  const toast = useToast();
  const q = useQuery({ queryKey: ["notif-prefs"], queryFn: () => get<{ events: string[]; preferences: Prefs }>("/account/notification-preferences") });
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  if (q.isLoading) return <LoadingRows />;
  const p = prefs ?? q.data!.preferences ?? {};
  const ev = (k: string) => (p[k] as { email?: boolean; web?: boolean } | undefined) ?? {};
  const quiet = p.quietHours as { start: string; end: string; timezone: string } | null | undefined;
  const set = (k: string, v: Prefs[string]) => setPrefs({ ...p, [k]: v });
  return (
    <Card title={t("Notifications")} actions={<Button size="sm" variant="primary" onClick={() => put("/account/notification-preferences", { preferences: p }).then(() => toast("success", t("Preferences saved"))).catch((e) => toast("error", e.message))}>{t("Save")}</Button>} padded={false}>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted"><tr><th className="p-3">{t("Event")}</th><th className="p-3">{t("In app")}</th><th className="p-3">{t("Email")}</th></tr></thead>
        <tbody>
          {q.data!.events.map((k) => (
            <tr key={k} className="border-t border-line">
              <td className="p-3 font-mono text-xs">{k}</td>
              <td className="p-3"><Toggle checked={ev(k).web !== false} onChange={(v) => set(k, { ...ev(k), web: v })} /></td>
              <td className="p-3"><Toggle checked={ev(k).email !== false} onChange={(v) => set(k, { ...ev(k), email: v })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-end gap-3 border-t border-line p-4">
        <Toggle label={t("Quiet hours (no emails)")} checked={!!quiet} onChange={(v) => set("quietHours", v ? { start: "22:00", end: "08:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null)} />
        {quiet && (
          <>
            <Field label={t("From")}><Input type="time" value={quiet.start} onChange={(e) => set("quietHours", { ...quiet, start: e.target.value })} /></Field>
            <Field label={t("To")}><Input type="time" value={quiet.end} onChange={(e) => set("quietHours", { ...quiet, end: e.target.value })} /></Field>
            <span className="pb-2 text-xs text-muted">{quiet.timezone}</span>
          </>
        )}
      </div>
    </Card>
  );
}

function Privacy() {
  const toast = useToast();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const remove = useMutation({
    mutationFn: () => del("/account", { password: pw || undefined, confirm: "DELETE" }),
    onSuccess: () => nav("/login"),
    onError: (e) => { setOpen(false); toast("error", (e as Error).message); },
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t("Export your data")}>
        <p className="mb-3 text-sm text-muted">{t("Download a JSON file with your profile, teams, sessions, API keys, connected accounts, notifications and audit history.")}</p>
        <Button onClick={() => download("/account/export")}>{t("Download my data")}</Button>
      </Card>
      <Card title={t("Delete your account")}>
        <p className="mb-3 text-sm text-muted">{t("Your personal data is anonymized. Invoices and audit records are kept as required by law. Transfer or delete teams you own first.")}</p>
        <Field label={t("Password")} className="mb-3"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Button variant="danger" onClick={() => setOpen(true)}>{t("Delete my account")}</Button>
      </Card>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} title={t("Delete your account")} description={t("This cannot be undone.")} typeToConfirm="DELETE" confirmText={t("Delete account")} />
    </div>
  );
}

export default function Account() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("profile");
  return (
    <>
      <PageHeader title={t("nav.account")} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "profile", label: t("Profile") },
          { id: "security", label: t("Security") },
          { id: "sessions", label: t("Sessions") },
          { id: "notifications", label: t("Notifications") },
          { id: "apikeys", label: t("API keys") },
          { id: "privacy", label: t("Privacy") },
        ]}
      />
      <div className="mt-6">
        {tab === "profile" && <Profile />}
        {tab === "security" && <Security />}
        {tab === "sessions" && <Sessions />}
        {tab === "notifications" && <NotificationPrefs />}
        {tab === "apikeys" && <ApiKeys />}
        {tab === "privacy" && <Privacy />}
      </div>
    </>
  );
}
