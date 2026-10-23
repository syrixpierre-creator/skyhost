import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { formatBytes } from "@skyhost/shared";
import { del, download, get, patch, post } from "../lib/api";
import { useRealtimeInvalidate } from "../lib/session";
import { MetricChart, bytesFmt } from "../components/Charts";
import { Alert, Badge, Button, Card, CodeField, ConfirmDialog, EmptyState, ErrorState, Field, Input, LoadingRows, PageHeader, Select, StatusBadge, Tabs, Textarea, Toggle, timeAgo, useToast } from "../components/ui";
import { t } from "../lib/i18n";
import { ProjectCrumb } from "../components/ProjectCrumb";

interface Db {
  id: string;
  projectId: string;
  name: string;
  engine: string;
  version: string;
  status: string;
  internalHost: string;
  port: number;
  dbName: string;
  username: string;
  storageMb: number;
  publicAccess: boolean;
  publicPort: number | null;
  ipAllowlist: string[];
  deletionProtection: boolean;
  backupSchedule: string;
  backupRetentionDays: number;
  backupsEnabled: boolean;
  error: string | null;
  readyAt: string | null;
  regionId: string;
}

type Tab = "overview" | "connections" | "credentials" | "data" | "backups" | "metrics" | "logs" | "settings" | "danger";

function DataBrowser({ db }: { db: Db }) {
  const tables = useQuery({ queryKey: ["tables", db.id], queryFn: () => get<{ tables: string[] }>(`/databases/${db.id}/tables`), enabled: db.status === "available" });
  const sqlEngine = db.engine === "postgres" || db.engine === "mariadb";
  const [query, setQuery] = useState(sqlEngine ? "select 1" : db.engine === "redis" ? "SCAN 0 COUNT 50" : "{}");
  const [collection, setCollection] = useState("");
  const run = useMutation({
    mutationFn: () =>
      post<{ result?: { columns: string[]; rows: Array<Array<string | null>>; truncated: boolean }; documents?: unknown[]; output?: string }>(`/databases/${db.id}/query`, sqlEngine ? { sql: query } : db.engine === "mongodb" ? { collection, filter: query } : { command: query }),
  });
  const exportCsv = () => {
    const r = run.data?.result;
    if (!r) return;
    const csv = [r.columns, ...r.rows].map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${db.name}-query.csv`;
    a.click();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <Card title={db.engine === "mongodb" ? t("Collections") : db.engine === "redis" ? t("Keys") : t("Tables")} padded={false}>
        <ul className="max-h-[480px] overflow-y-auto py-1 text-sm">
          {tables.data?.tables.map((t) => (
            <li key={t}>
              <button
                className="w-full truncate px-3 py-1 text-left font-mono text-xs hover:bg-panel-2"
                onClick={() => {
                  if (db.engine === "postgres") setQuery(`select * from ${t.split(".").map((p) => `"${p}"`).join(".")} limit 100`);
                  else if (db.engine === "mariadb") setQuery(`select * from \`${t}\` limit 100`);
                  else if (db.engine === "mongodb") { setCollection(t); setQuery("{}"); }
                  else setQuery(`GET ${t}`);
                }}
              >
                {t}
              </button>
            </li>
          ))}
          {tables.data && !tables.data.tables.length && <li className="px-3 py-2 text-xs text-muted">{t("Empty")}</li>}
        </ul>
      </Card>
      <div className="space-y-3">
        <Alert kind="info">{t("Read-only: queries run with a dedicated read-only user. Writes are rejected by the database.")}</Alert>
        {db.engine === "mongodb" && <Field label={t("Collection")}><Input value={collection} onChange={(e) => setCollection(e.target.value)} /></Field>}
        <Textarea rows={5} className="font-mono text-xs" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("Query")} spellCheck={false} />
        <div className="flex gap-2">
          <Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}><Play className="size-3.5" /> {t("Run")}</Button>
          {run.data?.result && <Button onClick={exportCsv}>{t("Export CSV")}</Button>}
        </div>
        {run.error && <Alert kind="error">{(run.error as Error).message}</Alert>}
        {run.data?.result && (
          <div className="overflow-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="bg-panel text-left"><tr>{run.data.result.columns.map((c) => <th key={c} className="px-2 py-1.5 font-medium">{c}</th>)}</tr></thead>
              <tbody className="font-mono">{run.data.result.rows.map((r, i) => <tr key={i} className="border-t border-line">{r.map((c, j) => <td key={j} className="max-w-xs truncate px-2 py-1">{c ?? <span className="text-faint">NULL</span>}</td>)}</tr>)}</tbody>
            </table>
            {run.data.result.truncated && <p className="px-2 py-1 text-xs text-muted">{t("Showing the first 500 rows.")}</p>}
          </div>
        )}
        {run.data?.documents && <pre className="max-h-[480px] overflow-auto rounded-lg border border-line bg-panel p-3 font-mono text-xs">{JSON.stringify(run.data.documents, null, 2)}</pre>}
        {run.data?.output !== undefined && <pre className="max-h-[480px] overflow-auto rounded-lg border border-line bg-panel p-3 font-mono text-xs">{run.data.output}</pre>}
      </div>
    </div>
  );
}

