import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Database, Plus, Rocket } from "lucide-react";
import { get } from "../lib/api";
import { useRealtimeInvalidate, useSession } from "../lib/session";
import { Onboarding } from "../components/Onboarding";
import { Button, EmptyState, ErrorState, LoadingRows, PageHeader, StatusBadge, timeAgo, Meter, Card } from "../components/ui";
import { t } from "../lib/i18n";
import { useCapabilities } from "../lib/capabilities";
import { serviceStatus } from "../lib/status";
import { limitLabel, limitValue } from "../lib/labels";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  services: Array<{ id: string; name: string; type: string; status: string; latestDeploymentStatus: string | null }>;
  databases: Array<{ id: string; name: string; engine: string; status: string }>;
}

export default function Dashboard() {
  const caps = useCapabilities();
  const { team } = useSession();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["projects", team?.id], queryFn: () => get<{ projects: ProjectRow[] }>(`/teams/${team!.id}/projects`), enabled: !!team });
  const usage = useQuery({ queryKey: ["usage", team?.id], queryFn: () => get<{ plan: { name: string }; items: Array<{ key: string; label: string; current: number; limit: number }> }>(`/teams/${team!.id}/usage`), enabled: !!team });
  useRealtimeInvalidate(team ? `team:${team.id}` : null, [["projects", team?.id]]);
  return (
    <>
      <PageHeader
        title={t("nav.projects")}
        subtitle={team?.name}
        actions={
          <Link to="/new">
            <Button variant="primary">
              <Plus className="size-4" /> {t("nav.new")}
            </Button>
          </Link>
        }
      />
      <Onboarding />
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div>
          {q.isLoading && <LoadingRows rows={4} />}
          {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
          {q.data && !q.data.projects.length && (
            <EmptyState
              icon={<Rocket className="size-8" />}
              title={t("Deploy your first project")}
              description={caps.git.github ? t("Connect GitHub, pick a repository and SKYHOST analyzes, configures and deploys it for you.") : t("Give SKYHOST a Git URL, a ZIP or a Docker image: it analyzes, configures and deploys it for you.")}
              action={
                <Link to="/new">
                  <Button variant="primary">{caps.git.github ? t("deploy.fromGithub") : t("New project")}</Button>
                </Link>
              }
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {q.data?.projects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="group rounded-lg border border-line bg-panel p-4 transition-colors hover:border-faint">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold group-hover:underline">{p.name}</h3>
                  <span className="text-xs text-faint">{timeAgo(p.createdAt)}</span>
                </div>
                {p.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{p.description}</p>}
                <ul className="mt-3 space-y-1.5">
                  {p.services.slice(0, 5).map((s) => (
                    <li key={s.id} className="flex items-center justify-between text-sm">
                      <span className="truncate">{s.name}</span>
                      <StatusBadge status={serviceStatus(s.status, s.latestDeploymentStatus)} />
                    </li>
                  ))}
                  {p.databases.map((d) => (
                    <li key={d.id} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1.5 text-muted">
                        <Database className="size-3.5" /> {d.name} <span className="text-xs text-faint">{d.engine}</span>
                      </span>
                      <StatusBadge status={d.status} />
                    </li>
                  ))}
                  {!p.services.length && !p.databases.length && <li className="text-sm text-faint">{t("Empty project")}</li>}
                </ul>
              </Link>
            ))}
          </div>
        </div>
        <Card title={t("Usage · {{plan}}", { plan: usage.data?.plan.name ?? "" })} actions={<Link to="/billing" className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline">{t("Upgrade")}</Link>}>
          {usage.isLoading ? (
            <LoadingRows rows={3} />
          ) : (
            <div className="space-y-3">
              {usage.data?.items
                .filter((i) => ["projects", "services", "databases", "buildMinutes", "deploysPerDay", "customDomains"].includes(i.key))
                .map((i) => <Meter key={i.key} value={i.current} max={i.limit} label={limitLabel(i.key)} format={(v) => limitValue(i.key, v)} />)}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
