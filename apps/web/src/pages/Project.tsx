import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Box, Clock, Cpu, Database, Globe, HardDrive, Plus, Server } from "lucide-react";
import { DATABASE_ENGINES } from "@skyhost/shared";
import { del, download, get, patch, post, put } from "../lib/api";
import { useRealtimeInvalidate, useSession } from "../lib/session";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Tabs, Toggle, timeAgo, useToast } from "../components/ui";
import { t } from "../lib/i18n";

export interface ProjectDetail {
  project: { id: string; name: string; teamId: string; description: string | null; canvas: Record<string, { x: number; y: number }>; statusPageEnabled: boolean; statusPageSlug: string | null };
  role: string;
  permissions: string[];
  environments: Array<{ id: string; name: string; type: string; prNumber: number | null }>;
  services: Array<{ id: string; name: string; slug: string; type: string; source: Record<string, string>; instances: Array<{ environmentId: string; status: string; url: string | null; latestDeployment: { id: string; status: string; commitMessage: string | null; createdAt: string } | null }> }>;
  databases: Array<{ id: string; name: string; engine: string; version: string; status: string; environmentId: string | null; connections: Array<{ serviceId: string; variableName: string }> }>;
  buckets: Array<{ id: string; name: string; isPublic: boolean }>;
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  web: <Globe className="size-4" />,
  static: <Globe className="size-4" />,
  worker: <Cpu className="size-4" />,
  cron: <Clock className="size-4" />,
  private: <Server className="size-4" />,
  docker: <Box className="size-4" />,
  job: <Cpu className="size-4" />,
};

function ServiceNode({ data }: NodeProps) {
  const d = data as { name: string; type: string; status: string; url: string | null; subtitle: string; kind: string; engine?: string };
  return (
    <div className="w-56 rounded-lg border border-line bg-panel p-3 text-fg shadow-sm hover:border-faint">
      <Handle type="target" position={Position.Left} className="!bg-line" />
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="text-muted">{d.kind === "database" ? <Database className="size-4" /> : d.kind === "bucket" ? <HardDrive className="size-4" /> : TYPE_ICON[d.type]}</span>
        <span className="truncate">{d.name}</span>
      </div>
      <div className="mt-1 truncate text-xs text-muted">{d.subtitle}</div>
      <div className="mt-2">
        <StatusBadge status={d.status} />
      </div>
      <Handle type="source" position={Position.Right} className="!bg-line" />
    </div>
  );
}
const nodeTypes = { item: ServiceNode };