function Backups({ db }: { db: Db }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["backups", db.id], queryFn: () => get<{ backups: Array<{ id: string; kind: string; status: string; sizeBytes: number | null; createdAt: string; verifiedAt: string | null; error: string | null; expiresAt: string | null }>; restores: Array<{ id: string; status: string; createdAt: string; error: string | null }> }>(`/databases/${db.id}/backups`), refetchInterval: 5000 });
  const [restore, setRestore] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <p className="text-sm text-muted">{t("Backups are encrypted and verified by a test restore before they are marked completed. Schedule:")} <code className="font-mono">{db.backupSchedule}</code> {t("(UTC), kept")} {db.backupRetentionDays} {t("days.")}</p>
        <Button variant="primary" onClick={() => post(`/databases/${db.id}/backups`).then(() => qc.invalidateQueries({ queryKey: ["backups"] })).catch((e) => toast("error", e.message))}>{t("Back up now")}</Button>
      </div>
      {q.isLoading ? <LoadingRows /> : !q.data?.backups.length ? <EmptyState title={t("No backups yet")} /> : (
        <div className="divide-y divide-line rounded-lg border border-line bg-panel">
          {q.data.backups.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <StatusBadge status={b.status === "running" ? "building" : b.status} label={b.status} />
              <span>{new Date(b.createdAt).toLocaleString()}</span>
              <Badge>{b.kind}</Badge>
              {b.sizeBytes != null && <span className="text-muted">{formatBytes(b.sizeBytes)}</span>}
              {b.verifiedAt && <span className="text-xs text-green-500">{t("restore-tested")}</span>}
              {b.error && <span className="text-xs text-red-500">{b.error}</span>}
              <span className="ml-auto flex gap-1">
                {b.status === "completed" && <Button size="sm" variant="ghost" onClick={() => download(`/backups/${b.id}/download`)}>{t("Download")}</Button>}
                {b.status === "completed" && <Button size="sm" onClick={() => setRestore(b.id)}>{t("Restore")}</Button>}
              </span>
            </div>
          ))}
        </div>
      )}
      {!!q.data?.restores.length && (
        <Card title={t("Restores")}>
          <ul className="space-y-1 text-sm">{q.data.restores.map((r) => <li key={r.id}><StatusBadge status={r.status === "running" ? "restoring" : r.status} label={r.status} /> {timeAgo(r.createdAt)} {r.error && <span className="text-red-500">{r.error}</span>}</li>)}</ul>
        </Card>
      )}
      <ConfirmDialog open={!!restore} onClose={() => setRestore(null)} title={t("Restore backup")} description={t("The current data is replaced by the backup. SKYHOST takes a safety backup first.")} typeToConfirm={db.name} confirmText={t("Restore")} onConfirm={() => post(`/backups/${restore}/restore`, { confirmName: db.name }).then(() => { setRestore(null); toast("success", t("Restore started")); void qc.invalidateQueries({ queryKey: ["backups"] }); }).catch((e) => toast("error", e.message))} />
    </div>
  );
}

const CLI: Record<string, (c: { host: string; port: number; username: string; dbName: string }, url: string) => string> = {
  postgres: (_c, url) => `psql "${url}"`,
  mariadb: (c) => `mariadb -h ${c.host} -P ${c.port} -u ${c.username} -p ${c.dbName}`,
  mongodb: (_c, url) => `mongosh "${url}"`,
  redis: (_c, url) => `redis-cli -u "${url}"`,
};

