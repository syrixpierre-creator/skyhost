import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { EVENT_TYPES, PERMISSIONS, ROLES } from "@skyhost/shared";
import { del, get, patch, post, put } from "../lib/api";
import { useSession } from "../lib/session";
import { Alert, Badge, Button, Card, CodeField, ConfirmDialog, EmptyState, Field, Input, LoadingRows, Modal, PageHeader, Select, Tabs, Textarea, Toggle, timeAgo, useToast } from "../components/ui";

type Tab = "general" | "members" | "security" | "deploys" | "git" | "notifications" | "groups" | "apikeys" | "audit";

function General() {
  const { team, refresh, setTeamId } = useSession();
  const toast = useToast();
  const [params] = useSearchParams();
  const [name, setName] = useState(team!.name);
  const [slug, setSlug] = useState(team!.slug);
  const [newName, setNewName] = useState("");
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Team">
        <div className="space-y-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="URL slug"><Input value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
          <Button variant="primary" onClick={() => patch(`/teams/${team!.id}`, { name, slug }).then(() => { toast("success", "Saved"); refresh(); }).catch((e) => toast("error", e.message))}>Save</Button>
        </div>
      </Card>
      <Card title="Create a new team">
        <form onSubmit={(e) => { e.preventDefault(); void post<{ team: { id: string } }>("/teams", { name: newName }).then((r) => { setTeamId(r.team.id); refresh(); toast("success", "Team created"); }).catch((er) => toast("error", er.message)); }} className="flex gap-2">
          <Input autoFocus={params.get("new") === "1"} placeholder="Acme Inc." value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button disabled={!newName}>Create</Button>
        </form>
      </Card>
      {team!.role === "owner" && !team!.personal && (
        <Card title="Danger zone" className="border-red-500/30">
          <Button variant="danger" onClick={() => setConfirm(true)}>Delete team</Button>
          <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Delete team" description="Every project must be deleted or transferred first." typeToConfirm={team!.name} onConfirm={() => del(`/teams/${team!.id}`, { confirmName: team!.name }).then(() => { localStorage.removeItem("sh-team"); location.href = "/"; }).catch((e) => toast("error", e.message))} />
        </Card>
      )}
    </div>
  );
}

