import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Boxes, Container, FileArchive, FolderGit2, GitBranch, Github, Gitlab, Globe, HelpCircle, Package, Sparkles } from "lucide-react";
import { DATABASE_ENGINES } from "@skyhost/shared";
import { api, get, post } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, LoadingRows, PageHeader, Select, Toggle, useToast } from "../components/ui";

type SourceTab = "github" | "gitlab" | "bitbucket" | "git" | "zip" | "image" | "empty";

interface Analysis {
  rootDir: string;
  runtime: string;
  framework: string | null;
  packageManager: string | null;
  version: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  outputDirectory: string | null;
  serviceType: "web" | "static" | "worker";
  dockerDetected: boolean;
  databaseDetected: Array<{ engine: string; reason: string; variable?: string }>;
  environmentVariables: Array<{ key: string; defaultValue?: string; required: boolean; source: string }>;
  monorepo: { tool: string; packages: Array<{ path: string; name: string; deployable: boolean; analysis?: Analysis }> } | null;
  compose: Array<{ name: string; image?: string; managedDatabase?: string; ports: number[] }> | null;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  warnings: string[];
  suggestions: Array<{ file: string; message: string }>;
}

interface Installation {
  id: string;
  provider: string;
  accountLogin: string;
}

interface ServiceDraft {
  enabled: boolean;
  name: string;
  type: string;
  analysis: Analysis;
  rootDir: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  port: string;
  outputDirectory: string;
  variables: Array<{ key: string; value: string; secret: boolean; required: boolean }>;
}

function draftFrom(a: Analysis, name: string): ServiceDraft {
  return {
    enabled: true,
    name,
    type: a.dockerDetected && a.runtime === "docker" ? "docker" : a.serviceType,
    analysis: a,
    rootDir: a.rootDir,
    installCommand: a.installCommand ?? "",
    buildCommand: a.buildCommand ?? "",
    startCommand: a.startCommand ?? "",
    port: a.port ? String(a.port) : "",
    outputDirectory: a.outputDirectory ?? "",
    variables: a.environmentVariables
      .filter((v) => !["DATABASE_URL", "MONGODB_URI", "REDIS_URL"].includes(v.key))
      .map((v) => ({ key: v.key, value: v.defaultValue ?? "", secret: /SECRET|TOKEN|KEY|PASSWORD/i.test(v.key), required: v.required })),
  };
}

function ConfidenceBadge({ c }: { c: Analysis["confidence"] }) {
  const { t } = useTranslation();
  return <span className={cx("rounded px-2 py-0.5 text-xs font-medium", c === "high" ? "bg-green-500/15 text-green-500" : c === "medium" ? "bg-amber-500/15 text-amber-500" : "bg-red-500/15 text-red-500")}>{t(`deploy.confidence.${c}`)}</span>;
}

