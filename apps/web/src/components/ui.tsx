import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { clsx } from "clsx";
import { AlertTriangle, Check, Copy, Inbox, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export const cx = clsx;

// ------------------------------------------------------------------------------------------- Buttons & inputs
type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-accent text-white hover:bg-accent-hover",
        variant === "secondary" && "border border-line bg-panel text-fg hover:bg-panel-2",
        variant === "ghost" && "text-muted hover:bg-panel-2 hover:text-fg",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const fieldCls = "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(fieldCls, "h-9", className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(fieldCls, className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(fieldCls, "h-9", className)}>
      {children}
    </select>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block space-y-1.5", className)}>
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-500">{error}</span> : hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2 text-sm", disabled && "opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-accent" : "bg-line")}
      >
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
      </button>
      {label}
    </label>
  );
}

// ------------------------------------------------------------------------------------------- Layout
export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("rounded-lg border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumbs?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumbs && <div className="mb-1 text-xs text-muted">{breadcrumbs}</div>}
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors", value === t.id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- Status
const STATUS_COLORS: Record<string, string> = {
  live: "bg-green-500/15 text-green-600 dark:text-green-400",
  running: "bg-green-500/15 text-green-600 dark:text-green-400",
  available: "bg-green-500/15 text-green-600 dark:text-green-400",
  completed: "bg-green-500/15 text-green-600 dark:text-green-400",
  succeeded: "bg-green-500/15 text-green-600 dark:text-green-400",
  verified: "bg-green-500/15 text-green-600 dark:text-green-400",
  ssl_issued: "bg-green-500/15 text-green-600 dark:text-green-400",
  up: "bg-green-500/15 text-green-600 dark:text-green-400",
  active: "bg-green-500/15 text-green-600 dark:text-green-400",
  paid: "bg-green-500/15 text-green-600 dark:text-green-400",
  approved: "bg-green-500/15 text-green-600 dark:text-green-400",
  building: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  deploying: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  provisioning: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  restoring: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  running_job: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  queued: "bg-zinc-500/15 text-muted",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  sleeping: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  past_due: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  held: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  flagged: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  trialing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  crashed: "bg-red-500/15 text-red-600 dark:text-red-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
  down: "bg-red-500/15 text-red-600 dark:text-red-400",
  suspended: "bg-red-500/15 text-red-600 dark:text-red-400",
  timeout: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const { t } = useTranslation();
  const color = STATUS_COLORS[status] ?? "bg-zinc-500/15 text-muted";
  const animated = ["building", "deploying", "provisioning", "restoring"].includes(status);
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium", color)} data-status={status}>
      <span className={cx("size-1.5 rounded-full bg-current", animated && "animate-pulse")} />
      {label ?? t(`status.${status}`, status.replace(/_/g, " "))}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center rounded border border-line px-1.5 py-0.5 text-xs text-muted", className)}>{children}</span>;
}

// ------------------------------------------------------------------------------------------- Feedback
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton h-4", className)} />;
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <div className="mb-3 text-faint">{icon ?? <Inbox className="size-8" />}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
      <div className="flex-1">
        <p className="font-medium">{t("common.error")}</p>
        <p className="mt-0.5 text-muted">{(error as Error)?.message ?? String(error)}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

export function Alert({ kind = "info", children }: { kind?: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  return (
    <div
      className={cx(
        "rounded-md border px-3 py-2 text-sm",
        kind === "info" && "border-blue-500/30 bg-blue-500/5",
        kind === "warn" && "border-amber-500/30 bg-amber-500/5",
        kind === "error" && "border-red-500/30 bg-red-500/5",
        kind === "success" && "border-green-500/30 bg-green-500/5",
      )}
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- Modals
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input,textarea,select,button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className={cx("w-full rounded-lg border border-line bg-panel shadow-xl", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Destructive confirmation that requires typing the resource name. */
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmText, typeToConfirm, loading, danger = true }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; description: ReactNode; confirmText?: string; typeToConfirm?: string; loading?: boolean; danger?: boolean }) {
  const [typed, setTyped] = useState("");
  const { t } = useTranslation();
  useEffect(() => setTyped(""), [open]);
  const ok = !typeToConfirm || typed === typeToConfirm;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={!ok} loading={loading} onClick={onConfirm}>
            {confirmText ?? t("common.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <div>{description}</div>
        {typeToConfirm && (
          <Field label={<span>Type <code className="rounded bg-panel-2 px-1 font-mono text-fg">{typeToConfirm}</code> to confirm</span>}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------- Toasts
interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
}
const ToastCtx = createContext<(kind: Toast["kind"], message: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("rounded-md border bg-panel px-3 py-2 text-sm shadow-lg", t.kind === "error" ? "border-red-500/40" : t.kind === "success" ? "border-green-500/40" : "border-line")}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------------------------------- Misc
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      variant="ghost"
      type="button"
      onClick={async () => {
        await navigator.clipboard?.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      aria-label={label ?? t("common.copy")}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {label && (done ? t("common.copied") : label)}
    </Button>
  );
}

export function CodeField({ value, secret }: { value: string; secret?: boolean }) {
  const [show, setShow] = useState(!secret);
  return (
    <div className="flex items-center gap-1 rounded-md border border-line bg-bg px-2 py-1.5">
      <code className="flex-1 truncate font-mono text-xs">{show ? value : "•".repeat(Math.min(value.length, 32))}</code>
      {secret && (
        <Button size="sm" variant="ghost" onClick={() => setShow(!show)}>
          {show ? "Hide" : "Show"}
        </Button>
      )}
      <CopyButton value={value} />
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span>
          {value} / {max}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-panel-2">
        <div className={cx("h-full rounded-full", pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-accent")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function timeAgo(d: string | Date | null | undefined) {
  if (!d) return "–";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