function Members() {
  const { team, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["members", team!.id], queryFn: () => get<{ members: Array<{ userId: string; name: string; email: string; role: string; joinedAt: string; twoFactor: boolean }>; invites: Array<{ id: string; email: string; role: string; expiresAt: string }> }>(`/teams/${team!.id}/members`) });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("developer");
  const [transfer, setTransfer] = useState<string | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["members"] });
  const err = (e: Error) => toast("error", e.message);
  return (
    <div className="space-y-4">
      <Card title="Invite a member">
        <form onSubmit={(e) => { e.preventDefault(); void post(`/teams/${team!.id}/invites`, { email, role }).then(() => { setEmail(""); toast("success", "Invitation sent"); void reload(); }).catch(err); }} className="flex flex-wrap gap-2">
          <Input type="email" required placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="max-w-sm" />
          <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-36">{ROLES.filter((r) => r !== "owner").map((r) => <option key={r}>{r}</option>)}</Select>
          <Button variant="primary">Invite</Button>
        </form>
      </Card>
      <Card title="Members" padded={false}>
        {q.isLoading ? <div className="p-4"><LoadingRows /></div> : (
          <table className="w-full text-sm">
            <tbody>
              {q.data?.members.map((m) => (
                <tr key={m.userId} className="border-b border-line last:border-0">
                  <td className="px-4 py-2"><div className="font-medium">{m.name} {m.userId === me?.user.id && <Badge>you</Badge>}</div><div className="text-xs text-muted">{m.email}</div></td>
                  <td>{m.twoFactor ? <Badge>2FA</Badge> : <span className="text-xs text-faint">no 2FA</span>}</td>
                  <td className="w-40">
                    {m.role === "owner" ? <Badge>owner</Badge> : (
                      <Select value={m.role} onChange={(e) => patch(`/teams/${team!.id}/members/${m.userId}`, { role: e.target.value }).then(reload).catch(err)} className="h-8">{ROLES.filter((r) => r !== "owner").map((r) => <option key={r}>{r}</option>)}</Select>
                    )}
                  </td>
                  <td className="w-56 px-4 text-right">
                    {m.role !== "owner" && team!.role === "owner" && <Button size="sm" variant="ghost" onClick={() => setTransfer(m.userId)}>Make owner</Button>}
                    {m.role !== "owner" && <Button size="sm" variant="ghost" onClick={() => del(`/teams/${team!.id}/members/${m.userId}`).then(() => (m.userId === me?.user.id ? (location.href = "/") : reload())).catch(err)}>{m.userId === me?.user.id ? "Leave" : "Remove"}</Button>}
                  </td>
                </tr>
              ))}
              {q.data?.invites.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-0 text-muted">
                  <td className="px-4 py-2">{i.email}</td>
                  <td><Badge>pending</Badge></td>
                  <td>{i.role}</td>
                  <td className="px-4 text-right"><Button size="sm" variant="ghost" onClick={() => del(`/teams/${team!.id}/invites/${i.id}`).then(reload)}>Revoke</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <ConfirmDialog open={!!transfer} onClose={() => setTransfer(null)} title="Transfer ownership" description="The new owner gets full control, including billing and deleting the team. You become an admin." confirmText="Transfer" onConfirm={() => post(`/teams/${team!.id}/transfer`, { userId: transfer }).then(() => location.reload()).catch(err)} />
    </div>
  );
}

function Security() {
  const { team } = useSession();
  const toast = useToast();
  const q = useQuery({ queryKey: ["team", team!.id], queryFn: () => get<{ team: { require2fa: boolean; sessionTtlHours: number | null; dashboardIpAllowlist: string[]; roleOverrides: Record<string, { grant: string[]; revoke: string[] }> } }>(`/teams/${team!.id}`) });
  const [require2fa, setRequire2fa] = useState(false);
  const [ttl, setTtl] = useState("");
  const [ips, setIps] = useState("");
  const [overrides, setOverrides] = useState<Record<string, { grant: string[]; revoke: string[] }>>({});
  const [role, setRole] = useState("viewer");
  useEffect(() => {
    if (!q.data) return;
    setRequire2fa(q.data.team.require2fa);
    setTtl(q.data.team.sessionTtlHours ? String(q.data.team.sessionTtlHours) : "");
    setIps(q.data.team.dashboardIpAllowlist.join(", "));
    setOverrides(q.data.team.roleOverrides ?? {});
  }, [q.data]);
  const o = overrides[role] ?? { grant: [], revoke: [] };
  const toggle = (perm: string, kind: "grant" | "revoke") => {
    const list = new Set(o[kind]);
    if (list.has(perm)) list.delete(perm);
    else list.add(perm);
    setOverrides({ ...overrides, [role]: { ...o, [kind]: [...list] } });
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Team security">
        <div className="space-y-4">
          <Toggle checked={require2fa} onChange={setRequire2fa} label="Require two-factor authentication for every member" />
          <Field label="Maximum session age (hours)" hint="Members must sign in again after this delay"><Input value={ttl} onChange={(e) => setTtl(e.target.value)} placeholder="unlimited" /></Field>
          <Field label="Dashboard IP allowlist" hint="Comma separated IPs or CIDR; empty = any IP"><Input value={ips} onChange={(e) => setIps(e.target.value)} /></Field>
          <Button variant="primary" onClick={() => put(`/teams/${team!.id}/security`, { require2fa, sessionTtlHours: ttl ? Number(ttl) : null, dashboardIpAllowlist: ips.split(",").map((x) => x.trim()).filter(Boolean) }).then(() => toast("success", "Saved")).catch((e) => toast("error", e.message))}>Save</Button>
        </div>
      </Card>
      <Card title="Role permissions" actions={<Select value={role} onChange={(e) => setRole(e.target.value)} className="h-8 w-32">{["admin", "developer", "member", "viewer"].map((r) => <option key={r}>{r}</option>)}</Select>}>
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted"><tr><th className="pb-1">Permission</th><th>Grant</th><th>Revoke</th></tr></thead>
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p} className="border-t border-line"><td className="py-1 font-mono">{p}</td><td><input type="checkbox" checked={o.grant.includes(p)} onChange={() => toggle(p, "grant")} /></td><td><input type="checkbox" checked={o.revoke.includes(p)} onChange={() => toggle(p, "revoke")} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button className="mt-3" onClick={() => put(`/teams/${team!.id}/permissions`, { overrides }).then(() => toast("success", "Permissions saved")).catch((e) => toast("error", e.message))}>Save permissions</Button>
      </Card>
    </div>
  );
}

function Deploys() {
  const { team } = useSession();
  const toast = useToast();
  const q = useQuery({ queryKey: ["team", team!.id], queryFn: () => get<{ team: { deployFreeze: { enabled: boolean; mode?: string; timezone?: string; windows: Array<{ days: number[]; start: string; end: string }> }; retention: Record<string, number> } }>(`/teams/${team!.id}`) });
  const [freeze, setFreeze] = useState({ enabled: false, mode: "deny", timezone: "UTC", windows: [{ days: [5], start: "18:00", end: "23:59" }] });
  const [retention, setRetention] = useState<Record<string, number | undefined>>({});
  useEffect(() => {
    if (!q.data) return;
    const f = q.data.team.deployFreeze;
    setFreeze({ enabled: f.enabled, mode: f.mode ?? "deny", timezone: f.timezone ?? "UTC", windows: f.windows.length ? f.windows : freeze.windows });
    setRetention(q.data.team.retention);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Deploy freeze / maintenance windows">
        <div className="space-y-3">
          <Toggle checked={freeze.enabled} onChange={(v) => setFreeze({ ...freeze, enabled: v })} label="Enabled (rollbacks are always allowed)" />
          <div className="flex gap-2">
            <Select value={freeze.mode} onChange={(e) => setFreeze({ ...freeze, mode: e.target.value })}><option value="deny">Block deploys during windows</option><option value="allow">Only allow deploys during windows</option></Select>
            <Input value={freeze.timezone} onChange={(e) => setFreeze({ ...freeze, timezone: e.target.value })} className="w-44" />
          </div>
          {freeze.windows.map((w, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
              {days.map((d, j) => <label key={d} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={w.days.includes(j)} onChange={(e) => setFreeze({ ...freeze, windows: freeze.windows.map((x, k) => (k === i ? { ...x, days: e.target.checked ? [...x.days, j] : x.days.filter((y) => y !== j) } : x)) })} />{d}</label>)}
              <Input type="time" value={w.start} onChange={(e) => setFreeze({ ...freeze, windows: freeze.windows.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)) })} className="h-8 w-28" />
              <Input type="time" value={w.end} onChange={(e) => setFreeze({ ...freeze, windows: freeze.windows.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)) })} className="h-8 w-28" />
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setFreeze({ ...freeze, windows: [...freeze.windows, { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] })}>+ Window</Button>
          <Button variant="primary" onClick={() => put(`/teams/${team!.id}/deploy-freeze`, freeze).then(() => toast("success", "Saved")).catch((e) => toast("error", e.message))}>Save</Button>
        </div>
      </Card>
      <Card title="Retention & cleanup">
        <div className="space-y-3">
          {[["logsDays", "Keep logs (days)"], ["screenshotsDays", "Keep screenshots (days)"], ["backupsDays", "Keep backups (days)"], ["previewsDays", "Delete previews after (days)"]].map(([k, l]) => (
            <Field key={k} label={l}><Input value={retention[k!] ?? ""} placeholder="plan default" onChange={(e) => setRetention({ ...retention, [k!]: e.target.value ? Number(e.target.value) : undefined })} /></Field>
          ))}
          <Button variant="primary" onClick={() => put(`/teams/${team!.id}/retention`, retention).then(() => toast("success", "Saved")).catch((e) => toast("error", e.message))}>Save</Button>
        </div>
      </Card>
    </div>
  );
}

function Git() {
  const { team } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["installations", team!.id], queryFn: () => get<{ installations: Array<{ id: string; provider: string; accountLogin: string; suspended: boolean; createdAt: string }> }>(`/teams/${team!.id}/git/installations`) });
  const providers = useQuery({ queryKey: ["git-providers"], queryFn: () => get<{ github: boolean; gitlab: boolean; bitbucket: boolean }>("/git/providers") });
  return (
    <Card title="Git connections" actions={<div className="flex gap-2">{providers.data?.github && <a href={`/api/v1/git/github/install?teamId=${team!.id}`}><Button size="sm">+ GitHub</Button></a>}{providers.data?.gitlab && <a href={`/api/v1/git/gitlab/connect?teamId=${team!.id}`}><Button size="sm">+ GitLab</Button></a>}{providers.data?.bitbucket && <a href={`/api/v1/git/bitbucket/connect?teamId=${team!.id}`}><Button size="sm">+ Bitbucket</Button></a>}</div>}>
      {q.data?.installations.length ? (
        <ul className="divide-y divide-line text-sm">{q.data.installations.map((i) => <li key={i.id} className="flex items-center justify-between py-2"><span><Badge>{i.provider}</Badge> {i.accountLogin} {i.suspended && <Badge>suspended</Badge>}</span><Button size="sm" variant="ghost" onClick={() => del(`/git/installations/${i.id}`).then(() => qc.invalidateQueries({ queryKey: ["installations"] }))}>Disconnect</Button></li>)}</ul>
      ) : <EmptyState title="No Git provider connected" />}
    </Card>
  );
}

