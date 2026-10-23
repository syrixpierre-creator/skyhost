import type { ReactNode } from "react";
import { Wrench } from "lucide-react";
import { useCapabilities } from "../lib/capabilities";
import { t } from "../lib/i18n";
import { Logo } from "./Logo";

/** Full page shown to non-administrators while the dashboard is closed for maintenance. */
export function MaintenanceScreen({ children }: { children?: ReactNode }) {
  const caps = useCapabilities();
  const m = caps.maintenance;
  const ends = m.endsAt ? new Date(m.endsAt) : null;
  return (
    <div className="flex min-h-full flex-col bg-bg px-6 py-10">
      <Logo />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-12 text-center">
        <div className="mx-auto mb-6 flex size-12 items-center justify-center rounded-full border border-line-strong">
          <Wrench className="size-5" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("We'll be back soon")}</h1>
        <p className="mt-3 text-sm text-muted">{t("SKYHOST is under maintenance. Your applications and databases keep running.")}</p>
        {m.message && <p className="mt-4 rounded-md border border-line bg-panel-2 px-4 py-3 text-sm">{m.message}</p>}
        {ends && ends.getTime() > Date.now() && <p className="mt-4 text-sm text-muted">{t("Expected end: {{time}}", { time: ends.toLocaleString() })}</p>}
        {caps.support.email && (
          <p className="mt-6 text-xs text-faint">
            {t("Questions?")} <a href={`mailto:${caps.support.email}`} className="underline underline-offset-4 hover:text-fg">{caps.support.email}</a>
          </p>
        )}
        {children && <div className="mt-8">{children}</div>}
      </main>
    </div>
  );
}

export function useDashboardClosed() {
  const m = useCapabilities().maintenance;
  return !!(m.enabled && m.closeDashboard);
}
