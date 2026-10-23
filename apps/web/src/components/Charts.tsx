import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBytes } from "@skyhost/shared";

export function MetricChart({ data, dataKey, title, unit, color = "var(--sh-brand)", formatter }: { data: Array<Record<string, unknown>>; dataKey: string; title: string; unit?: string; color?: string; formatter?: (v: number) => string }) {
  const fmt = formatter ?? ((v: number) => `${Math.round(v * 10) / 10}${unit ?? ""}`);
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
            <CartesianGrid stroke="var(--sh-line)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--sh-faint)" }} minTickGap={40} />
            <YAxis tick={{ fontSize: 10, fill: "var(--sh-faint)" }} width={48} tickFormatter={(v) => fmt(Number(v))} />
            <Tooltip contentStyle={{ background: "var(--sh-panel)", border: "1px solid var(--sh-line)", fontSize: 12 }} formatter={(v) => fmt(Number(v))} />
            <Area type="monotone" dataKey={dataKey} stroke={color} fill={color} fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export const bytesFmt = (v: number) => formatBytes(v);