function RepoPicker({ installation, onPick }: { installation: Installation; onPick: (repo: string, branch: string) => void }) {
  const [q, setQ] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const { t } = useTranslation();
  const repos = useQuery({ queryKey: ["repos", installation.id], queryFn: () => get<{ repositories: Array<{ fullName: string; defaultBranch: string; private: boolean; updatedAt?: string }> }>(`/git/installations/${installation.id}/repos`) });
  const branches = useQuery({ queryKey: ["branches", installation.id, repo], queryFn: () => get<{ defaultBranch: string; branches: string[] }>(`/git/installations/${installation.id}/branches?repo=${encodeURIComponent(repo!)}`), enabled: !!repo });
  const [branch, setBranch] = useState("");
  useEffect(() => {
    if (branches.data) setBranch(branches.data.defaultBranch);
  }, [branches.data]);
  const list = (repos.data?.repositories ?? []).filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-3">
      <Input placeholder={t("deploy.searchRepos")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {repos.isLoading && <LoadingRows rows={4} />}
      {repos.error && <ErrorState error={repos.error} onRetry={() => repos.refetch()} />}
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
        {list.map((r) => (
          <li key={r.fullName}>
            <button onClick={() => setRepo(r.fullName)} className={cx("flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-panel-2", repo === r.fullName && "bg-panel-2")}>
              <span className="flex items-center gap-2">
                <FolderGit2 className="size-4 text-muted" /> {r.fullName}
              </span>
              {r.private && <Badge>private</Badge>}
            </button>
          </li>
        ))}
        {repos.data && !list.length && <li className="px-3 py-6 text-center text-sm text-muted">No repository matches.</li>}
      </ul>
      {repo && (
        <div className="flex items-end gap-2">
          <Field label={<span className="flex items-center gap-1"><GitBranch className="size-3.5" /> Branch</span>} className="flex-1">
            <Select value={branch} onChange={(e) => setBranch(e.target.value)}>
              {(branches.data?.branches ?? [branch]).map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" disabled={!branch} onClick={() => onPick(repo, branch)}>
            Analyze
          </Button>
        </div>
      )}
    </div>
  );
}

export default function NewProject() {
  const { team } = useSession();
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<SourceTab>("github");
  const [source, setSource] = useState<Record<string, string> | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [explanation, setExplanation] = useState<string[]>([]);
  const [showExplain, setShowExplain] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [drafts, setDrafts] = useState<ServiceDraft[]>([]);
  const [dbs, setDbs] = useState<Array<{ engine: string; name: string; enabled: boolean }>>([]);
  const [projectName, setProjectName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [image, setImage] = useState("");
  const [imagePort, setImagePort] = useState("80");
  const [error, setError] = useState<string | null>(params.get("error"));

  const providers = useQuery({ queryKey: ["git-providers"], queryFn: () => get<{ github: boolean; gitlab: boolean; bitbucket: boolean }>("/git/providers") });
  const installs = useQuery({ queryKey: ["installations", team?.id], queryFn: () => get<{ installations: Installation[] }>(`/teams/${team!.id}/git/installations`), enabled: !!team });
  const forProvider = (p: string) => installs.data?.installations.filter((i) => i.provider === p) ?? [];
  const [instId, setInstId] = useState<string | null>(params.get("installation"));

  const analyze = useMutation({
    mutationFn: (src: Record<string, string>) => post<{ analysis: Analysis; explanation: string[] }>("/projects/analyze", { teamId: team!.id, source: src }),
    onSuccess: (r, src) => {
      setSource(src);
      setAnalysis(r.analysis);
      setExplanation(r.explanation);
      const a = r.analysis;
      const repoName = (src.repo ?? src.url ?? "app").split("/").pop()!.replace(/\.git$/, "");
      setProjectName((n) => n || repoName);
      const list: ServiceDraft[] = [];
      if (a.monorepo?.packages.filter((p) => p.deployable).length) {
        for (const p of a.monorepo.packages.filter((x) => x.deployable)) list.push(draftFrom(p.analysis ?? a, p.path.split("/").pop()!));
      } else list.push(draftFrom(a, a.serviceType === "static" ? "site" : a.serviceType === "worker" ? "worker" : "web"));
      setDrafts(list);
      setDbs(a.databaseDetected.map((d) => ({ engine: d.engine, name: d.engine === "postgres" ? "db" : d.engine === "redis" ? "cache" : d.engine, enabled: true })));
      setAdvanced(a.confidence !== "high");
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const launch = useMutation({
    mutationFn: async () => {
      const services = drafts
        .filter((d) => d.enabled)
        .map((d) => ({
          name: d.name,
          type: d.type,
          analysis: d.analysis,
          config: advanced
            ? { rootDir: d.rootDir || ".", installCommand: d.installCommand || undefined, buildCommand: d.buildCommand || undefined, startCommand: d.startCommand || undefined, port: d.port ? Number(d.port) : undefined, outputDirectory: d.outputDirectory || undefined }
            : { rootDir: d.rootDir || "." },
          variables: d.variables.filter((v) => v.key).map((v) => ({ key: v.key, value: v.value, secret: v.secret })),
        }));
      const connectTo = services.filter((s) => s.type !== "static").map((s) => s.name);
      return post<{ projectId: string }>("/projects/launch", { teamId: team!.id, projectName: projectName || undefined, source, services, databases: dbs.filter((d) => d.enabled).map((d) => ({ name: d.name, engine: d.engine, connectTo })) });
    },
    onSuccess: (r) => {
      toast("success", "Deployment started");
      nav(`/projects/${r.projectId}`);
    },
    onError: (e) => setError((e as Error).message),
  });

  const deployImage = useMutation({
    mutationFn: () => post<{ projectId: string }>("/projects/launch", { teamId: team!.id, projectName: projectName || image.split("/").pop()!.split(":")[0], source: { kind: "image", image }, services: [{ name: image.split("/").pop()!.split(":")[0]!.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40) || "app", type: "docker", config: { port: Number(imagePort) || undefined } }] }),
    onSuccess: (r) => nav(`/projects/${r.projectId}`),
    onError: (e) => setError((e as Error).message),
  });

  const emptyProject = useMutation({
    mutationFn: () => post<{ project: { id: string } }>("/projects", { teamId: team!.id, name: projectName || "New project" }),
    onSuccess: (r) => nav(`/projects/${r.project.id}`),
    onError: (e) => setError((e as Error).message),
  });

  const uploadZip = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await api<{ upload: { id: string } }>(`/uploads?teamId=${team!.id}`, { form });
      setProjectName(file.name.replace(/\.zip$/i, ""));
      analyze.mutate({ kind: "zip", uploadId: r.upload.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tabs: Array<{ id: SourceTab; label: string; icon: React.ReactNode }> = [
    { id: "github", label: "GitHub", icon: <Github className="size-4" /> },
    { id: "gitlab", label: "GitLab", icon: <Gitlab className="size-4" /> },
    { id: "bitbucket", label: "Bitbucket", icon: <FolderGit2 className="size-4" /> },
    { id: "git", label: t("deploy.fromUrl"), icon: <Globe className="size-4" /> },
    { id: "zip", label: t("deploy.fromZip"), icon: <FileArchive className="size-4" /> },
    { id: "image", label: t("deploy.fromImage"), icon: <Container className="size-4" /> },
    { id: "empty", label: t("deploy.empty"), icon: <Package className="size-4" /> },
  ];

  const update = (i: number, patch: Partial<ServiceDraft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const missingRequired = useMemo(() => drafts.some((d) => d.enabled && d.variables.some((v) => v.required && !v.value)), [drafts]);

  if (!team) return null;

  return (
    <>
      <PageHeader title={t("deploy.title")} subtitle="Connect a repository and SKYHOST detects how to build and run it." actions={<Link to="/templates"><Button><Boxes className="size-4" /> {t("deploy.fromTemplate")}</Button></Link>} />
      {error && <div className="mb-4"><Alert kind="error">{error}</Alert></div>}

      {!analysis && (
        <div className="grid gap-6 md:grid-cols-[220px_1fr]">
          <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col">
            {tabs.map((x) => (
              <button key={x.id} onClick={() => setTab(x.id)} className={cx("flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm", tab === x.id ? "bg-panel-2 font-medium" : "text-muted hover:bg-panel-2")}>
                {x.icon} {x.label}
              </button>
            ))}
          </nav>
          <Card>
            {analyze.isPending ? (
              <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted">
                <Sparkles className="size-6 animate-pulse text-accent" />
                {t("deploy.analyzing")}
              </div>
            ) : ["github", "gitlab", "bitbucket"].includes(tab) ? (
              (() => {
                const list = forProvider(tab);
                const configured = providers.data?.[tab as "github"];
                const connectUrl = tab === "github" ? `/api/v1/git/github/install?teamId=${team.id}` : `/api/v1/git/${tab}/connect?teamId=${team.id}`;
                if (installs.isLoading) return <LoadingRows />;
                if (!list.length)
                  return (
                    <EmptyState
                      title={`Connect ${tab === "github" ? "GitHub" : tab === "gitlab" ? "GitLab" : "Bitbucket"}`}
                      description={configured ? "Grant SKYHOST access to the repositories you want to deploy. You choose exactly which repositories are shared." : "This provider is not configured on this SKYHOST installation. Ask your administrator, or deploy from a public Git URL."}
                      action={configured ? <a href={connectUrl}><Button variant="primary">Connect</Button></a> : <Button onClick={() => setTab("git")}>{t("deploy.fromUrl")}</Button>}
                    />
                  );
                const current = list.find((i) => i.id === instId) ?? list[0]!;
                return (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Select value={current.id} onChange={(e) => setInstId(e.target.value)} className="max-w-xs">
                        {list.map((i) => (
                          <option key={i.id} value={i.id}>{i.accountLogin}</option>
                        ))}
                      </Select>
                      <a href={connectUrl} className="text-sm text-accent">+ Add account</a>
                    </div>
                    <RepoPicker installation={current} onPick={(repo, branch) => analyze.mutate({ kind: tab, repo, branch, installationId: current.id })} />
                  </div>
                );
              })()
            ) : tab === "git" ? (
              <form onSubmit={(e) => { e.preventDefault(); analyze.mutate({ kind: "git", url: gitUrl }); }} className="space-y-4">
                <Field label="Repository URL" hint="Public HTTPS URL, e.g. https://github.com/vercel/next-learn">
                  <Input required type="url" placeholder="https://github.com/owner/repo" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} />
                </Field>
                <Button variant="primary">Analyze</Button>
              </form>
            ) : tab === "zip" ? (
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center text-sm text-muted hover:border-faint">
                <FileArchive className="size-8" />
                Drop a ZIP of your project here or click to choose (max 100 MB)
                <input type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadZip(e.target.files[0])} />
              </label>
            ) : tab === "image" ? (
              <form onSubmit={(e) => { e.preventDefault(); deployImage.mutate(); }} className="space-y-4">
                <Field label="Image" hint="From Docker Hub or any public registry, e.g. ghcr.io/owner/app:1.2">
                  <Input required placeholder="nginx:alpine" value={image} onChange={(e) => setImage(e.target.value)} />
                </Field>
                <Field label="Port">
                  <Input value={imagePort} onChange={(e) => setImagePort(e.target.value)} inputMode="numeric" />
                </Field>
                <Button variant="primary" loading={deployImage.isPending}>{t("deploy.deploy")}</Button>
              </form>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); emptyProject.mutate(); }} className="space-y-4">
                <Field label="Project name">
                  <Input required value={projectName} onChange={(e) => setProjectName(e.target.value)} />
                </Field>
                <Button variant="primary" loading={emptyProject.isPending}>{t("common.create")}</Button>
              </form>
            )}
          </Card>
        </div>
      )}

      {analysis && (
        <div className="space-y-4">
          <Card
            title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" /> {t("deploy.detected")} <ConfidenceBadge c={analysis.confidence} /></span>}
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => setShowExplain(!showExplain)}>
                  <HelpCircle className="size-3.5" /> {t("deploy.explain")}
                </Button>
                <Button size="sm" onClick={() => setAdvanced(!advanced)}>{t("deploy.editConfig")}</Button>
              </>
            }
          >
            <div className="grid gap-4 text-sm sm:grid-cols-4">
              <div><div className="text-xs text-muted">Stack</div><div className="font-medium">{analysis.framework ?? analysis.runtime}{analysis.version ? ` · ${analysis.version}` : ""}</div></div>
              <div><div className="text-xs text-muted">Package manager</div><div className="font-medium">{analysis.packageManager ?? "–"}</div></div>
              <div><div className="text-xs text-muted">Type</div><div className="font-medium">{analysis.serviceType}</div></div>
              <div><div className="text-xs text-muted">Port</div><div className="font-medium">{analysis.port ?? "–"}</div></div>
            </div>
            {showExplain && (
              <ul className="mt-4 list-disc space-y-1 rounded-md bg-panel-2 p-4 pl-8 text-sm text-muted">
                {explanation.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
            {analysis.warnings.map((w) => <div key={w} className="mt-3"><Alert kind="warn">{w}</Alert></div>)}
            {analysis.suggestions.map((s) => <div key={s.message} className="mt-3"><Alert kind="info"><strong>{s.file}:</strong> {s.message}</Alert></div>)}
            <div className="mt-4 flex items-center gap-3">
              <Toggle checked={advanced} onChange={setAdvanced} label={advanced ? t("deploy.advanced") : t("deploy.simple")} />
              {!advanced && analysis.confidence === "high" && <span className="text-xs text-muted">Everything is configured automatically. You can change it later.</span>}
            </div>
          </Card>

          <Card title="Project">
            <Field label="Project name"><Input value={projectName} onChange={(e) => setProjectName(e.target.value)} /></Field>
          </Card>

          {drafts.map((d, i) => (
            <Card key={i} title={<span className="flex items-center gap-2">{drafts.length > 1 && <input type="checkbox" checked={d.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />} Service <code className="font-mono text-xs text-muted">{d.rootDir}</code></span>}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name"><Input value={d.name} onChange={(e) => update(i, { name: e.target.value })} /></Field>
                <Field label="Type">
                  <Select value={d.type} onChange={(e) => update(i, { type: e.target.value })}>
                    {["web", "static", "worker", "private", "docker", "cron"].map((x) => <option key={x}>{x}</option>)}
                  </Select>
                </Field>
                {advanced && (
                  <>
                    <Field label="Root directory"><Input value={d.rootDir} onChange={(e) => update(i, { rootDir: e.target.value })} /></Field>
                    <Field label="Port"><Input value={d.port} onChange={(e) => update(i, { port: e.target.value })} inputMode="numeric" /></Field>
                    <Field label="Install command"><Input className="font-mono" value={d.installCommand} onChange={(e) => update(i, { installCommand: e.target.value })} /></Field>
                    <Field label="Build command"><Input className="font-mono" value={d.buildCommand} onChange={(e) => update(i, { buildCommand: e.target.value })} /></Field>
                    <Field label="Start command"><Input className="font-mono" value={d.startCommand} onChange={(e) => update(i, { startCommand: e.target.value })} /></Field>
                    <Field label="Output directory"><Input className="font-mono" value={d.outputDirectory} onChange={(e) => update(i, { outputDirectory: e.target.value })} /></Field>
                  </>
                )}
              </div>
              {(d.variables.length > 0 || advanced) && (
                <div className="mt-4">
                  <div className="mb-2 text-sm font-medium">Variables</div>
                  <div className="space-y-2">
                    {d.variables.map((v, j) => (
                      <div key={j} className="flex gap-2">
                        <Input className="w-56 font-mono" value={v.key} onChange={(e) => update(i, { variables: d.variables.map((x, k) => (k === j ? { ...x, key: e.target.value.toUpperCase() } : x)) })} />
                        <Input className={cx("flex-1 font-mono", v.required && !v.value && "border-amber-500")} type={v.secret ? "password" : "text"} placeholder={v.required ? "required" : ""} value={v.value} onChange={(e) => update(i, { variables: d.variables.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} />
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => update(i, { variables: [...d.variables, { key: "", value: "", secret: false, required: false }] })}>+ Add variable</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}

          {(dbs.length > 0 || advanced) && (
            <Card title="Databases" actions={advanced && <Select className="w-40" onChange={(e) => { if (e.target.value) setDbs([...dbs, { engine: e.target.value, name: e.target.value === "postgres" ? "db" : e.target.value, enabled: true }]); e.target.value = ""; }}><option value="">+ Add database</option>{DATABASE_ENGINES.map((x) => <option key={x}>{x}</option>)}</Select>}>
              {dbs.length ? (
                <ul className="space-y-2">
                  {dbs.map((d, i) => (
                    <li key={i} className="flex items-center gap-3 text-sm">
                      <input type="checkbox" checked={d.enabled} onChange={(e) => setDbs(dbs.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
                      <Badge>{d.engine}</Badge>
                      <Input className="w-40" value={d.name} onChange={(e) => setDbs(dbs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                      <span className="text-muted">{analysis.databaseDetected.find((x) => x.engine === d.engine)?.reason ?? "Added manually"} · connected automatically</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted">No database needed.</p>}
            </Card>
          )}

          {analysis.compose && (
            <Alert kind="info">A docker-compose file describes {analysis.compose.length} services ({analysis.compose.map((c) => c.name).join(", ")}). Database services are replaced by managed databases above; other services are created from their build directories.</Alert>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button onClick={() => { setAnalysis(null); setSource(null); }}>{t("common.back")}</Button>
            <Button variant="primary" loading={launch.isPending} onClick={() => launch.mutate()} disabled={!drafts.some((d) => d.enabled)}>
              {t("deploy.deploy")}
            </Button>
          </div>
          {missingRequired && <p className="text-right text-xs text-amber-500">Some required variables are empty: the app may fail to start. You can fill them later.</p>}
        </div>
      )}
    </>
  );
}