function Notifications() {
  const { team } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useQuery({ queryKey: ["channels", team!.id], queryFn: () => get<{ channels: Array<{ id: string; kind: string; name: string; target: string; events: string[]; enabled: boolean }> }>(`/teams/${team!.id}/notification-channels`) });
  const hooks = useQuery({ queryKey: ["webhooks", team!.id], queryFn: () => get<{ webhooks: Array<{ id: string; url: string; events: string[]; enabled: boolean }> }>(`/teams/${team!.id}/webhooks`) });
  const alerts = useQuery({ queryKey: ["alerts", team!.id], queryFn: () => get<{ rules: Array<{ id: string; metric: string; threshold: number | null; durationMinutes: number }> }>(`/teams/${team!.id}/alerts`) });
  const [kind, setKind] = useState("slack");
  const [target, setTarget] = useState("");
  const [events, setEvents] = useState<string[]>(["deployment.failed", "service.crashed"]);
  const [hookUrl, setHookUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [metric, setMetric] = useState("cpu");
  const [threshold, setThreshold] = useState(85);
  const reload = () => qc.invalidateQueries();
  return (
    <div className="space-y-4">
      <Card title="Channels (Slack, Discord, email, webhook)">
        <ul className="mb-4 divide-y divide-line text-sm">
          {channels.data?.channels.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2">
              <span><Badge>{c.kind}</Badge> {c.name} <span className="text-xs text-muted">{c.target}</span></span>
              <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => post(`/notification-channels/${c.id}/test`).then(() => toast("success", "Test sent"))}>Test</Button><Button size="sm" variant="ghost" onClick={() => del(`/notification-channels/${c.id}`).then(reload)}>Remove</Button></span>
            </li>
          ))}
        </ul>
        <div className="grid gap-2 sm:grid-cols-[140px_1fr_auto]">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}><option>slack</option><option>discord</option><option>email</option><option>webhook</option></Select>
          <Input placeholder={kind === "email" ? "alerts@example.com" : "https://hooks…"} value={target} onChange={(e) => setTarget(e.target.value)} />
          <Button onClick={() => post(`/teams/${team!.id}/notification-channels`, { kind, name: kind, ...(kind === "email" ? { email: target } : { url: target }), events }).then(() => { setTarget(""); void reload(); }).catch((e) => toast("error", e.message))}>Add</Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {EVENT_TYPES.map((ev) => <label key={ev} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />{ev}</label>)}
        </div>
      </Card>
      <Card title="Outgoing webhooks (HMAC signed)">
        {secret && <div className="mb-3"><Alert kind="success">Signing secret (shown once): <CodeField value={secret} secret /></Alert></div>}
        <ul className="mb-3 divide-y divide-line text-sm">{hooks.data?.webhooks.map((h) => <li key={h.id} className="flex items-center justify-between py-2"><span className="truncate">{h.url}</span><Button size="sm" variant="ghost" onClick={() => del(`/webhooks/${h.id}`).then(reload)}>Remove</Button></li>)}</ul>
        <div className="flex gap-2"><Input placeholder="https://example.com/skyhost-hook" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} /><Button onClick={() => post<{ secret: string }>(`/teams/${team!.id}/webhooks`, { url: hookUrl, events }).then((r) => { setSecret(r.secret); setHookUrl(""); void reload(); }).catch((e) => toast("error", e.message))}>Add webhook</Button></div>
        <p className="mt-2 text-xs text-muted">{"Verify X-Skyhost-Signature: t=<unix>,v1=hex(HMAC_SHA256(secret, \"<t>.<body>\"))"}</p>
      </Card>
      <Card title="Alerts">
        <ul className="mb-3 divide-y divide-line text-sm">{alerts.data?.rules.map((r) => <li key={r.id} className="flex items-center justify-between py-2"><span>{r.metric} {r.threshold != null && `≥ ${r.threshold}%`} for {r.durationMinutes} min</span><Button size="sm" variant="ghost" onClick={() => del(`/alerts/${r.id}`).then(reload)}>Remove</Button></li>)}</ul>
        <div className="flex gap-2"><Select value={metric} onChange={(e) => setMetric(e.target.value)} className="w-40"><option>cpu</option><option>memory</option></Select><Input value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="w-24" /><Button onClick={() => post(`/teams/${team!.id}/alerts`, { metric, threshold }).then(reload).catch((e) => toast("error", e.message))}>Add alert</Button></div>
      </Card>
    </div>
  );
}