function Canvas({ data, envId }: { data: ProjectDetail; envId: string }) {
  const nav = useNavigate();
  const canEdit = data.permissions.includes("project:update");
  const initial = useMemo<Node[]>(() => {
    const pos = data.project.canvas ?? {};
    const out: Node[] = [];
    data.services.forEach((s, i) => {
      const inst = s.instances.find((x) => x.environmentId === envId);
      out.push({ id: s.id, type: "item", position: pos[s.id] ?? { x: 320, y: 40 + i * 140 }, data: { kind: "service", name: s.name, type: s.type, status: inst?.latestDeployment && inst.latestDeployment.status !== "live" && inst.latestDeployment.status !== "superseded" ? inst.latestDeployment.status : (inst?.status ?? "idle"), url: inst?.url, subtitle: inst?.url?.replace(/^https?:\/\//, "") ?? s.type } });
    });
    data.databases.filter((d) => !d.environmentId || d.environmentId === envId).forEach((d, i) => {
      out.push({ id: d.id, type: "item", position: pos[d.id] ?? { x: 20, y: 40 + i * 140 }, data: { kind: "database", name: d.name, type: d.engine, status: d.status, subtitle: `${d.engine} ${d.version}` } });
    });
    data.buckets.forEach((b, i) => out.push({ id: b.id, type: "item", position: pos[b.id] ?? { x: 640, y: 40 + i * 140 }, data: { kind: "bucket", name: b.name, type: "bucket", status: "available", subtitle: b.isPublic ? "public bucket" : "private bucket" } }));
    return out;
  }, [data, envId]);
  const [nodes, setNodes] = useState<Node[]>(initial);
  useEffect(() => setNodes(initial), [initial]);
  const edges = useMemo<Edge[]>(() => data.databases.flatMap((d) => d.connections.map((c) => ({ id: `${d.id}-${c.serviceId}`, source: d.id, target: c.serviceId, label: c.variableName, style: { stroke: "var(--sh-faint)" }, labelStyle: { fill: "var(--sh-muted)", fontSize: 10 }, labelBgStyle: { fill: "var(--sh-panel)" } }))), [data]);
  const save = useCallback(
    (ns: Node[]) => {
      if (!canEdit) return;
      void put(`/projects/${data.project.id}/canvas`, { positions: Object.fromEntries(ns.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])) });
    },
    [canEdit, data.project.id],
  );
  if (!nodes.length) return <EmptyState title={t("This project is empty")} description={t("Add a service or a database to get started.")} />;
  return (
    <div className="h-[560px] overflow-hidden rounded-lg border border-line bg-panel-2">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={canEdit}
        onNodesChange={(changes) =>
          setNodes((ns) =>
            ns.map((n) => {
              const c = changes.find((x) => "id" in x && x.id === n.id && x.type === "position") as { position?: { x: number; y: number } } | undefined;
              return c?.position ? { ...n, position: c.position } : n;
            }),
          )
        }
        onNodeDragStop={() => save(nodes)}
        onNodeClick={(_e, n) => {
          const kind = (n.data as { kind: string }).kind;
          if (kind === "service") nav(`/projects/${data.project.id}/services/${n.id}?env=${envId}`);
          if (kind === "database") nav(`/projects/${data.project.id}/databases/${n.id}`);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--sh-line)" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function AddMenu({ data, onDone }: { data: ProjectDetail; onDone: () => void }) {
  const [open, setOpen] = useState<null | "service" | "database" | "bucket">(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"image" | "git">("git");
  const [value, setValue] = useState("");
  const [type, setType] = useState("web");
  const [engine, setEngine] = useState("postgres");
  const [schedule, setSchedule] = useState("0 * * * *");
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const m = useMutation({
    mutationFn: async () => {
      if (open === "service") {
        const source = kind === "image" ? { kind: "image", image: value } : { kind: "git", url: value };
        await post(`/projects/${data.project.id}/services`, { name, type: kind === "image" && type === "web" ? "docker" : type, source, config: type === "cron" ? { cron: { schedule, timezone: "UTC" } } : {}, deploy: true });
      } else if (open === "database") await post("/databases", { projectId: data.project.id, name, engine });
      else await post("/buckets", { projectId: data.project.id, name });
    },
    onSuccess: () => {
      toast("success", t("Created"));
      setOpen(null);
      setName("");
      setValue("");
      onDone();
    },
    onError: (e) => setErr((e as Error).message),
  });
  if (!data.permissions.includes("service:create")) return null;
  return (
    <>
      <Button variant="primary" onClick={() => setOpen("service")}><Plus className="size-4" /> {t("Service")}</Button>
      <Button onClick={() => setOpen("database")}><Database className="size-4" /> {t("Database")}</Button>
      <Button onClick={() => setOpen("bucket")}><HardDrive className="size-4" /> {t("Bucket")}</Button>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open === "service" ? t("New service") : open === "database" ? t("New database") : t("New bucket")} footer={<Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>{t("Create")}</Button>}>
        <div className="space-y-4">
          {err && <Alert kind="error">{err}</Alert>}
          <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={open === "database" ? "db" : open === "bucket" ? "uploads" : "api"} /></Field>
          {open === "service" && (
            <>
              <div className="flex gap-2">
                <Button size="sm" variant={kind === "git" ? "primary" : "secondary"} onClick={() => setKind("git")}>{t("Git repository")}</Button>
                <Button size="sm" variant={kind === "image" ? "primary" : "secondary"} onClick={() => setKind("image")}>{t("Docker image")}</Button>
                <Link to="/new" className="ml-auto text-sm text-accent">{t("GitHub / ZIP…")}</Link>
              </div>
              <Field label={kind === "git" ? t("Public HTTPS URL") : t("Image")}><Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "git" ? "https://github.com/owner/repo" : "redis:7"} /></Field>
              <Field label={t("Type")}>
                <Select value={type} onChange={(e) => setType(e.target.value)}>
                  {["web", "static", "worker", "private", "cron", "job"].map((x) => <option key={x}>{x}</option>)}
                </Select>
              </Field>
              {type === "cron" && <Field label={t("Schedule (cron, UTC)")}><Input className="font-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} /></Field>}
            </>
          )}
          {open === "database" && (
            <Field label={t("Engine")}>
              <Select value={engine} onChange={(e) => setEngine(e.target.value)}>
                {DATABASE_ENGINES.map((x) => <option key={x}>{x}</option>)}
              </Select>
            </Field>
          )}
        </div>
      </Modal>
    </>
  );
}

function EnvironmentsCard({ data, refetch }: { data: ProjectDetail; refetch: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("staging");
  const [type, setType] = useState("staging");
  const [cloneFrom, setCloneFrom] = useState(data.environments.find((e) => e.type === "production")?.id ?? "");
  const [cloneDbs, setCloneDbs] = useState(false);
  const [anonymize, setAnonymize] = useState(true);
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => post(`/projects/${data.project.id}/environments`, { name, type, cloneFrom: cloneFrom || undefined, cloneDatabases: cloneDbs, anonymize }),
    onSuccess: () => {
      setOpen(false);
      refetch();
      toast("success", t("Environment created"));
    },
    onError: (e) => toast("error", (e as Error).message),
  });
  return (
    <Card title={t("Environments")} actions={<Button size="sm" onClick={() => setOpen(true)}>{t("+ Environment")}</Button>}>
      <ul className="space-y-2 text-sm">
        {data.environments.map((e) => (
          <li key={e.id} className="flex items-center justify-between">
            <span>{e.name} <Badge>{e.type}</Badge></span>
            {e.type !== "production" && <Button size="sm" variant="ghost" onClick={() => del(`/environments/${e.id}`).then(refetch)}>{t("Delete")}</Button>}
          </li>
        ))}
      </ul>
      <Modal open={open} onClose={() => setOpen(false)} title={t("New environment")} footer={<Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>{t("Create")}</Button>}>
        <div className="space-y-4">
          <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Type")}><Select value={type} onChange={(e) => setType(e.target.value)}>{["staging", "development", "preview"].map((x) => <option key={x}>{x}</option>)}</Select></Field>
          <Field label={t("Copy variables from")} hint={t("Preview environments never receive production secrets.")}><Select value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)}><option value="">{t("Nothing")}</option>{data.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
          <Toggle checked={cloneDbs} onChange={setCloneDbs} label={t("Clone databases (copy the data)")} />
          {cloneDbs && <Toggle checked={anonymize} onChange={setAnonymize} label={t("Anonymize personal data (emails, names, phones…)")} />}
        </div>
      </Modal>
    </Card>
  );
}

function SettingsTab({ data, refetch }: { data: ProjectDetail; refetch: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const { teams } = useSession();
  const [name, setName] = useState(data.project.name);
  const [desc, setDesc] = useState(data.project.description ?? "");
  const [confirm, setConfirm] = useState(false);
  const [target, setTarget] = useState("");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t("General")}>
        <div className="space-y-4">
          <Field label={t("Name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("Description")}><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => patch(`/projects/${data.project.id}`, { name, description: desc || null }).then(() => { toast("success", t("Saved")); refetch(); }).catch((e) => toast("error", e.message))}>{t("Save")}</Button>
            <Button onClick={() => download(`/projects/${data.project.id}/export`)}>{t("Export skyhost.json")}</Button>
          </div>
        </div>
      </Card>
      <EnvironmentsCard data={data} refetch={refetch} />
      <Card title={t("Transfer project")}>
        <p className="mb-3 text-sm text-muted">{t("Move this project and its services, databases and buckets to another team you administer.")}</p>
        <div className="flex gap-2">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t("Choose a team")}</option>
            {teams.filter((t) => t.id !== data.project.teamId && ["owner", "admin"].includes(t.role)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Button disabled={!target} onClick={() => post(`/projects/${data.project.id}/transfer`, { targetTeamId: target }).then(() => { toast("success", t("Project transferred")); nav("/"); }).catch((e) => toast("error", e.message))}>{t("Transfer")}</Button>
        </div>
      </Card>
      <Card title={t("Danger zone")} className="border-red-500/30">
        <p className="mb-3 text-sm text-muted">{t("Deleting the project stops every service and deletes its databases. Databases with deletion protection block this action.")}</p>
        <Button variant="danger" onClick={() => setConfirm(true)}>{t("Delete project")}</Button>
        <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t("Delete project")} description={t("This cannot be undone.")} typeToConfirm={data.project.name} onConfirm={() => del(`/projects/${data.project.id}`, { confirmName: data.project.name }).then(() => nav("/")).catch((e) => toast("error", e.message))} />
      </Card>
    </div>
  );
}

function UptimeTab({ data }: { data: ProjectDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["uptime", data.project.id], queryFn: () => get<{ checks: Array<{ id: string; name: string; url: string; lastStatus: string | null; uptime24h: number | null; lastCheckedAt: string | null }> }>(`/projects/${data.project.id}/uptime`) });
  const [name, setName] = useState("Website");
  const [url, setUrl] = useState(data.services.find((s) => s.instances[0]?.url)?.instances[0]?.url ?? "");
  const [slug, setSlug] = useState(data.project.statusPageSlug ?? "");
  const add = useMutation({ mutationFn: () => post(`/projects/${data.project.id}/uptime`, { name, url }), onSuccess: () => qc.invalidateQueries({ queryKey: ["uptime"] }), onError: (e) => toast("error", (e as Error).message) });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card title={t("Uptime checks")}>
        {q.isLoading ? <LoadingRows /> : q.data?.checks.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="pb-2">{t("Name")}</th><th>{t("Status")}</th><th>24h</th><th>{t("Last check")}</th><th /></tr></thead>
            <tbody>
              {q.data.checks.map((c) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="py-2"><div>{c.name}</div><div className="text-xs text-muted">{c.url}</div></td>
                  <td><StatusBadge status={c.lastStatus ?? "pending"} /></td>
                  <td>{c.uptime24h ?? "–"}%</td>
                  <td className="text-muted">{timeAgo(c.lastCheckedAt)}</td>
                  <td><Button size="sm" variant="ghost" onClick={() => del(`/uptime/${c.id}`).then(() => qc.invalidateQueries({ queryKey: ["uptime"] }))}>{t("Remove")}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState title={t("No checks")} description={t("SKYHOST checks your URLs from outside every minute.")} />}
        <div className="mt-4 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          <Button onClick={() => add.mutate()} loading={add.isPending}>{t("Add")}</Button>
        </div>
      </Card>
      <Card title={t("Public status page")}>
        <div className="space-y-3">
          <Field label={t("Address")}><Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("my-app")} /></Field>
          <Button onClick={() => put(`/projects/${data.project.id}/status-page`, { enabled: true, slug: slug || undefined }).then((r: any) => toast("success", t("Published at {{url}}", { url: r.statusPage.url }))).catch((e) => toast("error", e.message))}>{t("Publish")}</Button>
          {data.project.statusPageEnabled && data.project.statusPageSlug && <a className="block text-sm text-accent" href={`/status/${data.project.statusPageSlug}`} target="_blank" rel="noreferrer">{t("View status page")}</a>}
        </div>
      </Card>
    </div>
  );
}

function ChangelogTab({ projectId }: { projectId: string }) {
  const q = useQuery({ queryKey: ["changelog", projectId], queryFn: () => get<{ entries: Array<{ date: string; service: string; commit: string; message: string; author: string; deploymentId: string }> }>(`/projects/${projectId}/changelog`) });
  if (q.isLoading) return <LoadingRows />;
  if (!q.data?.entries.length) return <EmptyState title={t("No releases yet")} description={t("Every live deployment adds its commit to the changelog.")} />;
  const days = [...new Set(q.data.entries.map((e) => e.date))];
  return (
    <div className="space-y-4">
      {days.map((d) => (
        <Card key={d} title={d}>
          <ul className="space-y-2 text-sm">
            {q.data!.entries.filter((e) => e.date === d).map((e) => (
              <li key={e.deploymentId}><Badge>{e.service}</Badge> <code className="font-mono text-xs text-muted">{e.commit}</code> {e.message} <span className="text-muted">— {e.author}</span></li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

export default function Project() {
  const { projectId } = useParams();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["project", projectId], queryFn: () => get<ProjectDetail>(`/projects/${projectId}`) });
  useRealtimeInvalidate(projectId ? `project:${projectId}` : null, [["project", projectId]]);
  const [tab, setTab] = useState<"canvas" | "settings" | "uptime" | "changelog">("canvas");
  const [envId, setEnvId] = useState<string>("");
  useEffect(() => {
    if (q.data && !envId) setEnvId(q.data.environments.find((e) => e.type === "production")?.id ?? q.data.environments[0]?.id ?? "");
  }, [q.data, envId]);
  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to="/">{t("nav.projects")}</Link>}
        title={data.project.name}
        subtitle={data.project.description}
        actions={
          <>
            <Select value={envId} onChange={(e) => setEnvId(e.target.value)} className="w-44" aria-label={t("Environment")}>
              {data.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
            <AddMenu data={data} onDone={() => q.refetch()} />
          </>
        }
      />
      <Tabs tabs={[{ id: "canvas", label: t("tabs.canvas") }, { id: "uptime", label: t("tabs.uptime") }, { id: "changelog", label: t("tabs.changelog") }, { id: "settings", label: t("tabs.settings") }]} value={tab} onChange={setTab} />
      {tab === "canvas" && envId && (
        <div className="space-y-4">
          <Canvas data={data} envId={envId} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.services.map((s) => {
              const inst = s.instances.find((i) => i.environmentId === envId);
              return (
                <Link key={s.id} to={`/projects/${data.project.id}/services/${s.id}?env=${envId}`} className="rounded-lg border border-line bg-panel p-3 hover:border-faint">
                  <div className="flex items-center justify-between"><span className="font-medium">{s.name}</span><StatusBadge status={inst?.status ?? "idle"} /></div>
                  <div className="mt-1 truncate text-xs text-muted">{inst?.url ?? s.type}</div>
                  {inst?.latestDeployment && <div className="mt-2 flex items-center gap-2 text-xs text-muted"><StatusBadge status={inst.latestDeployment.status} /> {inst.latestDeployment.commitMessage?.slice(0, 50)} · {timeAgo(inst.latestDeployment.createdAt)}</div>}
                </Link>
              );
            })}
          </div>
        </div>
      )}
      {tab === "settings" && <SettingsTab data={data} refetch={() => q.refetch()} />}
      {tab === "uptime" && <UptimeTab data={data} />}
      {tab === "changelog" && <ChangelogTab projectId={data.project.id} />}
    </>
  );
}
