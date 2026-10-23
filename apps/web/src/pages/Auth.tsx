import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { get, post } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Button, Field, Input } from "../components/ui";

function deviceId() {
  try {
    let id = localStorage.getItem("sh-device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("sh-device", id);
    }
    return id;
  } catch {
    return undefined;
  }
}

function Shell({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2 text-lg font-semibold tracking-wide">
          <img src="/favicon.svg" alt="" className="size-7" /> SKYHOST
        </div>
        <div className="rounded-lg border border-line bg-panel p-6">
          <h1 className="mb-5 text-lg font-semibold">{title}</h1>
          {children}
        </div>
        {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
        <p className="mt-8 text-center text-xs text-faint">SKYHOST by SYRIX VISION COMPANY</p>
      </div>
    </div>
  );
}

function OAuthButtons() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ["auth-providers"], queryFn: () => get<{ github: boolean; gitlab: boolean }>("/auth/providers") });
  const ref = (() => {
    try {
      return localStorage.getItem("sh-ref") ?? "";
    } catch {
      return "";
    }
  })();
  if (!data?.github && !data?.gitlab) return null;
  return (
    <div className="mt-4 space-y-2 border-t border-line pt-4">
      {data.github && (
        <a href={`/api/v1/auth/oauth/github/start${ref ? `?ref=${ref}` : ""}`} className="flex h-9 w-full items-center justify-center rounded-md border border-line text-sm hover:bg-panel-2">
          {t("auth.withGithub")}
        </a>
      )}
      {data.gitlab && (
        <a href={`/api/v1/auth/oauth/gitlab/start${ref ? `?ref=${ref}` : ""}`} className="flex h-9 w-full items-center justify-center rounded-md border border-line text-sm hover:bg-panel-2">
          {t("auth.withGitlab")}
        </a>
      )}
    </div>
  );
}

export default function Auth({ mode }: { mode: "login" | "signup" | "forgot" | "reset" | "verify" | "referral" }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { me, refresh } = useSession();
  const { code } = useParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [terms, setTerms] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(params.get("challenge"));
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(params.get("error"));
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rawNext = params.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/\\") ? rawNext : "/";

  useEffect(() => {
    if (mode === "referral" && code) {
      try {
        localStorage.setItem("sh-ref", code);
      } catch {
        /* ignore */
      }
      void post(`/public/referrals/${code}/click`).finally(() => nav("/signup", { replace: true }));
    }
    if (mode === "verify") {
      const token = params.get("token");
      if (token)
        post("/auth/verify-email", { token })
          .then(() => {
            setInfo("Your email is verified. You can deploy now.");
            refresh();
          })
          .catch((e) => setError(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (me && (mode === "login" || mode === "signup")) nav(next, { replace: true });
  }, [me, mode, nav, next]);

  const submit = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "referral") return <Shell title="Joining SKYHOST…"><p className="text-sm text-muted">Redirecting…</p></Shell>;

  if (mode === "verify")
    return (
      <Shell title="Email verification">
        {info && <Alert kind="success">{info}</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        {!info && !error && <p className="text-sm text-muted">Verifying…</p>}
        <Link to="/" className="mt-4 block text-sm text-accent">
          Go to the dashboard
        </Link>
      </Shell>
    );

  if (mode === "forgot")
    return (
      <Shell title="Reset your password" footer={<Link to="/login" className="text-accent">{t("auth.login")}</Link>}>
        {info ? (
          <Alert kind="success">{info}</Alert>
        ) : (
          <form onSubmit={submit(async () => {
            await post("/auth/forgot-password", { email });
            setInfo("If an account exists for this address, we sent a reset link.");
          })} className="space-y-4">
            <Field label={t("auth.email")}>
              <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {error && <Alert kind="error">{error}</Alert>}
            <Button variant="primary" className="w-full" loading={busy}>
              Send reset link
            </Button>
          </form>
        )}
      </Shell>
    );

  if (mode === "reset")
    return (
      <Shell title="Choose a new password">
        {info ? (
          <Alert kind="success">
            {info} <Link to="/login" className="text-accent">{t("auth.login")}</Link>
          </Alert>
        ) : (
          <form onSubmit={submit(async () => {
            await post("/auth/reset-password", { token: params.get("token"), password });
            setInfo("Password updated. All devices were signed out.");
          })} className="space-y-4">
            <Field label={t("auth.password")} hint="At least 10 characters, letters and numbers">
              <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <Alert kind="error">{error}</Alert>}
            <Button variant="primary" className="w-full" loading={busy}>
              {t("common.save")}
            </Button>
          </form>
        )}
      </Shell>
    );

  if (challenge)
    return (
      <Shell title={t("auth.twoFactor")}>
        <form onSubmit={submit(async () => {
          await post("/auth/2fa/login", { challenge, code: otp, deviceId: deviceId() });
          refresh();
        })} className="space-y-4">
          <Field label={t("auth.code")}>
            <Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} />
          </Field>
          {error && <Alert kind="error">{error}</Alert>}
          <Button variant="primary" className="w-full" loading={busy}>
            {t("common.confirm")}
          </Button>
          <button type="button" onClick={() => setChallenge(null)} className="text-sm text-muted hover:text-fg">
            {t("common.back")}
          </button>
        </form>
      </Shell>
    );

  if (mode === "signup")
    return (
      <Shell title={t("auth.signup")} footer={<>{t("auth.haveAccount")} <Link to="/login" className="text-accent">{t("auth.login")}</Link></>}>
        <form onSubmit={submit(async () => {
          let referralCode: string | undefined;
          try {
            referralCode = localStorage.getItem("sh-ref") ?? undefined;
          } catch {
            /* ignore */
          }
          await post("/auth/signup", { email, password, name, acceptTerms: terms, referralCode, deviceId: deviceId() });
          refresh();
        })} className="space-y-4">
          <Field label={t("auth.name")}>
            <Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("auth.email")}>
            <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t("auth.password")} hint="At least 10 characters, letters and numbers">
            <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5" required />
            <span>
              {t("auth.terms")} (
              <Link to="/terms" className="text-accent" target="_blank">terms</Link>, <Link to="/privacy" className="text-accent" target="_blank">privacy</Link>)
            </span>
          </label>
          {error && <Alert kind="error">{error}</Alert>}
          <Button variant="primary" className="w-full" loading={busy} disabled={!terms}>
            {t("auth.signup")}
          </Button>
        </form>
        <OAuthButtons />
      </Shell>
    );

  return (
    <Shell title={t("auth.login")} footer={<>{t("auth.noAccount")} <Link to="/signup" className="text-accent">{t("auth.signup")}</Link></>}>
      <form onSubmit={submit(async () => {
        const r = await post<{ twoFactorRequired?: boolean; challenge?: string }>("/auth/login", { email, password, deviceId: deviceId() });
        if (r.twoFactorRequired) setChallenge(r.challenge!);
        else refresh();
      })} className="space-y-4">
        <Field label={t("auth.email")}>
          <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("auth.password")}>
          <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <Alert kind="error">{error}</Alert>}
        <Button variant="primary" className="w-full" loading={busy}>
          {t("auth.login")}
        </Button>
        <Link to="/forgot-password" className="block text-center text-sm text-muted hover:text-fg">
          {t("auth.forgot")}
        </Link>
      </form>
      <OAuthButtons />
    </Shell>
  );
}
