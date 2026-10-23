import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { t } from "../lib/i18n";

/** "Projects / <project name>" breadcrumb; shares the project query cache with the project page. */
export function ProjectCrumb({ projectId, withRoot = true }: { projectId: string; withRoot?: boolean }) {
  const q = useQuery({ queryKey: ["project", projectId], queryFn: () => get(`/projects/${projectId}`) });
  const name = (q.data as { project?: { name: string } } | undefined)?.project?.name ?? t("Project");
  return (
    <>
      {withRoot && <><Link to="/">{t("nav.projects")}</Link> / </>}
      <Link to={`/projects/${projectId}`}>{name}</Link>
    </>
  );
}
