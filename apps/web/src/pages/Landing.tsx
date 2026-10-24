import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Database, GitBranch, LifeBuoy, RotateCcw, ScanSearch, ShieldCheck, Sparkles, Stethoscope, Wand2 } from "lucide-react";
import { formatCents } from "@skyhost/shared";
import { get } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { t } from "../lib/i18n";
import { limitLabel, limitValue } from "../lib/labels";
import { Logo } from "../components/Logo";
import { DeployIllustration } from "./Auth";

interface PublicPlan { id: string; name: string; priceCents: number; currency: string; interval: string; isFree: boolean; isContactSales: boolean; limits: Record<string, number> }

const FEATURES = [
  { icon: Sparkles, phoneIcon: ScanSearch, title: "SmartDeploy", text: "Detects Next.js, Node, Python, Go, PHP, Java, static sites and Dockerfiles: no configuration file to write." },
  { icon: RotateCcw, title: "Zero-downtime releases", text: "Every release is health-checked before it receives traffic. One click rolls back." },
  { icon: Wand2, phoneIcon: Stethoscope, title: "Smart Error Analyzer", text: "When a build or an app fails, you get the cause and the fix, by email too." },
  { icon: Database, title: "Managed databases", text: "PostgreSQL, MySQL, MongoDB and Redis with verified backups, in seconds." },
  { icon: ShieldCheck, title: "Secure by default", text: "Isolated containers, encrypted secrets, HTTPS everywhere, firewall and 2FA." },
  { icon: Activity, title: "Logs, metrics, alerts", text: "Live logs, CPU and memory charts, uptime checks and alerts where you are." },
] as const;

const STEPS = [
  ["Connect", "Sign in with GitHub and pick a repository, or upload a ZIP."],
  ["Deploy", "SKYHOST builds your app and gives it a live HTTPS address."],
  ["Grow", "Add a database, a custom domain and teammates. Every push redeploys."],
] as const;

const HIGHLIGHT = ["projects", "services", "databases", "memoryMb"];

/** Public home page for visitors who are not signed in. */
export default function Landing() {
  const caps = useCapabilities();
  // Only the payment methods that are actually configured are advertised.
  const methods = [caps.payments.stripe && t("card"), caps.payments.paypal && t("PayPal"), caps.payments.mobileMoney && t("Mobile Money")].filter(Boolean) as string[];
  const payWith = methods.length ? [...methods, t("prepaid credits")].join(", ") : "";
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<{ plans: PublicPlan[] }>("/plans") });
  const nav = "text-sm text-muted transition-colors hover:text-fg";
  return (
    <div className="min-h-full bg-bg text-fg">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link to="/"><Logo size="sm" /></Link>
          <nav className="hidden items-center gap-5 sm:flex">
            <a href="#features" className={nav}>{t("Features")}</a>
            <a href="#pricing" className={nav}>{t("Pricing")}</a>
            <Link to="/docs" className={nav}>{t("Docs")}</Link>
            <Link to="/status" className={nav}>{t("Status")}</Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/login" className="rounded-md px-3 py-1.5 text-sm hover:bg-panel-2">{t("auth.login")}</Link>
            <Link to="/signup" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover">{t("Get started")}</Link>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 md:grid-cols-2 md:py-24">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-muted"><span className="size-1.5 rounded-full bg-emerald-500" />{t("Cloud hosting by SYRIX VISION COMPANY")}</p>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">{t("Push your code. Get a live URL.")}</h1>
            <p className="mt-5 max-w-lg text-lg text-muted">{t("SKYHOST builds and runs your apps, websites, APIs, bots and databases, with HTTPS, logs and automatic deployments. No server to manage.")}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/signup" className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg hover:bg-accent-hover">{t("Deploy for free")}</Link>
              <a href="#pricing" className="rounded-md border border-line-strong px-5 py-2.5 text-sm font-medium hover:bg-panel-2">{t("See pricing")}</a>
            </div>
            <p className="mt-4 text-xs text-faint">{t("Free plan, no credit card required.")}</p>
          </div>
          <div className="rounded-xl border border-line bg-panel p-1 shadow-sm"><DeployIllustration /></div>
        </section>

        <section id="features" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">{t("Everything to ship, nothing to maintain")}</h2>
            <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="bg-bg p-6">
                  {/* No "magic" sparkle icons on phones: plain icons there, the illustrated ones on computers. */}
                  {"phoneIcon" in f ? <><f.phoneIcon className="size-5 md:hidden" aria-hidden /><f.icon className="hidden size-5 md:block" aria-hidden /></> : <f.icon className="size-5" aria-hidden />}
                  <h3 className="mt-4 font-medium">{t(f.title)}</h3>
                  <p className="mt-1.5 text-sm text-muted">{t(f.text)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">{t("Live in three steps")}</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-3">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="rounded-lg border border-line p-6">
                  <span className="font-mono text-xs text-faint">0{i + 1}</span>
                  <h3 className="mt-2 font-medium">{t(title)}</h3>
                  <p className="mt-1.5 text-sm text-muted">{t(text)}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 flex items-center gap-2 text-sm text-muted"><GitBranch className="size-4" aria-hidden /> {t("Works with GitHub, GitLab, Bitbucket, any public Git URL, ZIP files and Docker images.")}</p>
          </div>
        </section>

        <section id="pricing" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">{t("Simple pricing")}</h2>
            <p className="mt-2 text-sm text-muted">{t("Start free. Upgrade when your project grows.")}{payWith && ` ${t("Pay with {{methods}}.", { methods: payWith })}`}</p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {(plans.data?.plans ?? []).filter((p) => !p.isContactSales).slice(0, 4).map((p) => (
                <div key={p.id} className="flex flex-col rounded-lg border border-line p-5">
                  <h3 className="font-medium">{p.name}</h3>
                  <div className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">{p.isFree ? t("Free") : formatCents(p.priceCents, p.currency.toUpperCase())}{!p.isFree && <span className="text-sm font-normal text-muted"> /{p.interval}</span>}</div>
                  <ul className="mt-4 flex-1 space-y-1.5 text-sm text-muted">
                    {HIGHLIGHT.filter((k) => k in p.limits).map((k) => <li key={k}>{limitLabel(k)}: <span className="text-fg">{limitValue(k, p.limits[k]!)}</span></li>)}
                  </ul>
                  <Link to="/signup" className="mt-5 rounded-md border border-line-strong py-2 text-center text-sm font-medium hover:bg-panel-2">{p.isFree ? t("Start free") : t("Choose")}</Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-4 py-16">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">{t("Your next deploy is one push away.")}</h2>
              <p className="mt-2 text-sm text-muted">{t("Create an account and deploy your first project in a few minutes.")}</p>
            </div>
            <Link to="/signup" className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg hover:bg-accent-hover">{t("Get started")}</Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-8 text-xs text-faint">
          <span>© {new Date().getFullYear()} SKYHOST by SYRIX VISION COMPANY</span>
          <Link to="/docs" className="hover:text-fg">{t("Docs")}</Link>
          <Link to="/terms" className="hover:text-fg">{t("Terms of service")}</Link>
          <Link to="/privacy" className="hover:text-fg">{t("Privacy")}</Link>
          <Link to="/status" className="hover:text-fg">{t("Status")}</Link>
          <Link to="/report-abuse" className="hover:text-fg">{t("Report abuse")}</Link>
          {caps.support.email && <a href={`mailto:${caps.support.email}`} className="inline-flex items-center gap-1 hover:text-fg"><LifeBuoy className="size-3" aria-hidden /> {caps.support.email}</a>}
        </div>
      </footer>
    </div>
  );
}
