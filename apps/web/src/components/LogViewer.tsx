import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play } from "lucide-react";
import { Button, cx, Input, Select } from "./ui";
import { t } from "../lib/i18n";

export interface LogLine {
  id?: string | number;
  ts?: string;
  line: string;
  level?: string;
  stream?: string;
}

const levelOf = (l: LogLine) => l.level ?? (/\b(error|fatal|exception|failed)\b/i.test(l.line) ? "error" : /\bwarn/i.test(l.line) ? "warn" : "info");

/** Terminal-like log viewer with search, level filter, auto-scroll and download. */
export function LogViewer({ lines, height = 480, onDownload, live }: { lines: LogLine[]; height?: number; onDownload?: () => void; live?: boolean }) {
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("");
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const s = q.toLowerCase();
    return lines.filter((l) => (!s || l.line.toLowerCase().includes(s)) && (!level || levelOf(l) === level));
  }, [lines, q, level]);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [filtered, follow]);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Input placeholder={t("Search logs…")} value={q} onChange={(e) => setQ(e.target.value)} className="h-8 max-w-xs" />
        <Select value={level} onChange={(e) => setLevel(e.target.value)} className="h-8 w-32">
          <option value="">{t("All levels")}</option>
          <option value="error">{t("Errors")}</option>
          <option value="warn">{t("Warnings")}</option>
          <option value="info">{t("Info")}</option>
        </Select>
        {live && <span className="flex items-center gap-1.5 text-xs text-green-500"><span className="size-1.5 animate-pulse rounded-full bg-green-500" /> {t("Live")}</span>}
        <span className="ml-auto text-xs text-muted">{filtered.length} {t("lines")}</span>
        <Button size="sm" variant="ghost" onClick={() => setFollow(!follow)} aria-label={t("Auto-scroll")}>
          {follow ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} {follow ? t("Following") : t("Paused")}
        </Button>
        {onDownload && <Button size="sm" variant="ghost" onClick={onDownload}><Download className="size-3.5" /> {t("Download")}</Button>}
      </div>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          if (!atBottom && follow) setFollow(false);
        }}
        style={{ height }}
        className="overflow-y-auto bg-[#07080a] p-3 font-mono text-xs leading-5 text-zinc-300"
        role="log"
        aria-live="off"
      >
        {filtered.map((l, i) => {
          const lv = levelOf(l);
          return (
            <div key={l.id ?? i} className={cx("whitespace-pre-wrap break-all", lv === "error" && "text-red-400", lv === "warn" && "text-amber-300")}>
              {l.ts && <span className="mr-2 select-none text-zinc-600">{new Date(l.ts).toLocaleTimeString()}</span>}
              {l.line}
            </div>
          );
        })}
        {!filtered.length && <div className="text-zinc-600">{t("No log lines yet.")}</div>}
      </div>
    </div>
  );
}
