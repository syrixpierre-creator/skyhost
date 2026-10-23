import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { post } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Button, cx, Field, Input, Unavailable } from "../components/ui";
import { Logo } from "../components/Logo";
import { useCapabilities } from "../lib/capabilities";
import { Eye, EyeOff } from "lucide-react";
import { t } from "../lib/i18n";

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

function ProviderIcon({ id }: { id: "github" | "google" | "gitlab" }) {
  if (id === "github")
    return (
      <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  if (id === "google")
    return (
      <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#E24329" d="m12 21.4 3.7-11.3H8.3z" />
      <path fill="#FC6D26" d="M12 21.4 8.3 10.1H3.1z" />
      <path fill="#FCA326" d="m3.1 10.1-1.1 3.5c-.1.3 0 .7.3.9l9.7 6.9z" />
      <path fill="#E24329" d="M3.1 10.1h5.2L6.1 3.2c-.1-.4-.6-.4-.7 0z" />
      <path fill="#FC6D26" d="m12 21.4 3.7-11.3h5.2z" />
      <path fill="#FCA326" d="m20.9 10.1 1.1 3.5c.1.3 0 .7-.3.9L12 21.4z" />
      <path fill="#E24329" d="M20.9 10.1h-5.2l2.2-6.9c.1-.4.6-.4.7 0z" />
    </svg>
  );
}

/** Illustration of a deployment (decorative): the steps SKYHOST performs after a push. */
function DeployIllustration() {
  const steps = [
    { label: "git push origin main", tone: "muted" },
    { label: t("SmartDeploy: Next.js · pnpm · port 3000 · high confidence"), tone: "fg" },
    { label: t("Building with BuildKit (secrets mounted, never baked)"), tone: "fg" },
    { label: t("Health check passed: GET / 200"), tone: "fg" },
    { label: t("Live at https://acme-shop.skyhost.app · previous version drained"), tone: "ok" },
  ] as const;
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(reduce ? steps.length : 1);
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setShown((n) => (n >= steps.length + 3 ? 1 : n + 1)), 900);
    return () => clearInterval(id);
  }, [reduce, steps.length]);
  return (
    <div aria-hidden className="rounded-lg border border-line bg-bg/80 font-mono text-[12.5px] shadow-[0_1px_0_0_var(--sh-line)]">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="ml-2 text-[11px] text-faint">acme-shop · production</span>
      </div>
      <ol className="space-y-1.5 px-4 py-3">
        {steps.map((s, i) => (
          <li key={i} className={cx("flex items-start gap-2 transition-opacity duration-500", i < shown ? "opacity-100" : "opacity-0")}>
            <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", i === 0 ? "bg-faint" : s.tone === "ok" ? "bg-emerald-500" : i === shown - 1 && i < steps.length - 1 ? "animate-pulse bg-sky-500" : "bg-fg")} />
            <span className={s.tone === "muted" ? "text-muted" : s.tone === "ok" ? "text-emerald-500" : "text-fg"}>{i === 0 ? `$ ${s.label}` : s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Shell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const support = useCapabilities().support.email;
  return (
    <div className="flex min-h-full bg-bg">
      <aside className="auth-grid relative hidden w-[46%] max-w-[720px] flex-col justify-between overflow-hidden border-r border-line bg-panel p-10 lg:flex xl:p-14">
        <Link to="/" className="relative">
          <Logo />
        </Link>
        <div className="relative space-y-8">
          <div className="space-y-4">
            <h2 className="max-w-md text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.035em]">{t("Push your code. Get a live URL.")}</h2>
            <p className="max-w-md text-[15px] leading-relaxed text-muted">{t("SKYHOST reads your repository, builds it, ships it with zero downtime and tells you exactly what went wrong when something does.")}</p>
          </div>
          <DeployIllustration />
        </div>
        <ul className="relative grid grid-cols-3 gap-6 text-sm">
          {[
            [t("SmartDeploy"), t("Detects your stack, port, variables and databases.")],
            [t("Zero downtime"), t("Health-checked releases and one-click rollbacks.")],
            [t("Managed data"), t("PostgreSQL, MariaDB, MongoDB, Redis with verified backups.")],
          ].map(([h, d]) => (
            <li key={h}>
              <div className="font-medium">{h}</div>
              <div className="mt-1 text-xs leading-relaxed text-muted">{d}</div>
            </li>
          ))}
        </ul>
      </aside>
      <main className="flex flex-1 flex-col px-6 py-10 sm:px-10">
        <div className="lg:hidden">
          <Link to="/"><Logo /></Link>
        </div>
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-10">
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.03em]">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-muted">{footer}</div>}
        </div>
        <p className="text-xs text-faint">
          {t("SKYHOST by SYRIX VISION COMPANY")} · <Link to="/terms" className="hover:text-fg">{t("Terms of service")}</Link> · <Link to="/privacy" className="hover:text-fg">{t("Privacy")}</Link> · <Link to="/status" className="hover:text-fg">{t("Status")}</Link>
          {support && <> · <a href={`mailto:${support}`} className="hover:text-fg">{t("Support")}</a></>}
        </p>
      </main>
    </div>
  );
}

function OAuthButtons() {
  const caps = useCapabilities();
  const ref = (() => {
    try {
      return localStorage.getItem("sh-ref") ?? "";
    } catch {
      return "";
    }
  })();
  const providers: Array<{ id: "github" | "google" | "gitlab"; label: string; on: boolean; always: boolean }> = [
    { id: "github", label: t("Continue with GitHub"), on: caps.auth.github, always: true },
    { id: "google", label: t("Continue with Google"), on: caps.auth.google, always: true },
    { id: "gitlab", label: t("Continue with GitLab"), on: caps.auth.gitlab, always: false },
  ];
  const btn = "flex h-10 w-full items-center gap-2.5 rounded-md border px-3.5 text-sm font-medium transition-colors";
  return (
    <div className="space-y-2.5">
      {providers
        .filter((p) => p.on || p.always)
        .map((p) =>
          p.on ? (
            <a key={p.id} href={`/api/v1/auth/oauth/${p.id}/start${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`} className={cx(btn, "border-line-strong hover:border-faint hover:bg-panel-2")}>
              <ProviderIcon id={p.id} /> {p.label}
            </a>
          ) : (
            <div key={p.id} aria-disabled className={cx(btn, "cursor-not-allowed border-line text-faint")} title={t("Not available yet")}>
              <span className="opacity-50"><ProviderIcon id={p.id} /></span> {p.label}
              <Unavailable className="ml-auto" />
            </div>
          ),
        )}
      <div className="flex items-center gap-3 py-3 text-xs uppercase tracking-wider text-faint">
        <span className="h-px flex-1 bg-line" /> {t("or")} <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}

function PasswordInput({ value, onChange, autoComplete, showStrength }: { value: string; onChange: (v: string) => void; autoComplete: string; showStrength?: boolean }) {
  const [visible, setVisible] = useState(false);
  const checks = [value.length >= 10, /[a-zA-Z]/.test(value), /\d/.test(value)];
  const score = checks.filter(Boolean).length;
  return (
    <div>
      <div className="relative">
        <Input type={visible ? "text" : "password"} required minLength={10} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} className="pr-10" />
        <button type="button" onClick={() => setVisible(!visible)} className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint hover:text-fg" aria-label={t("Toggle visibility")}>
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {showStrength && value && (
        <div className="mt-2 flex items-center gap-2" aria-live="polite">
          <div className="flex flex-1 gap-1">
            {[0, 1, 2].map((i) => <span key={i} className={cx("h-1 flex-1 rounded-full", i < score ? (score === 3 ? "bg-emerald-500" : "bg-amber-500") : "bg-line")} />)}
          </div>
          <span className="text-xs text-muted">{score === 3 ? t("Strong enough") : t("10+ characters with letters and numbers")}</span>
        </div>
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

  if (mode === "referral") return <Shell title={t("Joining SKYHOST…")}><p className="text-sm text-muted">{t("Redirecting…")}</p></Shell>;

  if (mode === "verify")
    return (
      <Shell title={t("Email verification")}>
        {info && <Alert kind="success">{info}</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        {!info && !error && <p className="text-sm text-muted">{t("Verifying…")}</p>}
        <Link to="/" className="mt-4 block text-sm font-medium underline underline-offset-4">
          {t("Go to the dashboard")}
        </Link>
      </Shell>
    );

  if (mode === "forgot")
    return (
      <Shell title={t("Reset your password")} footer={<Link to="/login" className="font-medium text-fg underline-offset-4 hover:underline">{t("auth.login")}</Link>}>
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
              {t("Send reset link")}
            </Button>
          </form>
        )}
      </Shell>
    );

  if (mode === "reset")
    return (
      <Shell title={t("Choose a new password")}>
        {info ? (
          <Alert kind="success">
            {info} <Link to="/login" className="font-medium underline">{t("auth.login")}</Link>
          </Alert>
        ) : (
          <form onSubmit={submit(async () => {
            await post("/auth/reset-password", { token: params.get("token"), password });
            setInfo("Password updated. All devices were signed out.");
          })} className="space-y-4">
            <Field label={t("auth.password")} hint={t("At least 10 characters, letters and numbers")}>
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
      <Shell title={t("Create your account")} subtitle={t("Deploy your first project in a few minutes.")} footer={<>{t("auth.haveAccount")} <Link to="/login" className="font-medium text-fg underline-offset-4 hover:underline">{t("auth.login")}</Link></>}>
        <OAuthButtons />
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
          <Field label={t("auth.password")}>
            <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" showStrength />
          </Field>
          <label className="flex items-start gap-2.5 text-sm text-muted">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 accent-current" required />
            <span>
              {t("auth.terms")} (
              <Link to="/terms" className="text-fg underline underline-offset-2" target="_blank">{t("terms")}</Link>, <Link to="/privacy" className="text-fg underline underline-offset-2" target="_blank">{t("privacy")}</Link>)
            </span>
          </label>
          {error && <Alert kind="error">{error}</Alert>}
          <Button variant="primary" className="h-10 w-full" loading={busy} disabled={!terms}>
            {t("auth.signup")}
          </Button>
        </form>
      </Shell>
    );

  return (
    <Shell title={t("Welcome back")} subtitle={t("Sign in to your SKYHOST workspace.")} footer={<>{t("auth.noAccount")} <Link to="/signup" className="font-medium text-fg underline-offset-4 hover:underline">{t("auth.signup")}</Link></>}>
      <OAuthButtons />
      <form onSubmit={submit(async () => {
        const r = await post<{ twoFactorRequired?: boolean; challenge?: string }>("/auth/login", { email, password, deviceId: deviceId() });
        if (r.twoFactorRequired) setChallenge(r.challenge!);
        else refresh();
      })} className="space-y-4">
        <Field label={t("auth.email")}>
          <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={<span className="flex items-center justify-between">{t("auth.password")} <Link to="/forgot-password" className="text-xs font-normal text-muted hover:text-fg">{t("auth.forgot")}</Link></span>}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {error && <Alert kind="error">{error}</Alert>}
        <Button variant="primary" className="h-10 w-full" loading={busy}>
          {t("auth.login")}
        </Button>
      </form>
    </Shell>
  );
}