/** Everything needed to use the database from any app or tool, on the first screen (like Render). */
function ConnectionInfo({ db, creds, canSee, onPublic }: { db: Db; creds?: { host: string; port: number; username: string; password: string; dbName: string; connectionUrl: string; publicUrl: string | null }; canSee: boolean; onPublic: () => void }) {
  if (!canSee) return <Card title={t("Connection")} className="md:col-span-3"><p className="text-sm text-muted">{t("Your role cannot see the credentials of this database.")}</p></Card>;
  if (!creds) return <Card title={t("Connection")} className="md:col-span-3"><LoadingRows rows={3} /></Card>;
  return (
    <Card title={t("Connection")} className="md:col-span-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t("Hostname")}><CodeField value={creds.host} /></Field>
        <Field label={t("Port")}><CodeField value={String(creds.port)} /></Field>
        {db.engine !== "redis" && <Field label={t("Database")}><CodeField value={creds.dbName} /></Field>}
        {creds.username && <Field label={t("Username")}><CodeField value={creds.username} /></Field>}
        <Field label={t("Password")}><CodeField value={creds.password} secret /></Field>
        <div className="sm:col-span-2 lg:col-span-3"><Field label={t("Internal URL")} hint={t("For services on SKYHOST: private network, fastest and free of egress.")}><CodeField value={creds.connectionUrl} secret /></Field></div>
        <div className="sm:col-span-2 lg:col-span-3">
          {creds.publicUrl ? (
            <Field label={t("External URL")} hint={t("For your computer or apps hosted elsewhere. Only the allowed IP addresses can connect.")}><CodeField value={creds.publicUrl} secret /></Field>
          ) : (
            // Not a <label>: it holds a button, which must keep its own accessible name.
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-fg">{t("External URL")}</span>
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-3 py-2 text-sm text-muted">
                {t("Public access is off: only services on SKYHOST can connect.")}
                <Button size="sm" onClick={onPublic}>{t("Enable public access")}</Button>
              </div>
            </div>
          )}
        </div>
        <div className="sm:col-span-2 lg:col-span-3"><Field label={t("Command line")}><CodeField value={CLI[db.engine]?.(creds, creds.publicUrl ?? creds.connectionUrl) ?? creds.connectionUrl} secret /></Field></div>
      </div>
    </Card>
  );
}

