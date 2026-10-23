import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Database, Box } from "lucide-react";
import type { Template } from "@skyhost/shared";
import { get, post } from "../lib/api";
import { useSession } from "../lib/session";
import { Badge, Button, ErrorState, Field, Input, LoadingRows, Modal, PageHeader, useToast } from "../components/ui";

export default function Templates() {
  const { t } = useTranslation();
  const { team } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ["templates"], queryFn: () => get<{ templates: Template[] }>("/templates") });
  const [chosen, setChosen] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const deploy = useMutation({
    mutationFn: () => post<{ projectId: string }>(`/templates/${chosen!.id}/deploy`, { teamId: team!.id, projectName: name || undefined }),
    onSuccess: (r) => nav(`/projects/${r.projectId}`),
    onError: (e) => toast("error", (e as Error).message),
  });
  if (q.isLoading) return <LoadingRows rows={4} />;
  if (q.error) return <ErrorState error={q.error} />;
  const list = q.data!.templates.filter((x) => !filter || `${x.name} ${x.description} ${x.tags.join(" ")}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <PageHeader title={t("nav.templates")} subtitle="Start from a working stack: services, databases and variables are created and deployed for you." actions={<Input placeholder="Filter templates" value={filter} onChange={(e) => setFilter(e.target.value)} />} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((tpl) => (
          <div key={tpl.id} className="flex flex-col rounded-lg border border-line bg-panel p-4">
            <h3 className="font-semibold">{tpl.name}</h3>
            <p className="mt-1 flex-1 text-sm text-muted">{tpl.description}</p>
            <div className="my-3 flex flex-wrap gap-1.5 text-xs">
              {tpl.services.map((s) => <Badge key={s.name}><Box className="mr-1 inline size-3" />{s.name}</Badge>)}
              {tpl.databases.map((d) => <Badge key={d.name}><Database className="mr-1 inline size-3" />{d.engine}</Badge>)}
            </div>
            <div className="flex flex-wrap gap-1 text-xs text-faint">{tpl.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
            <Button variant="primary" className="mt-3" onClick={() => { setChosen(tpl); setName(tpl.name); }}>Deploy</Button>
          </div>
        ))}
      </div>
      <Modal open={!!chosen} onClose={() => setChosen(null)} title={`Deploy ${chosen?.name}`} footer={<><Button onClick={() => setChosen(null)}>Cancel</Button><Button variant="primary" loading={deploy.isPending} onClick={() => deploy.mutate()}>Deploy</Button></>}>
        <Field label="Project name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <p className="mt-3 text-sm text-muted">Creates {chosen?.services.length} service(s) and {chosen?.databases.length} database(s) in {team?.name}. Generated secrets are stored encrypted.</p>
      </Modal>
    </>
  );
}
