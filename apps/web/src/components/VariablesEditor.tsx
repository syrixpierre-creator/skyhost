import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Lock, Trash2 } from "lucide-react";
import { findDuplicates, isValidEnvKey, parseEnvJson, toEnvJson, type EnvPair } from "@skyhost/shared";
import { download, get, post, put } from "../lib/api";
import { Alert, Badge, Button, cx, Input, Modal, Select, Textarea, useToast } from "./ui";

interface Row {
  key: string;
  value: string;
  secret: boolean;
  sealed: boolean;
  /** Existing secret whose value is not revealed: kept as is unless edited. */
  masked: boolean;
  managed?: boolean;
}

interface VarView {
  key: string;
  value: string | null;
  isSecret: boolean;
  isSealed: boolean;
  managedBy: string | null;
}

/**
 * Two synchronized editing modes: a key/value table and the raw JSON object. Both edit the same rows, so switching
 * never loses data; JSON validation reports invalid keys and duplicates live.
 */
export function VariablesEditor({ environmentId, serviceId, onRedeploy }: { environmentId: string; serviceId: string | null; onRedeploy?: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const key = ["variables", environmentId, serviceId, reveal];
  const q = useQuery({ queryKey: key, queryFn: () => get<{ variables: VarView[]; canRevealSecrets: boolean }>(`/environments/${environmentId}/variables?${serviceId ? `serviceId=${serviceId}&` : ""}reveal=${reveal}`) });
  const suggested = useQuery({ queryKey: ["suggested", serviceId, environmentId], queryFn: () => get<{ suggestions: Array<{ key: string; defaultValue?: string; required: boolean; source: string }> }>(`/services/${serviceId}/variables/suggested?environmentId=${environmentId}`), enabled: !!serviceId });
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<"table" | "json">("table");
  const [json, setJson] = useState("{}");
  const [dirty, setDirty] = useState(false);
  const [needsRedeploy, setNeedsRedeploy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFormat, setImportFormat] = useState<"env" | "json">("env");

  useEffect(() => {
    if (!q.data || dirty) return;
    setRows(q.data.variables.map((v) => ({ key: v.key, value: v.value ?? "", secret: v.isSecret, sealed: v.isSealed, masked: v.value === null, managed: !!v.managedBy })));
  }, [q.data, dirty]);

  const jsonIssues = useMemo(() => (mode === "json" ? parseEnvJson(json).issues : []), [json, mode]);
  const tableIssues = useMemo(() => {
    const issues: string[] = [];
    for (const r of rows) if (r.key && !isValidEnvKey(r.key)) issues.push(`Invalid key "${r.key}"`);
    for (const d of findDuplicates(rows.map((r) => r.key).filter(Boolean))) issues.push(`Duplicate key "${d}"`);
    return issues;
  }, [rows]);

  const switchMode = (m: "table" | "json") => {
    if (m === mode) return;
    if (m === "json") {
      // Masked values are exported as empty strings and keep their stored value on save.
      setJson(toEnvJson(rows.filter((r) => r.key).map((r) => ({ key: r.key, value: r.masked ? "" : r.value }))));
    } else {
      const parsed = parseEnvJson(json);
      if (parsed.issues.length) {
        toast("error", parsed.issues[0]!.message);
        return;
      }
      setRows(mergeFromJson(rows, parsed.pairs));
    }
    setMode(m);
  };

  const save = useMutation({
    mutationFn: async () => {
      let current = rows;
      if (mode === "json") {
        const parsed = parseEnvJson(json);
        if (parsed.issues.length) throw new Error(parsed.issues[0]!.message);
        current = mergeFromJson(rows, parsed.pairs);
      }
      if (current.some((r) => r.key && !isValidEnvKey(r.key))) throw new Error("Fix the invalid keys first");
      const variables = current.filter((r) => r.key && !r.managed).map((r) => ({ key: r.key, value: r.masked ? "" : r.value, secret: r.secret, sealed: r.sealed }));
      // Masked secrets are sent with an empty value only when sealed; other masked secrets need their value: fetch it revealed.
      if (current.some((r) => r.masked && !r.sealed) && !reveal) {
        const revealed = await get<{ variables: VarView[] }>(`/environments/${environmentId}/variables?${serviceId ? `serviceId=${serviceId}&` : ""}reveal=true`);
        for (const v of variables) {
          const row = current.find((r) => r.key === v.key);
          if (row?.masked && !row.sealed) v.value = revealed.variables.find((x) => x.key === v.key)?.value ?? "";
        }
      }
      return put<{ changed: string[]; removed: string[]; redeployRequired: boolean }>(`/environments/${environmentId}/variables`, { serviceId, replace: true, variables });
    },
    onSuccess: (r) => {
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ["variables", environmentId, serviceId] });
      toast("success", r.changed.length || r.removed.length ? `Saved (${r.changed.length} changed, ${r.removed.length} removed)` : "No changes");
      if (r.redeployRequired) setNeedsRedeploy(true);
    },
    onError: (e) => toast("error", (e as Error).message),
  });

  const doImport = useMutation({
    mutationFn: () => post<{ changed: string[]; warnings: Array<{ message: string }> }>(`/environments/${environmentId}/variables/import`, { serviceId, format: importFormat, content: importText }),
    onSuccess: (r) => {
      setImportOpen(false);
      setImportText("");
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ["variables", environmentId, serviceId] });
      toast("success", `Imported ${r.changed.length} variables`);
      if (r.changed.length) setNeedsRedeploy(true);
    },
    onError: (e) => toast("error", (e as Error).message),
  });

  const edit = (i: number, patch: Partial<Row>) => {
    setDirty(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch, ...(patch.value !== undefined ? { masked: false } : {}) } : r)));
  };

  return (
    <div className="space-y-3">
      {needsRedeploy && (
        <Alert kind="info">
          <div className="flex items-center justify-between gap-3">
            <span>Variables changed. They apply to new deployments.</span>
            {onRedeploy && <Button size="sm" variant="primary" onClick={() => { onRedeploy(); setNeedsRedeploy(false); }}>{t("vars.redeploy")}</Button>}
          </div>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-line p-0.5" role="tablist">
          {(["table", "json"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => switchMode(m)} className={cx("rounded px-3 py-1 text-xs", mode === m ? "bg-panel-2 font-medium" : "text-muted")}>
              {m === "table" ? t("vars.table") : t("vars.json")}
            </button>
          ))}
        </div>
        {q.data?.canRevealSecrets && (
          <Button size="sm" variant="ghost" onClick={() => setReveal(!reveal)} disabled={dirty}>
            {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} {reveal ? "Hide secrets" : "Reveal secrets"}
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setImportOpen(true)}>{t("vars.import")}</Button>
          <Button size="sm" onClick={() => download(`/environments/${environmentId}/variables/export?format=env${serviceId ? `&serviceId=${serviceId}` : ""}`)}>{t("vars.export")} .env</Button>
          <Button size="sm" onClick={() => download(`/environments/${environmentId}/variables/export?format=json${serviceId ? `&serviceId=${serviceId}` : ""}`)}>JSON</Button>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={!dirty && mode === "table"}>{t("common.save")}</Button>
        </div>
      </div>

      {mode === "table" ? (
        <div className="rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-panel text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="w-40 px-3 py-2 font-medium">Options</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="px-3 py-1.5">
                    <Input className={cx("h-8 font-mono", r.key && !isValidEnvKey(r.key) && "border-red-500")} value={r.key} disabled={r.managed} onChange={(e) => edit(i, { key: e.target.value.toUpperCase().replace(/\s/g, "_") })} placeholder="KEY" />
                  </td>
                  <td className="px-3 py-1.5">
                    {r.sealed && r.masked ? (
                      <span className="flex items-center gap-1 text-xs text-muted"><Lock className="size-3" /> Sealed — type to replace</span>
                    ) : null}
                    <Input className="h-8 font-mono" type={r.secret && !reveal && r.masked ? "password" : "text"} value={r.masked ? "" : r.value} placeholder={r.masked ? "••••••••  (unchanged)" : ""} disabled={r.managed} onChange={(e) => edit(i, { value: e.target.value })} />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-3 text-xs">
                      <label className="flex items-center gap-1"><input type="checkbox" checked={r.secret} disabled={r.sealed} onChange={(e) => edit(i, { secret: e.target.checked })} /> {t("vars.secret")}</label>
                      <label className="flex items-center gap-1" title="Sealed values can never be read again"><input type="checkbox" checked={r.sealed} disabled={r.sealed && r.masked} onChange={(e) => edit(i, { sealed: e.target.checked, secret: e.target.checked || r.secret })} /> {t("vars.sealed")}</label>
                      {r.managed && <Badge>managed</Badge>}
                    </div>
                  </td>
                  <td className="px-2">
                    {!r.managed && (
                      <button onClick={() => { setDirty(true); setRows(rows.filter((_, j) => j !== i)); }} className="text-muted hover:text-red-500" aria-label="Delete variable">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted">No variables yet.</td></tr>}
            </tbody>
          </table>
          <div className="border-t border-line p-2">
            <Button size="sm" variant="ghost" onClick={() => { setDirty(true); setRows([...rows, { key: "", value: "", secret: false, sealed: false, masked: false }]); }}>+ Add variable</Button>
            <span className="ml-2 text-xs text-muted">{"Reference other services with ${{service.KEY}}, e.g. ${{db.DATABASE_URL}}"}</span>
          </div>
        </div>
      ) : (
        <div>
          <Textarea rows={16} className="font-mono text-xs" value={json} onChange={(e) => { setDirty(true); setJson(e.target.value); }} spellCheck={false} aria-label="Variables JSON" />
          {jsonIssues.length ? jsonIssues.map((i, k) => <p key={k} className="text-xs text-red-500">{i.message}</p>) : <p className="text-xs text-green-500">Valid JSON · {parseEnvJson(json).pairs.length} variables</p>}
        </div>
      )}
      {tableIssues.length > 0 && mode === "table" && tableIssues.map((m) => <p key={m} className="text-xs text-red-500">{m}</p>)}

      {!!suggested.data?.suggestions.length && (
        <div className="rounded-lg border border-dashed border-line p-3">
          <div className="mb-2 text-sm font-medium">Detected in your code</div>
          <div className="flex flex-wrap gap-2">
            {suggested.data.suggestions.map((s) => (
              <button key={s.key} onClick={() => { setDirty(true); setRows((rs) => (rs.some((r) => r.key === s.key) ? rs : [...rs, { key: s.key, value: s.defaultValue ?? "", secret: /SECRET|TOKEN|KEY|PASSWORD/.test(s.key), sealed: false, masked: false }])); }} className="rounded border border-line px-2 py-1 font-mono text-xs hover:bg-panel-2" title={`From ${s.source}`}>
                + {s.key}{s.required && <span className="text-amber-500"> *</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import variables" footer={<Button variant="primary" loading={doImport.isPending} onClick={() => doImport.mutate()}>{t("vars.import")}</Button>}>
        <div className="space-y-3">
          <Select value={importFormat} onChange={(e) => setImportFormat(e.target.value as "env" | "json")} className="w-40">
            <option value="env">.env</option>
            <option value="json">JSON</option>
          </Select>
          <Textarea rows={10} className="font-mono text-xs" placeholder={importFormat === "env" ? "KEY=value\nOTHER=\"quoted value\"" : '{"KEY": "value"}'} value={importText} onChange={(e) => setImportText(e.target.value)} />
          <input type="file" accept=".env,.json,text/plain,application/json" onChange={(e) => e.target.files?.[0]?.text().then(setImportText)} className="text-sm" />
        </div>
      </Modal>
    </div>
  );
}

function mergeFromJson(prev: Row[], pairs: EnvPair[]): Row[] {
  return pairs.map((p) => {
    const old = prev.find((r) => r.key === p.key);
    if (old?.masked && p.value === "") return old;
    return { key: p.key, value: p.value, secret: old?.secret ?? false, sealed: old?.sealed ?? false, masked: false, managed: old?.managed };
  });
}