export default function Database() {
  const { projectId, databaseId } = useParams();
  const { t } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");
  const q = useQuery({ queryKey: ["database", databaseId], queryFn: () => get<{ database: Db; connections: Array<{ serviceId: string; serviceName: string; variableName: string }>; permissions: string[] }>(`/databases/${databaseId}`) });
  useRealtimeInvalidate(databaseId ? `database:${databaseId}` : null, [["database", databaseId]]);
  const creds = useQuery({ queryKey: ["creds", databaseId], queryFn: () => get<{ credentials: { host: string; port: number; username: string; password: string; dbName: string; connectionUrl: string; publicUrl: string | null } }>(`/databases/${databaseId}/credentials`), enabled: (tab === "credentials" || tab === "overview") && !!q.data?.permissions.includes("database:credentials") });
  const metrics = useQuery({ queryKey: ["dbmetrics", databaseId], queryFn: () => get<{ samples: Array<{ createdAt: string; cpuPercent: number; memoryBytes: number; diskBytes: number; requests: number }>; uptimePercent: number | null }>(`/databases/${databaseId}/metrics`), enabled: tab === "metrics" || tab === "overview" });
  const logs = useQuery({ queryKey: ["dblogs", databaseId], queryFn: () => get<{ lines: string[] }>(`/databases/${databaseId}/logs`), enabled: tab === "logs" });
  const connectable = useQuery({ queryKey: ["connectable", databaseId], queryFn: () => get<{ services: Array<{ id: string; name: string; projectName: string }> }>(`/databases/${databaseId}/connectable-services`), enabled: tab === "connections" });
  const [connectTo, setConnectTo] = useState("");
  const [varName, setVarName] = useState("");
  const [settings, setSettings] = useState<Partial<Db> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const chart = useMemo(() => (metrics.data?.samples ?? []).map((s) => ({ ...s, label: new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })), [metrics.data]);
  const save = useMutation({ mutationFn: (body: Partial<Db>) => patch(`/databases/${databaseId}`, body), onSuccess: () => { toast("success", t("Saved")); void q.refetch(); }, onError: (e) => toast("error", (e as Error).message) });
  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.error) return <ErrorState error={q.error} />;
  const db = q.data!.database;
  const s = settings ?? db;
  return (
    <>
      <PageHeader breadcrumbs={<ProjectCrumb projectId={projectId!} />} title={<span className="flex items-center gap-3">{db.name} <StatusBadge status={db.status} /></span>} subtitle={`${db.engine} ${db.version} · ${db.regionId} · ${db.internalHost}:${db.port}`} />
      {db.error && <div className="mb-4"><Alert kind="error">{db.error}</Alert></div>}
      <Tabs
        tabs={[
          { id: "overview", label: t("tabs.overview") },
          { id: "connections", label: t("tabs.connections") },
          { id: "credentials", label: t("tabs.credentials") },
          { id: "data", label: t("tabs.data") },
          { id: "backups", label: t("tabs.backups") },
          { id: "metrics", label: t("tabs.metrics") },
          { id: "logs", label: t("tabs.logs") },
          { id: "settings", label: t("tabs.settings") },
          { id: "danger", label: t("tabs.danger") },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "overview" && (
        <div className="grid gap-4 md:grid-cols-3">
          <ConnectionInfo db={db} creds={creds.data?.credentials} canSee={q.data!.permissions.includes("database:credentials")} onPublic={() => setTab("settings")} />
          <Card title={t("Database")}><dl className="space-y-2 text-sm"><div><dt className="text-xs text-muted">{t("Engine")}</dt><dd>{db.engine} {db.version}</dd></div><div><dt className="text-xs text-muted">{t("Storage")}</dt><dd>{db.storageMb} MB</dd></div><div><dt className="text-xs text-muted">{t("Ready since")}</dt><dd>{timeAgo(db.readyAt)}</dd></div></dl></Card>
          <Card title={t("Network")}><dl className="space-y-2 text-sm"><div><dt className="text-xs text-muted">{t("Private host")}</dt><dd className="font-mono text-xs">{db.internalHost}:{db.port}</dd></div><div><dt className="text-xs text-muted">{t("Public access")}</dt><dd>{db.publicAccess ? `Enabled (port ${db.publicPort ?? "…"})` : t("Disabled")}</dd></div></dl></Card>
          <Card title={t("Health")}><dl className="space-y-2 text-sm"><div><dt className="text-xs text-muted">{t("Uptime (24h)")}</dt><dd>{metrics.data?.uptimePercent ?? "–"}%</dd></div><div><dt className="text-xs text-muted">{t("Connected services")}</dt><dd>{q.data!.connections.length}</dd></div></dl></Card>
        </div>
      )}
      {tab === "connections" && (
        <Card title={t("Connected services")}>
          <ul className="mb-4 space-y-2 text-sm">
            {q.data!.connections.map((c) => (
              <li key={c.serviceId} className="flex items-center justify-between">
                <span>{c.serviceName} <code className="ml-2 font-mono text-xs text-muted">{c.variableName}</code></span>
                <Button size="sm" variant="ghost" onClick={() => del(`/databases/${db.id}/connections/${c.serviceId}`).then(() => q.refetch())}>{t("Disconnect")}</Button>
              </li>
            ))}
            {!q.data!.connections.length && <li className="text-muted">{t("No service uses this database yet.")}</li>}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("Service")}><Select value={connectTo} onChange={(e) => setConnectTo(e.target.value)}><option value="">{t("Choose…")}</option>{connectable.data?.services.map((x) => <option key={x.id} value={x.id}>{x.projectName} / {x.name}</option>)}</Select></Field>
            <Field label={t("Variable name")}><Input value={varName} placeholder={db.engine === "mongodb" ? "MONGODB_URI" : db.engine === "redis" ? "REDIS_URL" : "DATABASE_URL"} onChange={(e) => setVarName(e.target.value.toUpperCase())} /></Field>
            <Button disabled={!connectTo} onClick={() => post(`/databases/${db.id}/connections`, { serviceId: connectTo, variableName: varName || undefined }).then(() => { toast("success", t("Connected. Redeploy the service to inject the URL.")); void q.refetch(); }).catch((e) => toast("error", e.message))}>{t("Connect")}</Button>
          </div>
        </Card>
      )}
      {tab === "credentials" && (
        <Card title={t("Credentials")} actions={<Button size="sm" onClick={() => post(`/databases/${db.id}/rotate-credentials`).then(() => toast("success", t("Rotating the password. Redeploy connected services afterwards.")))}>{t("Rotate password")}</Button>}>
          {creds.isLoading ? <LoadingRows /> : creds.data && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Host")}><CodeField value={creds.data.credentials.host} /></Field>
              <Field label={t("Port")}><CodeField value={String(creds.data.credentials.port)} /></Field>
              <Field label={t("Database")}><CodeField value={creds.data.credentials.dbName} /></Field>
              <Field label={t("Username")}><CodeField value={creds.data.credentials.username} /></Field>
              <Field label={t("Password")}><CodeField value={creds.data.credentials.password} secret /></Field>
              <Field label={t("Internal URL")} className="sm:col-span-2"><CodeField value={creds.data.credentials.connectionUrl} secret /></Field>
              {creds.data.credentials.publicUrl && <Field label={t("Public URL")} className="sm:col-span-2"><CodeField value={creds.data.credentials.publicUrl} secret /></Field>}
            </div>
          )}
        </Card>
      )}
      {tab === "data" && <DataBrowser db={db} />}
      {tab === "backups" && <Backups db={db} />}
      {tab === "metrics" && (chart.length ? <div className="grid gap-4 lg:grid-cols-2"><MetricChart data={chart} dataKey="cpuPercent" title="CPU" unit="%" /><MetricChart data={chart} dataKey="memoryBytes" title={t("Memory")} formatter={bytesFmt} /><MetricChart data={chart} dataKey="diskBytes" title={t("Storage")} formatter={bytesFmt} color="#ca8a04" /><MetricChart data={chart} dataKey="requests" title={t("Connections")} color="#16a34a" /></div> : <EmptyState title={t("No metrics yet")} />)}
      {tab === "logs" && <pre className="h-[480px] overflow-auto rounded-lg border border-line bg-[#07080a] p-3 font-mono text-xs text-zinc-300">{logs.data?.lines.join("\n") ?? t("Loading…")}</pre>}
      {tab === "settings" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t("Backups")}>
            <div className="space-y-3">
              <Toggle checked={!!s.backupsEnabled} onChange={(v) => setSettings({ ...s, backupsEnabled: v })} label={t("Automatic backups")} />
              <Field label={t("Schedule (cron, UTC)")}><Input className="font-mono" value={s.backupSchedule} onChange={(e) => setSettings({ ...s, backupSchedule: e.target.value })} /></Field>
              <Field label={t("Retention (days)")}><Input value={s.backupRetentionDays} onChange={(e) => setSettings({ ...s, backupRetentionDays: Number(e.target.value) })} /></Field>
              <Button onClick={() => save.mutate({ backupsEnabled: s.backupsEnabled, backupSchedule: s.backupSchedule, backupRetentionDays: s.backupRetentionDays })}>{t("Save")}</Button>
            </div>
          </Card>
          <Card title={t("Public access")}>
            <div className="space-y-3">
              <p className="text-sm text-muted">{t("Disabled by default. Services always connect through the private network.")}</p>
              <Toggle checked={!!s.publicAccess} onChange={(v) => setSettings({ ...s, publicAccess: v })} label={t("Allow TCP connections from the internet")} />
              <Field label={t("Allowed IPs / CIDR (comma separated)")}><Input value={(s.ipAllowlist ?? []).join(", ")} onChange={(e) => setSettings({ ...s, ipAllowlist: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></Field>
              <Button onClick={() => save.mutate({ publicAccess: s.publicAccess, ipAllowlist: s.ipAllowlist })}>{t("Save")}</Button>
            </div>
          </Card>
        </div>
      )}
      {tab === "danger" && (
        <Card title={t("Danger zone")} className="border-red-500/30">
          <div className="space-y-4">
            <Toggle checked={db.deletionProtection} onChange={(v) => save.mutate({ deletionProtection: v })} label={t("Deletion protection")} />
            <Button variant="danger" disabled={db.deletionProtection} onClick={() => setConfirm(true)}>{t("Delete database")}</Button>
            {db.deletionProtection && <p className="text-xs text-muted">{t("Disable deletion protection to delete this database.")}</p>}
          </div>
          <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t("Delete database")} description={t("Everything is erased from the server: the container, the data, the backups and the connections. This cannot be undone.")} typeToConfirm={db.name} onConfirm={() => del(`/databases/${db.id}`, { confirmName: db.name }).then(() => nav(`/projects/${projectId}`)).catch((e) => toast("error", e.message))} />
        </Card>
      )}
    </>
  );
}