function Groups() {
  const { team } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["groups", team!.id], queryFn: () => get<{ groups: Array<{ id: string; name: string; parentId: string | null; items: Array<{ key: string; value: string | null; isSecret: boolean }>; links: Array<{ id: string; projectId: string | null; serviceId: string | null; environmentType: string | null }> }> }>(`/teams/${team!.id}/variable-groups`) });
  const projects = useQuery({ queryKey: ["projects", team!.id], queryFn: () => get<{ projects: Array<{ id: string; name: string }> }>(`/teams/${team!.id}/projects`) });
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["groups"] });
  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void post(`/teams/${team!.id}/variable-groups`, { name }).then(() => { setName(""); void reload(); }); }} className="flex gap-2"><Input placeholder="shared-stripe" value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" /><Button>Create group</Button></form>
      {q.data?.groups.map((g) => (
        <Card key={g.id} title={g.name} actions={<><Button size="sm" onClick={() => setEdit({ id: g.id, text: g.items.map((i) => `${i.key}=${i.value ?? ""}`).join("\n") })}>Edit</Button><Button size="sm" variant="ghost" onClick={() => del(`/variable-groups/${g.id}`).then(reload).catch((e) => toast("error", e.message))}>Delete</Button></>}>
          <div className="flex flex-wrap gap-1">{g.items.map((i) => <Badge key={i.key}>{i.key}{i.isSecret && " 🔒"}</Badge>)}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Linked to:</span>
            {g.links.map((l) => <Badge key={l.id}>{projects.data?.projects.find((p) => p.id === l.projectId)?.name ?? l.serviceId?.slice(0, 8)}{l.environmentType ? ` (${l.environmentType})` : ""}</Badge>)}
            <Select className="h-8 w-48" onChange={(e) => e.target.value && post(`/variable-groups/${g.id}/links`, { projectId: e.target.value }).then(reload)}><option value="">+ Link a project</option>{projects.data?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          </div>
        </Card>
      ))}
      {!q.data?.groups.length && <EmptyState title="No shared variable groups" description="Define variables once and link them to several projects or services. Service variables override group values." />}
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Edit group (KEY=value per line)" footer={<Button variant="primary" onClick={() => put(`/variable-groups/${edit!.id}/items`, { items: edit!.text.split("\n").filter((l) => l.includes("=")).map((l) => ({ key: l.slice(0, l.indexOf("=")).trim(), value: l.slice(l.indexOf("=") + 1), secret: /SECRET|KEY|TOKEN|PASSWORD/.test(l.slice(0, l.indexOf("="))) })) }).then(() => { setEdit(null); void reload(); }).catch((e) => toast("error", e.message))}>Save</Button>}>
        <Textarea rows={12} className="font-mono text-xs" value={edit?.text ?? ""} onChange={(e) => setEdit({ ...edit!, text: e.target.value })} />
      </Modal>
    </div>
  );
}

