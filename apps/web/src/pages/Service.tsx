import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Camera, Code2, ExternalLink, GitCommit, Play, RotateCcw, Square, Terminal, Upload } from "lucide-react";
import { formatBytes } from "@skyhost/shared";
import { api, del, download, get, patch, post, put, realtime, wsUrl } from "../lib/api";
import { useRealtimeInvalidate } from "../lib/session";
import { LogViewer, type LogLine } from "../components/LogViewer";
import { VariablesEditor } from "../components/VariablesEditor";
import { MetricChart, bytesFmt } from "../components/Charts";
import { Alert, Badge, Button, Card, CodeField, ConfirmDialog, EmptyState, ErrorState, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, Toggle, timeAgo, useToast } from "../components/ui";
import { t } from "../lib/i18n";
import { ProjectCrumb } from "../components/ProjectCrumb";
const CodeEditor = lazy(() => import("../components/CodeEditor").then((m) => ({ default: m.CodeEditor })));

interface ServiceDetail {
  service: { id: string; projectId: string; name: string; slug: string; type: string; source: Record<string, string>; config: any; analysis: any; createdAt: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
  role: string;
  permissions: string[];
  environments: Array<{ id: string; name: string; type: string; instance: { status: string; liveDeploymentId: string | null; sleeping: boolean; canaryDeploymentId: string | null; canaryWeight: number } | null; generatedDomain: string | null; url: string | null; internalHost: string }>;
  domains: Array<{ id: string; hostname: string; status: string; environmentId: string | null; isPrimary: boolean; redirectTo: string | null; error: string | null }>;
  volumes: Array<{ id: string; name: string; mountPath: string; sizeMb: number; environmentId: string }>;
  databases: Array<{ id: string; name: string; engine: string; variableName: string; status: string }>;
}

interface Deployment {
  id: string;
  status: string;
  phase: string | null;
  trigger: string;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  createdAt: string;
  durationSeconds: number | null;
  createdByName: string | null;
  error: string | null;
  isCanary: boolean;
  image: string | null;
}

type Tab = "overview" | "deployments" | "code" | "logs" | "variables" | "settings" | "domains" | "metrics" | "screenshots" | "shell" | "jobs" | "volumes";

function DeploymentsTab({ s, envId }: { s: ServiceDetail; envId: string }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ["deployments", s.service.id, envId], queryFn: () => get<{ deployments: Deployment[] }>(`/services/${s.service.id}/deployments?environmentId=${envId}`) });
  useRealtimeInvalidate(`service:${s.service.id}`, [["deployments", s.service.id, envId]]);
  const live = s.environments.find((e) => e.id === envId)?.instance?.liveDeploymentId;
  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data?.deployments.length) return <EmptyState title={t("No deployments yet")} />;
  return (
    <div className="divide-y divide-line rounded-lg border border-line bg-panel">
      {q.data.deployments.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <StatusBadge status={d.id === live ? "live" : d.status} />
          <div className="min-w-0 flex-1">
            <Link to={`/projects/${s.service.projectId}/deployments/${d.id}`} className="block truncate font-medium hover:underline">
              {d.commitMessage?.split("\n")[0] ?? t("Deployment {{id}}", { id: d.id.slice(0, 8) })}
            </Link>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {d.commitSha && <span className="flex items-center gap-1 font-mono"><GitCommit className="size-3" />{d.commitSha.slice(0, 7)}</span>}
              {d.branch && <span>{d.branch}</span>}
              <span>{d.trigger}</span>
              {d.commitAuthor && <span>{t("by")} {d.commitAuthor}</span>}
              <span>{timeAgo(d.createdAt)}</span>
              {d.durationSeconds != null && <span>{d.durationSeconds}s</span>}
              {d.isCanary && <Badge>{t("canary")}</Badge>}
            </div>
          </div>
          <div className="flex gap-1">
            {["queued", "building", "deploying"].includes(d.status) && s.permissions.includes("deploy:cancel") && (
              <Button size="sm" onClick={() => post(`/deployments/${d.id}/cancel`).then(() => toast("info", t("Cancelling…"))).catch((e) => toast("error", e.message))}>{t("Cancel")}</Button>
            )}
            {d.image && d.id !== live && ["superseded", "live", "stopped"].includes(d.status) && s.permissions.includes("deploy:rollback") && (
              <Button size="sm" onClick={() => post(`/deployments/${d.id}/rollback`).then(() => toast("success", t("Rollback started"))).catch((e) => toast("error", e.message))}>
                <RotateCcw className="size-3.5" /> {t("Rollback")}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function RuntimeLogs({ serviceId, envId }: { serviceId: string; envId: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    setLines([]);
    const ws = new WebSocket(wsUrl(`/services/${serviceId}/logs/stream?environmentId=${envId}&tail=500`));
    const buf: LogLine[] = [];
    let t: ReturnType<typeof setTimeout> | null = null;
    ws.onmessage = (e) => {
      try {
        buf.push(JSON.parse(e.data));
      } catch {
        return;
      }
      t ??= setTimeout(() => {
        t = null;
        const add = buf.splice(0);
        setLines((ls) => [...ls, ...add].slice(-5000));
      }, 200);
    };
    return () => ws.close();
  }, [serviceId, envId]);
  return <LogViewer lines={lines} live onDownload={() => download(`/services/${serviceId}/logs?environmentId=${envId}&download=true&tail=5000`)} />;
}

function SettingsTab({ s, onSaved }: { s: ServiceDetail; onSaved: () => void }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(s.service.config);
  const [name, setName] = useState(s.service.name);
  const [branch, setBranch] = useState(s.service.source.branch ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nav = useNavigate();
  const can = s.permissions.includes("service:update");
  const set = (path: string, value: unknown) => {
    setCfg((c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const next = structuredClone(c);
      const keys = path.split(".");
      let cur = next;
      for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
      cur[keys.at(-1)!] = value;
      return next;
    });
  };
  const save = useMutation({
    mutationFn: async () => {
      const r = await patch<{ redeployRequired: boolean }>(`/services/${s.service.id}`, { name, config: cfg });
      if (branch && branch !== s.service.source.branch && ["github", "gitlab", "bitbucket", "git"].includes(s.service.source.kind!)) await put(`/services/${s.service.id}/source`, { source: { ...s.service.source, branch } });
      return r;
    },
    onSuccess: (r) => {
      toast("success", r.redeployRequired ? "Saved. Redeploy to apply build or runtime changes." : "Saved");
      onSaved();
    },
    onError: (e) => toast("error", (e as Error).message),
  });
  const num = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <div className="space-y-4">
      <Card title={t("Source")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Source")}><Input disabled value={s.service.source.repo ?? s.service.source.url ?? s.service.source.image ?? s.service.source.kind} /></Field>
          {s.service.source.kind !== "image" && s.service.source.kind !== "zip" && <Field label={t("Branch")}><Input value={branch} onChange={(e) => setBranch(e.target.value)} /></Field>}
          <Field label={t("Root directory")}><Input value={cfg.rootDir ?? "."} onChange={(e) => set("rootDir", e.target.value)} /></Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-6">
          <Toggle checked={cfg.autoDeploy} onChange={(v) => set("autoDeploy", v)} label={t("Auto deploy on push")} />
          <Toggle checked={cfg.waitForCi} onChange={(v) => set("waitForCi", v)} label={t("Wait for CI to pass")} />
          <Toggle checked={cfg.previews} onChange={(v) => set("previews", v)} label={t("Pull request previews")} />
        </div>
      </Card>
      <Card title={t("Build & start")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Runtime")} hint={t("Detected: {{value}}", { value: s.service.analysis?.runtime ?? "–" })}><Input value={cfg.runtime ?? ""} placeholder={t("auto")} onChange={(e) => set("runtime", e.target.value || undefined)} /></Field>
          <Field label={t("Runtime version")}><Input value={cfg.runtimeVersion ?? ""} placeholder={s.service.analysis?.version ?? "auto"} onChange={(e) => set("runtimeVersion", e.target.value || undefined)} /></Field>
          <Field label={t("Install command")}><Input className="font-mono" value={cfg.installCommand ?? ""} placeholder={s.service.analysis?.installCommand ?? ""} onChange={(e) => set("installCommand", e.target.value || undefined)} /></Field>
          <Field label={t("Build command")}><Input className="font-mono" value={cfg.buildCommand ?? ""} placeholder={s.service.analysis?.buildCommand ?? ""} onChange={(e) => set("buildCommand", e.target.value || undefined)} /></Field>
          <Field label={t("Start command")}><Input className="font-mono" value={cfg.startCommand ?? ""} placeholder={s.service.analysis?.startCommand ?? ""} onChange={(e) => set("startCommand", e.target.value || undefined)} /></Field>
          <Field label={t("Test command")} hint={t("Runs after the build; a failure stops the deployment")}><Input className="font-mono" value={cfg.testCommand ?? ""} onChange={(e) => set("testCommand", e.target.value || undefined)} /></Field>
          <Field label={t("Dockerfile path")}><Input value={cfg.dockerfilePath ?? ""} placeholder={t("Dockerfile")} onChange={(e) => set("dockerfilePath", e.target.value || undefined)} /></Field>
          <Field label={t("Output directory (static)")}><Input value={cfg.outputDirectory ?? ""} placeholder={s.service.analysis?.outputDirectory ?? ""} onChange={(e) => set("outputDirectory", e.target.value || undefined)} /></Field>
          <Field label={t("Port")}><Input value={cfg.port ?? ""} placeholder={String(s.service.analysis?.port ?? "")} onChange={(e) => set("port", num(e.target.value))} inputMode="numeric" /></Field>
        </div>
      </Card>
      <Card title={t("Resources & health")}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("vCPU")}><Input value={cfg.resources.cpu} onChange={(e) => set("resources.cpu", Number(e.target.value))} inputMode="decimal" /></Field>
          <Field label={t("Memory (MB)")}><Input value={cfg.resources.memoryMb} onChange={(e) => set("resources.memoryMb", Number(e.target.value))} inputMode="numeric" /></Field>
          <Field label={t("Replicas")}><Input value={cfg.resources.replicas} onChange={(e) => set("resources.replicas", Number(e.target.value))} inputMode="numeric" /></Field>
          <Field label={t("Health check path")}><Input value={cfg.healthcheck.path} onChange={(e) => set("healthcheck.path", e.target.value)} /></Field>
          <Field label={t("Interval (s)")}><Input value={cfg.healthcheck.intervalSeconds} onChange={(e) => set("healthcheck.intervalSeconds", Number(e.target.value))} /></Field>
          <Field label={t("Retries")}><Input value={cfg.healthcheck.retries} onChange={(e) => set("healthcheck.retries", Number(e.target.value))} /></Field>
          <Field label={t("Graceful shutdown (s)")}><Input value={cfg.gracefulShutdownSeconds} onChange={(e) => set("gracefulShutdownSeconds", Number(e.target.value))} /></Field>
          <Field label={t("Sleep after inactivity (min, 0 = never)")}><Input value={cfg.sleepAfterMinutes} onChange={(e) => set("sleepAfterMinutes", Number(e.target.value))} /></Field>
        </div>
      </Card>
      {s.service.type === "cron" && (
        <Card title={t("Schedule")}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("Cron expression")}><Input className="font-mono" value={cfg.cron?.schedule ?? ""} onChange={(e) => set("cron.schedule", e.target.value)} /></Field>
            <Field label={t("Timezone")}><Input value={cfg.cron?.timezone ?? "UTC"} onChange={(e) => set("cron.timezone", e.target.value)} /></Field>
            <Field label={t("Timeout (s)")}><Input value={cfg.cron?.timeoutSeconds ?? 900} onChange={(e) => set("cron.timeoutSeconds", Number(e.target.value))} /></Field>
          </div>
          <div className="mt-3"><Toggle checked={cfg.cron?.enabled ?? true} onChange={(v) => set("cron.enabled", v)} label={t("Enabled")} /></div>
        </Card>
      )}
      <Card title={t("Access protection")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Mode")}>
            <Select value={cfg.protection.mode} onChange={(e) => set("protection.mode", e.target.value)}>
              <option value="none">{t("Public")}</option>
              <option value="basic">{t("Basic Auth")}</option>
              <option value="password">{t("Password page")}</option>
              <option value="ip">{t("IP allowlist")}</option>
            </Select>
          </Field>
          {cfg.protection.mode === "basic" && (
            <>
              <Field label={t("Username")}><Input value={cfg.protection.basicUser ?? ""} onChange={(e) => set("protection.basicUser", e.target.value)} /></Field>
              <Field label={t("Password")}><Input type="password" value={cfg.protection.basicPassword ?? ""} onChange={(e) => set("protection.basicPassword", e.target.value)} /></Field>
            </>
          )}
          {cfg.protection.mode === "password" && <Field label={t("Password")}><Input type="password" value={cfg.protection.password ?? ""} onChange={(e) => set("protection.password", e.target.value)} /></Field>}
          {cfg.protection.mode === "ip" && <Field label={t("Allowed IPs / CIDR (comma separated)")}><Input value={(cfg.protection.ipAllowlist ?? []).join(", ")} onChange={(e) => set("protection.ipAllowlist", e.target.value.split(",").map((x: string) => x.trim()).filter(Boolean))} /></Field>}
        </div>
        <div className="mt-3"><Toggle checked={cfg.protection.applyToPreviews} onChange={(v) => set("protection.applyToPreviews", v)} label={t("Also protect preview environments")} /></div>
      </Card>
      <Card title={t("Firewall & rate limiting")}>
        <div className="flex flex-wrap gap-6">
          <Toggle checked={cfg.waf.enabled} onChange={(v) => set("waf.enabled", v)} label={t("Enable WAF")} />
          <Toggle checked={cfg.waf.blockBots} onChange={(v) => set("waf.blockBots", v)} label={t("Block bots and scanners")} />
        </div>
        {cfg.waf.enabled && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label={t("Requests per minute per IP (0 = unlimited)")}><Input value={cfg.waf.rateLimitPerMinute} onChange={(e) => set("waf.rateLimitPerMinute", Number(e.target.value))} /></Field>
            <Field label={t("Blocked IPs (comma separated)")}><Input value={(cfg.waf.rules.find((r: any) => r.id === "block-ip")?.match.ip ?? []).join(", ")} onChange={(e) => set("waf.rules", [...cfg.waf.rules.filter((r: any) => r.id !== "block-ip"), { id: "block-ip", action: "block", match: { ip: e.target.value.split(",").map((x: string) => x.trim()).filter(Boolean) } }])} /></Field>
            <Field label={t("Blocked countries (ISO codes)")}><Input value={(cfg.waf.rules.find((r: any) => r.id === "block-country")?.match.country ?? []).join(", ")} onChange={(e) => set("waf.rules", [...cfg.waf.rules.filter((r: any) => r.id !== "block-country"), { id: "block-country", action: "block", match: { country: e.target.value.split(",").map((x: string) => x.trim().toUpperCase()).filter((x: string) => x.length === 2) } }])} /></Field>
          </div>
        )}
      </Card>
      <Card title={t("Screenshots")}>
        <div className="flex flex-wrap items-end gap-4">
          <Toggle checked={cfg.autoScreenshots} onChange={(v) => set("autoScreenshots", v)} label={t("Capture after every live deployment")} />
          <Field label={t("Pages")} className="flex-1"><Input value={(cfg.screenshotPaths ?? ["/"]).join(", ")} onChange={(e) => set("screenshotPaths", e.target.value.split(",").map((x: string) => x.trim()).filter((x: string) => x.startsWith("/")))} /></Field>
        </div>
      </Card>
      <Card title={t("Maintenance page")}>
        <Toggle checked={cfg.maintenance?.enabled ?? false} onChange={(v) => set("maintenance.enabled", v)} label={t("Show a maintenance page instead of the application")} />
        <Field label={t("Message for visitors")} hint={t("Visitors get HTTP 503 with this message; the application keeps running. Applied on save, no redeploy needed.")} className="mt-4">
          <Textarea rows={2} maxLength={500} value={cfg.maintenance?.message ?? ""} placeholder={t("We are upgrading the service. Back in a few minutes.")} onChange={(e) => set("maintenance.message", e.target.value)} />
        </Field>
      </Card>
      <DeployHooks s={s} />
      {can && (
        <div className="flex justify-between">
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>{t("Delete service")}</Button>
          <div className="flex gap-2">
            <Button onClick={() => post(`/services/${s.service.id}/duplicate`, { name: `${s.service.name}-copy` }).then(() => toast("success", t("Service duplicated")))}>{t("Duplicate")}</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{t("Save changes")}</Button>
          </div>
        </div>
      )}
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t("Delete service")} description={t("Everything is erased from the server: containers, volumes, built images, screenshots and logs. This cannot be undone.")} typeToConfirm={s.service.name} onConfirm={() => del(`/services/${s.service.id}`, { confirmName: s.service.name }).then(() => nav(`/projects/${s.service.projectId}`))} />
    </div>
  );
}

interface DeployHook { id: string; name: string; environmentId: string; prefix: string; lastUsedAt: string | null; createdAt: string }

function DeployHooks({ s }: { s: ServiceDetail }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["deploy-hooks", s.service.id], queryFn: () => get<{ hooks: DeployHook[] }>(`/services/${s.service.id}/deploy-hooks`) });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("CI");
  const [envId, setEnvId] = useState(s.environments.find((e) => e.type === "production")?.id ?? s.environments[0]?.id ?? "");
  const [created, setCreated] = useState<string | null>(null);
  const can = s.permissions.includes("deploy:create");
  const create = useMutation({
    mutationFn: () => post<{ url: string }>(`/services/${s.service.id}/deploy-hooks`, { name, environmentId: envId }),
    onSuccess: (r) => { setCreated(r.url); void qc.invalidateQueries({ queryKey: ["deploy-hooks", s.service.id] }); },
    onError: (e) => toast("error", (e as Error).message),
  });
  const close = () => { setOpen(false); setCreated(null); setName("CI"); };
  const envName = (id: string) => s.environments.find((e) => e.id === id)?.name ?? "–";
  return (
    <Card title={t("Deploy hooks")} padded={false} actions={can && <Button size="sm" onClick={() => setOpen(true)}>{t("Create hook")}</Button>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">{t("A secret URL that starts a deployment when it receives a POST request: CI pipelines, CMS publish buttons, scheduled rebuilds.")}</p>
      {q.isLoading ? <div className="p-4"><LoadingRows rows={2} /></div> : !q.data?.hooks.length ? <EmptyState title={t("No deploy hooks")} /> : (
        <table className="w-full text-sm">
          <tbody>
            {q.data.hooks.map((h) => (
              <tr key={h.id} className="border-t border-line first:border-0">
                <td className="px-4 py-2.5 font-medium">{h.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">…/hooks/deploy/{h.prefix}••••</td>
                <td className="px-4 py-2.5"><Badge>{envName(h.environmentId)}</Badge></td>
                <td className="px-4 py-2.5 text-xs text-muted">{h.lastUsedAt ? t("Used {{time}}", { time: timeAgo(h.lastUsedAt) }) : t("Never used")}</td>
                <td className="px-4 py-2.5 text-right">{can && <Button size="sm" variant="danger" onClick={() => del(`/deploy-hooks/${h.id}`).then(() => { toast("success", t("Deploy hook revoked")); void q.refetch(); }).catch((e) => toast("error", e.message))}>{t("Revoke")}</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={open} onClose={close} title={t("Create a deploy hook")} footer={created ? <Button variant="primary" onClick={close}>{t("Done")}</Button> : <><Button onClick={close}>{t("Cancel")}</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim() || !envId} onClick={() => create.mutate()}>{t("Create")}</Button></>}>
        {created ? (
          <div className="space-y-3 text-sm">
            <Alert kind="warn">{t("Copy this URL now: it contains a secret and will not be shown again.")}</Alert>
            <CodeField value={created} />
            <CodeField value={`curl -X POST ${created}`} />
          </div>
        ) : (
          <div className="space-y-3">
            <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
            <Field label={t("Environment")}>
              <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>{s.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>
            </Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function DomainsTab({ s, envId }: { s: ServiceDetail; envId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [host, setHost] = useState("");
  const q = useQuery({ queryKey: ["domains", s.service.id], queryFn: () => get<{ domains: Array<{ id: string; hostname: string; status: string; error: string | null; isPrimary: boolean; dns: { records: Array<{ type: string; name: string; value: string; purpose: string }> } }> }>(`/services/${s.service.id}/domains`) });
  const env = s.environments.find((e) => e.id === envId);
  const add = useMutation({ mutationFn: () => post(`/services/${s.service.id}/domains`, { hostname: host }), onSuccess: () => { setHost(""); void qc.invalidateQueries({ queryKey: ["domains"] }); }, onError: (e) => toast("error", (e as Error).message) });
  const verify = (id: string) => post<{ check: { details: string[] } }>(`/domains/${id}/verify`).then((r) => { toast("info", r.check.details.join(" · ")); void qc.invalidateQueries({ queryKey: ["domains"] }); });
  return (
    <div className="space-y-4">
      {env?.generatedDomain && (
        <Card title={t("SKYHOST domain")}>
          <div className="flex items-center gap-2"><CodeField value={env.generatedDomain} />{env.url && <a href={env.url} target="_blank" rel="noreferrer"><Button size="sm"><ExternalLink className="size-3.5" /></Button></a>}</div>
          <p className="mt-2 text-xs text-muted">{t("Private network:")} <code className="font-mono">{env.internalHost}</code></p>
        </Card>
      )}
      <Card title={t("Custom domains")}>
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} className="mb-4 flex gap-2">
          <Input placeholder="www.example.com" value={host} onChange={(e) => setHost(e.target.value.toLowerCase())} />
          <Button variant="primary" loading={add.isPending}>{t("Add domain")}</Button>
        </form>
        {q.data?.domains.length ? (
          <div className="space-y-4">
            {q.data.domains.map((d) => (
              <div key={d.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.hostname}</span>
                  <StatusBadge status={d.status} label={{ pending: "Pending", verified: "Verified", ssl_issued: "SSL issued", error: "Error" }[d.status]} />
                  {d.isPrimary && <Badge>{t("primary")}</Badge>}
                  <div className="ml-auto flex gap-1">
                    {d.status !== "ssl_issued" && <Button size="sm" onClick={() => verify(d.id)}>{t("Verify")}</Button>}
                    <Button size="sm" variant="ghost" onClick={() => del(`/domains/${d.id}`).then(() => qc.invalidateQueries({ queryKey: ["domains"] }))}>{t("Remove")}</Button>
                  </div>
                </div>
                {d.status !== "ssl_issued" && (
                  <table className="mt-3 w-full text-xs">
                    <thead className="text-left text-muted"><tr><th className="pb-1">{t("Type")}</th><th>{t("Name")}</th><th>{t("Value")}</th><th>{t("Purpose")}</th></tr></thead>
                    <tbody>
                      {d.dns.records.map((r) => (
                        <tr key={r.type + r.name} className="border-t border-line font-mono">
                          <td className="py-1.5">{r.type}</td><td>{r.name}</td><td className="break-all">{r.value}</td><td className="font-sans text-muted">{r.purpose}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {d.error && <p className="mt-2 text-xs text-amber-500">{d.error}</p>}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-muted">{t("HTTPS certificates are issued automatically once DNS is verified.")}</p>}
      </Card>
    </div>
  );
}

function MetricsTab({ serviceId, envId }: { serviceId: string; envId: string }) {
  const [hours, setHours] = useState(24);
  const q = useQuery({ queryKey: ["metrics", serviceId, envId, hours], queryFn: () => get<{ samples: Array<{ t: string; cpu: number; memory: number; rx: number; tx: number; restarts: number }>; summary: { uptimePercent: number | null; restarts: number } }>(`/services/${serviceId}/metrics?environmentId=${envId}&hours=${hours}`), refetchInterval: 60_000 });
  const data = useMemo(() => (q.data?.samples ?? []).map((s) => ({ ...s, label: new Date(s.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })), [q.data]);
  if (q.isLoading) return <LoadingRows />;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-sm">
        <Select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="w-36">
          {[1, 6, 24, 168].map((h) => <option key={h} value={h}>{t("Last")} {h < 24 ? `${h}h` : `${h / 24}d`}</option>)}
        </Select>
        <span>{t("Uptime")} <strong>{q.data?.summary.uptimePercent ?? "–"}%</strong></span>
        <span>{t("Restarts")} <strong>{q.data?.summary.restarts ?? 0}</strong></span>
      </div>
      {!data.length ? <EmptyState title={t("No metrics yet")} description={t("Metrics are sampled every minute while the service runs.")} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <MetricChart data={data} dataKey="cpu" title="CPU" unit="%" />
          <MetricChart data={data} dataKey="memory" title={t("Memory")} formatter={bytesFmt} />
          <MetricChart data={data} dataKey="rx" title={t("Network in (total)")} formatter={bytesFmt} color="#16a34a" />
          <MetricChart data={data} dataKey="tx" title={t("Network out (total)")} formatter={bytesFmt} color="#ca8a04" />
        </div>
      )}
    </div>
  );
}

function ScreenshotsTab({ s, envId }: { s: ServiceDetail; envId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["screenshots", s.service.id], queryFn: () => get<{ screenshots: Array<{ id: string; kind: string; status: string; viewport: string; path: string; title: string | null; description: string | null; commitSha: string | null; commitMessage: string | null; createdAt: string; mimeType: string; shared: boolean; imageUrl: string; error: string | null }> }>(`/services/${s.service.id}/screenshots`) });
  useRealtimeInvalidate(`service:${s.service.id}`, [["screenshots", s.service.id]]);
  const [capture, setCapture] = useState(false);
  const [path, setPath] = useState("/");
  const [viewport, setViewport] = useState("desktop");
  const [fullPage, setFullPage] = useState(false);
  const [delay, setDelay] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [compare, setCompare] = useState<string[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const shot = useMutation({ mutationFn: () => post(`/services/${s.service.id}/screenshots`, { environmentId: envId, path, viewport, fullPage, delayMs: delay, title: title || undefined, description: description || undefined }), onSuccess: () => { setCapture(false); void qc.invalidateQueries({ queryKey: ["screenshots"] }); toast("success", t("Capturing…")); }, onError: (e) => toast("error", (e as Error).message) });
  const upload = async (f: File) => {
    const form = new FormData();
    form.append("title", f.name);
    form.append("file", f);
    await api(`/services/${s.service.id}/screenshots/upload`, { form }).then(() => qc.invalidateQueries({ queryKey: ["screenshots"] })).catch((e) => toast("error", e.message));
  };
  const items = q.data?.screenshots ?? [];
  const pair = compare.length === 2 ? compare.map((id) => items.find((x) => x.id === id)!) : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setCapture(true)}><Camera className="size-4" /> {t("Capture")}</Button>
        <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel px-3.5 text-sm hover:bg-panel-2"><Upload className="size-4" /> {t("Upload image or video")}<input type="file" accept="image/*,video/mp4,video/webm" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} /></label>
        {compare.length > 0 && <span className="self-center text-sm text-muted">{t("Select two captures to compare (")}{compare.length}/2)</span>}
      </div>
      {shareUrl && <Alert kind="success"><div className="flex items-center gap-2">{t("Public link:")} <CodeField value={shareUrl} /></div></Alert>}
      {pair && (
        <Card title={t("Before / after")} actions={<Button size="sm" onClick={() => setCompare([])}>{t("Close")}</Button>}>
          <div className="grid gap-4 md:grid-cols-2">
            {pair.map((p) => (
              <figure key={p.id}><img src={p.imageUrl} alt={p.title ?? ""} className="w-full rounded border border-line" /><figcaption className="mt-1 text-xs text-muted">{p.commitSha?.slice(0, 7)} · {timeAgo(p.createdAt)}</figcaption></figure>
            ))}
          </div>
        </Card>
      )}
      {q.isLoading ? <LoadingRows /> : !items.length ? <EmptyState icon={<Camera className="size-8" />} title={t("No captures yet")} description={t("SKYHOST captures desktop and mobile views after every live deployment. You can also capture any page or upload your own.")} /> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((x) => (
            <div key={x.id} className="overflow-hidden rounded-lg border border-line bg-panel">
              <div className="aspect-video bg-panel-2">
                {x.status === "completed" ? (x.mimeType.startsWith("video") ? <video src={x.imageUrl} controls className="size-full object-cover" /> : <img src={x.imageUrl} alt={x.title ?? x.path} loading="lazy" className="size-full object-cover object-top" />) : <div className="flex size-full items-center justify-center"><StatusBadge status={x.status} /></div>}
              </div>
              <div className="space-y-1 p-3 text-sm">
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{x.title ?? x.path}</span><Badge>{x.viewport}</Badge></div>
                {x.description && <p className="line-clamp-2 text-xs text-muted">{x.description}</p>}
                <p className="text-xs text-faint">{x.kind} · {x.commitSha?.slice(0, 7) ?? "upload"} · {timeAgo(x.createdAt)}</p>
                {x.error && <p className="text-xs text-red-500">{x.error}</p>}
                <div className="flex gap-1 pt-1">
                  <Button size="sm" variant="ghost" onClick={() => setCompare((c) => (c.includes(x.id) ? c.filter((y) => y !== x.id) : [...c.slice(-1), x.id]))}>{compare.includes(x.id) ? t("Selected") : t("Compare")}</Button>
                  {x.shared ? <Button size="sm" variant="ghost" onClick={() => del(`/screenshots/${x.id}/share`).then(() => { setShareUrl(null); void qc.invalidateQueries({ queryKey: ["screenshots"] }); })}>{t("Revoke link")}</Button> : x.status === "completed" && <Button size="sm" variant="ghost" onClick={() => post<{ pageUrl: string }>(`/screenshots/${x.id}/share`, { expiresInDays: 30 }).then((r) => { setShareUrl(r.pageUrl); void qc.invalidateQueries({ queryKey: ["screenshots"] }); })}>{t("Share")}</Button>}
                  <Button size="sm" variant="ghost" onClick={() => del(`/screenshots/${x.id}`).then(() => qc.invalidateQueries({ queryKey: ["screenshots"] }))}>{t("Delete")}</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <Modal open={capture} onClose={() => setCapture(false)} title={t("Capture a page")} footer={<Button variant="primary" loading={shot.isPending} onClick={() => shot.mutate()}>{t("Capture")}</Button>}>
        <div className="space-y-3">
          <Field label={t("Path")}><Input value={path} onChange={(e) => setPath(e.target.value)} /></Field>
          <Field label={t("Viewport")}><Select value={viewport} onChange={(e) => setViewport(e.target.value)}><option>{t("desktop")}</option><option>{t("tablet")}</option><option>{t("mobile")}</option></Select></Field>
          <Toggle checked={fullPage} onChange={setFullPage} label={t("Full page")} />
          <Field label={t("Wait before capture (ms)")}><Input value={delay} onChange={(e) => setDelay(Number(e.target.value) || 0)} /></Field>
          <Field label={t("Feature title")}><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("New checkout page")} /></Field>
          <Field label={t("Description")}><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
      </Modal>
    </div>
  );
}

function ShellTab({ serviceId, envId }: { serviceId: string; envId: string }) {
  const [out, setOut] = useState<Array<{ kind: string; text: string }>>([]);
  const [cmd, setCmd] = useState("");
  const [ready, setReady] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const history = useRef<string[]>([]);
  const hIdx = useRef(-1);
  useEffect(() => {
    const s = new WebSocket(wsUrl(`/services/${serviceId}/shell?environmentId=${envId}`));
    ws.current = s;
    s.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "ready") {
        setReady(true);
        setOut((o) => [...o, { kind: "info", text: "Connected to the service container. Allowed commands: ls, cat, env, node, npm, python, pip, ... (no pipes or chaining)." }]);
      } else if (m.type === "output") setOut((o) => [...o, ...(m.stdout ? [{ kind: "out", text: m.stdout }] : []), ...(m.stderr ? [{ kind: "err", text: m.stderr }] : []), { kind: "info", text: `exit ${m.exitCode}` }]);
      else setOut((o) => [...o, { kind: m.type === "error" ? "err" : "info", text: m.message }]);
    };
    s.onclose = () => {
      setReady(false);
      setOut((o) => [...o, { kind: "info", text: "Session closed." }]);
    };
    return () => s.close();
  }, [serviceId, envId]);
  useEffect(() => {
    box.current?.scrollTo(0, box.current.scrollHeight);
  }, [out]);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div ref={box} className="h-[420px] overflow-y-auto bg-[#07080a] p-3 font-mono text-xs leading-5 text-zinc-300">
        {out.map((o, i) => <pre key={i} className={o.kind === "err" ? "whitespace-pre-wrap text-red-400" : o.kind === "info" ? "whitespace-pre-wrap text-zinc-500" : o.kind === "cmd" ? "text-green-400" : "whitespace-pre-wrap"}>{o.text}</pre>)}
      </div>
      <form
        className="flex items-center gap-2 border-t border-line bg-[#07080a] px-3 py-2 font-mono text-xs text-zinc-200"
        onSubmit={(e) => {
          e.preventDefault();
          if (!cmd.trim() || !ready) return;
          ws.current?.send(JSON.stringify({ cmd }));
          setOut((o) => [...o, { kind: "cmd", text: `$ ${cmd}` }]);
          history.current.unshift(cmd);
          hIdx.current = -1;
          setCmd("");
        }}
      >
        <Terminal className="size-3.5 text-green-400" />
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") { hIdx.current = Math.min(hIdx.current + 1, history.current.length - 1); setCmd(history.current[hIdx.current] ?? cmd); }
            if (e.key === "ArrowDown") { hIdx.current = Math.max(hIdx.current - 1, -1); setCmd(hIdx.current < 0 ? "" : history.current[hIdx.current]!); }
          }}
          disabled={!ready}
          className="flex-1 bg-transparent outline-none"
          placeholder={ready ? t("node --version") : "connecting…"}
          aria-label={t("Shell command")}
        />
      </form>
    </div>
  );
}

function JobsTab({ s, envId }: { s: ServiceDetail; envId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [command, setCommand] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["jobs", s.service.id], queryFn: () => get<{ jobs: Array<{ id: string; kind: string; command: string; status: string; exitCode: number | null; output: string; createdAt: string }> }>(`/services/${s.service.id}/jobs`), refetchInterval: 5000 });
  const run = useMutation({ mutationFn: () => post(`/services/${s.service.id}/jobs`, { environmentId: envId, command }), onSuccess: () => { setCommand(""); void qc.invalidateQueries({ queryKey: ["jobs"] }); }, onError: (e) => toast("error", (e as Error).message) });
  return (
    <div className="space-y-4">
      <Card title={t("Run a one-off command")} actions={s.service.type === "cron" && <Button size="sm" onClick={() => post(`/services/${s.service.id}/cron/run`, { environmentId: envId }).then(() => qc.invalidateQueries({ queryKey: ["jobs"] }))}><Play className="size-3.5" /> {t("Run cron now")}</Button>}>
        <form onSubmit={(e) => { e.preventDefault(); run.mutate(); }} className="flex gap-2">
          <Input className="font-mono" placeholder={t("npx prisma migrate deploy")} value={command} onChange={(e) => setCommand(e.target.value)} />
          <Button variant="primary" loading={run.isPending}>{t("Run")}</Button>
        </form>
        <p className="mt-2 text-xs text-muted">{t("Runs in a fresh container from the live image with the service variables and volumes (migrations, seeds, scripts).")}</p>
      </Card>
      <div className="divide-y divide-line rounded-lg border border-line bg-panel">
        {q.data?.jobs.map((j) => (
          <div key={j.id} className="px-4 py-2 text-sm">
            <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(open === j.id ? null : j.id)}>
              <StatusBadge status={j.status === "running" ? "building" : j.status} label={j.status} />
              <code className="flex-1 truncate font-mono text-xs">{j.command}</code>
              <Badge>{j.kind}</Badge>
              <span className="text-xs text-muted">{timeAgo(j.createdAt)}</span>
            </button>
            {open === j.id && <pre className="mt-2 max-h-80 overflow-auto rounded bg-[#07080a] p-2 font-mono text-xs text-zinc-300">{j.output || t("(no output)")}</pre>}
          </div>
        ))}
        {!q.data?.jobs.length && <p className="px-4 py-6 text-center text-sm text-muted">{t("No runs yet.")}</p>}
      </div>
    </div>
  );
}

function VolumesTab({ s, onChange }: { s: ServiceDetail; onChange: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("data");
  const [mount, setMount] = useState("/data");
  const [size, setSize] = useState(1024);
  const unique = [...new Map(s.volumes.map((v) => [v.name, v])).values()];
  return (
    <Card title={t("Persistent volumes")}>
      <ul className="mb-4 divide-y divide-line text-sm">
        {unique.map((v) => (
          <li key={v.id} className="flex items-center justify-between py-2">
            <span><strong>{v.name}</strong> <code className="font-mono text-xs text-muted">{v.mountPath}</code> · {formatBytes(v.sizeMb * 1048576)}</span>
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => post(`/volumes/${v.id}/snapshots`).then(() => toast("success", t("Snapshot started")))}>{t("Snapshot")}</Button>
              <Button size="sm" variant="ghost" onClick={() => del(`/volumes/${v.id}`, { confirmName: v.name }).then(onChange)}>{t("Delete")}</Button>
            </span>
          </li>
        ))}
        {!unique.length && <li className="py-2 text-muted">{t("No volumes. Data written outside a volume is lost on redeploy.")}</li>}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t("Mount path")}><Input value={mount} onChange={(e) => setMount(e.target.value)} /></Field>
        <Field label={t("Size (MB)")}><Input value={size} onChange={(e) => setSize(Number(e.target.value))} /></Field>
        <Button onClick={() => post(`/services/${s.service.id}/volumes`, { name, mountPath: mount, sizeMb: size }).then(() => { toast("success", t("Volume created. Redeploy to mount it.")); onChange(); }).catch((e) => toast("error", e.message))}>{t("Add volume")}</Button>
      </div>
    </Card>
  );
}

export default function Service() {
  const { projectId, serviceId } = useParams();
  const [params, setParams] = useSearchParams();
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["service", serviceId], queryFn: () => get<ServiceDetail>(`/services/${serviceId}`) });
  useRealtimeInvalidate(serviceId ? `service:${serviceId}` : null, [["service", serviceId]]);
  const envId = params.get("env") ?? q.data?.environments.find((e) => e.type === "production")?.id ?? q.data?.environments[0]?.id ?? "";
  const tab = (params.get("tab") as Tab) ?? "overview";
  const setTab = (x: Tab) => setParams((p) => { p.set("tab", x); return p; });
  useEffect(() => {
    if (!serviceId) return;
    return realtime.subscribe(`service:${serviceId}`, (m) => {
      if (m.type === "deployment.status" && m.status === "failed") toast("error", t("A deployment failed. Open it to see the diagnosis."));
    });
  }, [serviceId, toast]);
  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data!;
  const env = s.environments.find((e) => e.id === envId);
  const can = (p: string) => s.permissions.includes(p);
  const action = (path: string, msg: string) => post(path, { environmentId: envId }).then((r: any) => { toast("success", msg); void qc.invalidateQueries({ queryKey: ["deployments"] }); return r; }).catch((e) => toast("error", e.message)); // eslint-disable-line @typescript-eslint/no-explicit-any
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: t("tabs.overview") },
    { id: "deployments", label: t("tabs.deployments") },
    ...(["github", "gitlab", "bitbucket"].includes(s.service.source.kind!) ? [{ id: "code" as Tab, label: t("tabs.code") }] : []),
    { id: "logs", label: t("tabs.logs") },
    { id: "variables", label: t("tabs.variables") },
    { id: "metrics", label: t("tabs.metrics") },
    ...(["web", "static", "docker"].includes(s.service.type) ? [{ id: "domains" as Tab, label: t("tabs.domains") }, { id: "screenshots" as Tab, label: t("tabs.screenshots") }] : []),
    ...(can("shell:access") ? [{ id: "shell" as Tab, label: t("tabs.shell") }, { id: "jobs" as Tab, label: t("tabs.jobs") }] : []),
    { id: "volumes", label: t("tabs.volumes") },
    { id: "settings", label: t("tabs.settings") },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={<ProjectCrumb projectId={projectId!} />}
        title={<span className="flex items-center gap-3">{s.service.name} <StatusBadge status={env?.instance?.status ?? "idle"} /></span>}
        subtitle={env?.url ? <a href={env.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg underline-offset-4 hover:underline">{env.url.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" /></a> : `${s.service.type} service`}
        actions={
          <>
            <Select value={envId} onChange={(e) => setParams((p) => { p.set("env", e.target.value); return p; })} className="w-40">
              {s.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
            {can("deploy:create") && (
              <>
                <Button onClick={() => action(`/services/${s.service.id}/restart`, "Restarting")}><RotateCcw className="size-4" /> {t("Restart")}</Button>
                <Button onClick={() => action(`/services/${s.service.id}/stop`, "Stopping")}><Square className="size-4" /> {t("Stop")}</Button>
                <Button variant="primary" onClick={() => action(`/services/${s.service.id}/deploy`, "Deployment queued").then(() => setTab("deployments"))}>{t("deploy.deploy")}</Button>
              </>
            )}
          </>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t("Status")} className="lg:col-span-2">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-xs text-muted">{t("Instance")}</dt><dd><StatusBadge status={env?.instance?.status ?? "idle"} /></dd></div>
              <div><dt className="text-xs text-muted">{t("Type")}</dt><dd>{s.service.type}</dd></div>
              <div><dt className="text-xs text-muted">{t("Source")}</dt><dd className="truncate">{s.service.source.repo ?? s.service.source.url ?? s.service.source.image ?? s.service.source.kind} {s.service.source.branch && <Badge>{s.service.source.branch}</Badge>}</dd></div>
              <div><dt className="text-xs text-muted">{t("Private host")}</dt><dd className="font-mono text-xs">{env?.internalHost}</dd></div>
              <div><dt className="text-xs text-muted">{t("Resources")}</dt><dd>{s.service.config.resources.cpu} {t("vCPU ·")} {s.service.config.resources.memoryMb} {t("MB · ×")}{s.service.config.resources.replicas}</dd></div>
              <div><dt className="text-xs text-muted">{t("Detected stack")}</dt><dd>{s.service.analysis?.framework ?? s.service.analysis?.runtime ?? "–"}</dd></div>
            </dl>
            {env?.instance?.canaryDeploymentId && (
              <div className="mt-4 rounded-md border border-line p-3 text-sm">
                <div className="mb-2 font-medium">{t("Canary release:")} {env.instance.canaryWeight}{t("% of traffic")}</div>
                <div className="flex gap-2">
                  {[10, 25, 50].map((w) => <Button key={w} size="sm" onClick={() => post(`/services/${s.service.id}/canary`, { environmentId: envId, action: "set_weight", weight: w })}>{w}%</Button>)}
                  <Button size="sm" variant="primary" onClick={() => post(`/services/${s.service.id}/canary`, { environmentId: envId, action: "promote" })}>{t("Promote")}</Button>
                  <Button size="sm" variant="danger" onClick={() => post(`/services/${s.service.id}/canary`, { environmentId: envId, action: "abort" })}>{t("Abort")}</Button>
                </div>
              </div>
            )}
          </Card>
          <Card title={t("Databases")}>
            {s.databases.length ? <ul className="space-y-2 text-sm">{s.databases.map((d) => <li key={d.id}><Link to={`/projects/${projectId}/databases/${d.id}`} className="hover:underline">{d.name}</Link> <Badge>{d.engine}</Badge> <code className="font-mono text-xs text-muted">{d.variableName}</code></li>)}</ul> : <p className="text-sm text-muted">{t("No database connected.")}</p>}
          </Card>
          <div className="lg:col-span-3"><DeploymentsTab s={s} envId={envId} /></div>
        </div>
      )}
      {tab === "deployments" && <DeploymentsTab s={s} envId={envId} />}
      {tab === "code" && ["github", "gitlab", "bitbucket"].includes(s.service.source.kind!) && <Suspense fallback={<LoadingRows rows={6} />}><CodeEditor serviceId={s.service.id} canEdit={can("service:update")} /></Suspense>}
      {tab === "logs" && <RuntimeLogs serviceId={s.service.id} envId={envId} />}
      {tab === "variables" && envId && <VariablesEditor environmentId={envId} serviceId={s.service.id} onRedeploy={() => action(`/services/${s.service.id}/redeploy`, "Redeploying with the new variables")} />}
      {tab === "settings" && <SettingsTab s={s} onSaved={() => q.refetch()} />}
      {tab === "domains" && <DomainsTab s={s} envId={envId} />}
      {tab === "metrics" && <MetricsTab serviceId={s.service.id} envId={envId} />}
      {tab === "screenshots" && <ScreenshotsTab s={s} envId={envId} />}
      {tab === "shell" && <ShellTab serviceId={s.service.id} envId={envId} />}
      {tab === "jobs" && <JobsTab s={s} envId={envId} />}
      {tab === "volumes" && <VolumesTab s={s} onChange={() => q.refetch()} />}
    </>
  );
}
