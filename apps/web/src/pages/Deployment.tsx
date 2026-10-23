import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, ExternalLink, Loader2, Minus, Wrench, X } from "lucide-react";
import { DEPLOYMENT_PHASES } from "@skyhost/shared";
import { download, get, post, realtime } from "../lib/api";
import { LogViewer, type LogLine } from "../components/LogViewer";
import { Alert, Badge, Button, Card, CopyButton, cx, ErrorState, Field, Input, LoadingRows, Modal, PageHeader, StatusBadge, Textarea, timeAgo, useToast } from "../components/ui";
import { t } from "../lib/i18n";
import { ProjectCrumb } from "../components/ProjectCrumb";

interface Diagnosis {
  id: string;
  problem: string;
  cause: string;
  suggestedFix: string;
  confidence: string;
  evidence: string;
  autoFix?: { kind: string; file?: string; description: string; field?: string; value?: unknown; find?: string; replace?: string; reason: string };
}

const PHASE_LABELS: Record<string, string> = { clone: "Clone", analyze: "Analyze", install: "Install", build: "Build", test: "Test", image: "Image", deploy: "Deploy", healthcheck: "Health check", live: "Live" };

export default function Deployment() {
  const { projectId, deploymentId } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["deployment", deploymentId], queryFn: () => get<{ deployment: any; url: string | null; service: { id: string; name: string } }>(`/deployments/${deploymentId}`) }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [lines, setLines] = useState<LogLine[]>([]);
  const diag = useQuery({ queryKey: ["diagnosis", deploymentId], queryFn: () => get<{ diagnoses: Diagnosis[] }>(`/deployments/${deploymentId}/diagnosis`), enabled: q.data?.deployment.status === "failed" });
  const comments = useQuery({ queryKey: ["comments", deploymentId], queryFn: () => get<{ comments: Array<{ id: string; author: string; body: string; createdAt: string }> }>(`/deployments/${deploymentId}/comments`) });
  const [comment, setComment] = useState("");
  const [fix, setFix] = useState<{ d: Diagnosis; index: number } | null>(null);
  const [fixValue, setFixValue] = useState("");

  useEffect(() => {
    let cursor = 0;
    let stop = false;
    void get<{ lines: Array<{ id: number; line: string; level: string; createdAt: string }>; nextCursor: number }>(`/deployments/${deploymentId}/logs`).then((r) => {
      if (stop) return;
      cursor = r.nextCursor;
      setLines(r.lines.map((l) => ({ id: l.id, line: l.line, level: l.level, ts: l.createdAt })));
    });
    const unsub = realtime.subscribe(`deployment:${deploymentId}`, (m) => {
      if (m.type === "logs") setLines((ls) => [...ls, ...m.lines.filter((l: { id: number }) => l.id > cursor).map((l: { id: number; line: string; level: string; createdAt: string }) => ({ id: l.id, line: l.line, level: l.level, ts: l.createdAt }))]);
      if (m.type === "deployment.status") void qc.invalidateQueries({ queryKey: ["deployment", deploymentId] });
    });
    return () => {
      stop = true;
      unsub();
    };
  }, [deploymentId, qc]);

  const applyFix = useMutation({
    mutationFn: (mode: "apply" | "pull_request") => post<{ applied: boolean; pullRequest?: { url: string }; patch?: unknown; redeployRequired?: boolean; message?: string }>(`/deployments/${deploymentId}/autofix`, { index: fix!.index, mode, value: fixValue || undefined, confirm: true }),
    onSuccess: (r) => {
      setFix(null);
      if (r.pullRequest) toast("success", t("Pull request opened: {{url}}", { url: r.pullRequest.url }));
      else if (r.applied) toast("success", t("Fix applied. Redeploy to use it."));
      else toast("info", r.message ?? t("Apply this change in your repository"));
    },
    onError: (e) => toast("error", (e as Error).message),
  });

  if (q.isLoading) return <LoadingRows rows={5} />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data!.deployment;
  const phases = d.phases ?? {};
  const currentIdx = DEPLOYMENT_PHASES.indexOf(d.phase);
  return (
    <>
      <PageHeader
        breadcrumbs={<><ProjectCrumb projectId={projectId!} /> / <Link to={`/projects/${projectId}/services/${q.data!.service.id}?tab=deployments`}>{q.data!.service.name}</Link></>}
        title={<span className="flex items-center gap-3">{d.commitMessage?.split("\n")[0] ?? t("Deployment {{id}}", { id: d.id.slice(0, 8) })} <StatusBadge status={d.status} /></span>}
        subtitle={<span className="font-mono text-xs">{[d.commitSha?.slice(0, 7), d.branch, d.trigger, timeAgo(d.createdAt), d.buildSeconds ? t("built in {{s}}s", { s: d.buildSeconds }) : null].filter(Boolean).join(" · ")}</span>}
        actions={
          <>
            {d.status === "live" && q.data!.url && (
              <a href={q.data!.url} target="_blank" rel="noreferrer">
                <Button variant="primary"><ExternalLink className="size-4" /> {t("Open app")}</Button>
              </a>
            )}
            {["queued", "building", "deploying"].includes(d.status) && <Button onClick={() => post(`/deployments/${d.id}/cancel`).then(() => toast("info", t("Cancelling")))}>{t("Cancel")}</Button>}
            {d.image && ["superseded", "stopped"].includes(d.status) && <Button onClick={() => post(`/deployments/${d.id}/rollback`).then(() => toast("success", t("Rollback started")))}>{t("Rollback to this version")}</Button>}
          </>
        }
      />
      {q.data!.url && ["live", "queued", "building", "deploying"].includes(d.status) && (
        <div className={cx("mb-6 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3", d.status === "live" ? "border-emerald-500/40 bg-emerald-500/5" : "border-line bg-panel")}>
          <span className={cx("size-2 shrink-0 rounded-full", d.status === "live" ? "bg-emerald-500" : "animate-pulse bg-faint")} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted">{d.status === "live" ? t("Live at") : t("Will be available at")}</div>
            {d.status === "live" ? (
              <a href={q.data!.url} target="_blank" rel="noreferrer" className="block truncate font-mono text-sm font-medium underline-offset-4 hover:underline">{q.data!.url.replace(/^https?:\/\//, "")}</a>
            ) : (
              <span className="block truncate font-mono text-sm text-muted">{q.data!.url.replace(/^https?:\/\//, "")}</span>
            )}
          </div>
          {d.status === "live" && <CopyButton value={q.data!.url} />}
        </div>
      )}
      <ol className="mb-6 flex flex-wrap gap-2">
        {DEPLOYMENT_PHASES.map((p, i) => {
          // A phase is done only if it ran; phases a release did not need (e.g. build for an image) are skipped.
          const reachedLive = d.phase === "live" && ["live", "superseded", "stopped"].includes(d.status);
          const started = !!phases[p] || (p === "live" && reachedLive);
          const failed = d.status === "failed" && p === d.phase;
          const done = started && !failed && (reachedLive || i < currentIdx);
          const active = !done && !failed && p === d.phase && ["building", "deploying"].includes(d.status);
          const skipped = !started && !failed && (reachedLive || i < currentIdx);
          return (
            <li key={p} title={skipped ? t("Skipped") : undefined} className={cx("flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs", done ? "border-green-500/40 text-green-500" : failed ? "border-red-500/40 text-red-500" : active ? "border-brand text-brand" : skipped ? "border-dashed border-line text-faint" : "border-line text-faint")}>
              {done ? <Check className="size-3" /> : failed ? <X className="size-3" /> : active ? <Loader2 className="size-3 animate-spin" /> : skipped ? <Minus className="size-3" /> : <Circle className="size-3" />}
              {t(PHASE_LABELS[p]!)}
            </li>
          );
        })}
      </ol>
      {d.status === "failed" && (
        <div className="mb-6 space-y-3">
          <Alert kind="error"><strong>{t("Deployment failed:")}</strong> {d.error}{t(". The previous version stays live.")}</Alert>
          {diag.data?.diagnoses.map((x, i) => (
            <Card key={x.id} title={<span className="flex items-center gap-2"><Wrench className="size-4 text-brand" /> {x.problem} <Badge>{x.confidence} {t("confidence")}</Badge></span>} actions={x.autoFix && <Button size="sm" variant="primary" onClick={() => { setFix({ d: x, index: i }); setFixValue(""); }}>{t("Auto Fix")}</Button>}>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-xs text-muted">{t("Cause")}</dt><dd>{x.cause}</dd></div>
                <div><dt className="text-xs text-muted">{t("Suggested fix")}</dt><dd>{x.suggestedFix}</dd></div>
                <div><dt className="text-xs text-muted">{t("Evidence")}</dt><dd><code className="block whitespace-pre-wrap rounded bg-panel-2 p-2 font-mono text-xs">{x.evidence}</code></dd></div>
              </dl>
            </Card>
          ))}
        </div>
      )}
      <LogViewer lines={lines} live={["queued", "building", "deploying"].includes(d.status)} onDownload={() => download(`/deployments/${d.id}/logs/download`)} height={520} />
      <Card title={t("Comments")} className="mt-6">
        <ul className="mb-3 space-y-3 text-sm">
          {comments.data?.comments.map((c) => <li key={c.id}><strong>{c.author}</strong> <span className="text-xs text-faint">{timeAgo(c.createdAt)}</span><p className="text-muted">{c.body}</p></li>)}
        </ul>
        <form onSubmit={(e) => { e.preventDefault(); void post(`/deployments/${d.id}/comments`, { body: comment }).then(() => { setComment(""); void comments.refetch(); }); }} className="flex gap-2">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("Add a note about this release")} />
          <Button disabled={!comment.trim()}>{t("Comment")}</Button>
        </form>
      </Card>
      <Modal
        open={!!fix}
        onClose={() => setFix(null)}
        title={t("Review the Auto Fix")}
        wide
        footer={
          <>
            <Button onClick={() => setFix(null)}>{t("Cancel")}</Button>
            {fix?.d.autoFix?.kind === "file_edit" ? <Button variant="primary" loading={applyFix.isPending} onClick={() => applyFix.mutate("pull_request")}>{t("Open a pull request")}</Button> : <Button variant="primary" loading={applyFix.isPending} onClick={() => applyFix.mutate("apply")}>{t("Apply change")}</Button>}
          </>
        }
      >
        {fix?.d.autoFix && (
          <div className="space-y-3 text-sm">
            <p><strong>{t("Change:")}</strong> {fix.d.autoFix.description}</p>
            <p><strong>{t("Why:")}</strong> {fix.d.autoFix.reason}</p>
            {fix.d.autoFix.kind === "config_change" && <p><strong>{t("Setting:")}</strong> <code className="font-mono">{fix.d.autoFix.field}</code> → <code className="font-mono">{String(fix.d.autoFix.value)}</code></p>}
            {fix.d.autoFix.kind === "variable" && <Field label={t("Value for {{name}}", { name: fix.d.autoFix.field })}><Input value={fixValue} onChange={(e) => setFixValue(e.target.value)} type="password" /></Field>}
            {fix.d.autoFix.kind === "file_edit" && (
              <>
                <p><strong>{t("File:")}</strong> <code className="font-mono">{fix.d.autoFix.file}</code></p>
                <div className="grid gap-2 md:grid-cols-2">
                  <Textarea readOnly rows={12} className="font-mono text-xs" value={fix.d.autoFix.find} aria-label={t("Before")} />
                  <Textarea readOnly rows={12} className="font-mono text-xs" value={fix.d.autoFix.replace} aria-label={t("After")} />
                </div>
                <p className="text-xs text-muted">{t("SKYHOST never changes your code silently: the fix is proposed on a new branch as a pull request.")}</p>
              </>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