export function ApiKeys() {
  const { team } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["apikeys", team!.id], queryFn: () => get<{ apiKeys: Array<{ id: string; name: string; prefix: string; scopes: string[]; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; projectId: string | null }> }>(`/api-keys?teamId=${team!.id}`) });
  const [name, setName] = useState("CI deploy");
  const [scope, setScope] = useState("deploy");
  const [days, setDays] = useState("90");
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => post<{ secret: string }>("/api-keys", { name, teamId: team!.id, scopes: [scope], expiresInDays: days ? Number(days) : undefined }), onSuccess: (r) => { setSecret(r.secret); void qc.invalidateQueries({ queryKey: ["apikeys"] }); }, onError: (e) => toast("error", (e as Error).message) });
  return (
    <Card title="API keys">
      {secret && <div className="mb-4"><Alert kind="success">Copy this key now, it will not be shown again: <CodeField value={secret} /></Alert></div>}
      <div className="mb-4 flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
        <Select value={scope} onChange={(e) => setScope(e.target.value)} className="w-36"><option value="read">read-only</option><option value="deploy">deploy-only</option><option value="write">write</option><option value="admin">admin</option></Select>
        <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-36"><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="">never</option></Select>
        <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Create key</Button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted"><tr><th className="pb-2">Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {q.data?.apiKeys.map((k) => (
            <tr key={k.id} className="border-t border-line">
              <td className="py-2">{k.name}</td>
              <td className="font-mono text-xs">{k.prefix}</td>
              <td>{k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</td>
              <td className="text-muted">{timeAgo(k.lastUsedAt)}</td>
              <td className="text-muted">{k.revokedAt ? "revoked" : k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "never"}</td>
              <td className="text-right">{!k.revokedAt && <><Button size="sm" variant="ghost" onClick={() => post<{ secret: string }>(`/api-keys/${k.id}/rotate`).then((r) => { setSecret(r.secret); void qc.invalidateQueries({ queryKey: ["apikeys"] }); })}>Rotate</Button><Button size="sm" variant="ghost" onClick={() => post(`/api-keys/${k.id}/revoke`).then(() => qc.invalidateQueries({ queryKey: ["apikeys"] }))}>Revoke</Button></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Audit() {
  const { team } = useSession();
  const [action, setAction] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["audit", team!.id, action, cursor], queryFn: () => get<{ logs: Array<{ id: number; action: string; targetType: string | null; targetId: string | null; metadata: Record<string, unknown>; ip: string | null; createdAt: string; actor: { name: string; email: string } | null; impersonatorId: string | null }>; nextCursor: number | null }>(`/teams/${team!.id}/audit-logs?limit=50${action ? `&action=${encodeURIComponent(action)}` : ""}${cursor ? `&before=${cursor}` : ""}`) });
  return (
    <Card title="Audit log" actions={<Input placeholder="Filter: deployment, member, billing…" value={action} onChange={(e) => { setAction(e.target.value); setCursor(null); }} className="h-8 w-64" />}>
      {q.isLoading ? <LoadingRows /> : (
        <table className="w-full text-sm">
          <tbody>
            {q.data?.logs.map((l) => (
              <tr key={l.id} className="border-b border-line align-top last:border-0">
                <td className="whitespace-nowrap py-2 pr-3 text-xs text-muted">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="pr-3"><code className="font-mono text-xs">{l.action}</code></td>
                <td className="pr-3">{l.actor?.name ?? "system"}{l.impersonatorId && <Badge>support</Badge>}</td>
                <td className="max-w-md truncate text-xs text-muted">{JSON.stringify(l.metadata)}</td>
                <td className="text-xs text-faint">{l.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data?.nextCursor && <Button size="sm" className="mt-3" onClick={() => setCursor(q.data!.nextCursor)}>Older</Button>}
    </Card>
  );
}

export default function TeamSettings() {
  const { team } = useSession();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("general");
  if (!team) return null;
  return (
    <>
      <PageHeader title={t("nav.settings")} subtitle={`${team.name} · your role: ${team.role}`} />
      <Tabs
        tabs={[
          { id: "general", label: "General" },
          { id: "members", label: "Members" },
          { id: "security", label: "Security & roles" },
          { id: "deploys", label: "Deploys & retention" },
          { id: "git", label: "Git" },
          { id: "notifications", label: "Notifications" },
          { id: "groups", label: "Shared variables" },
          { id: "apikeys", label: "API keys" },
          { id: "audit", label: "Audit log" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "general" && <General />}
      {tab === "members" && <Members />}
      {tab === "security" && <Security />}
      {tab === "deploys" && <Deploys />}
      {tab === "git" && <Git />}
      {tab === "notifications" && <Notifications />}
      {tab === "groups" && <Groups />}
      {tab === "apikeys" && <ApiKeys />}
      {tab === "audit" && <Audit />}
    </>
  );
}
