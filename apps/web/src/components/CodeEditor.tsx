import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { ChevronRight, File as FileIcon, Folder, FolderOpen, GitCommit, PanelLeft, RotateCcw, X } from "lucide-react";
import { get, post } from "../lib/api";
import { useTheme } from "../lib/theme";
import { Button, EmptyState, ErrorState, Input, LoadingRows, useToast } from "./ui";
import { cx } from "./ui";

interface TreeEntry { path: string; type: "file" | "dir"; size?: number }
interface TreeResponse { repo: string; branch: string; ref: string; tree: TreeEntry[] }

function langFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext && ["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(ext)) return [javascript({ jsx: ext.includes("x"), typescript: ext.startsWith("ts") })];
  if (ext === "py") return [python()];
  if (ext === "json") return [json()];
  if (ext && ["html", "htm", "vue", "svelte"].includes(ext)) return [html()];
  if (ext && ["css", "scss", "less"].includes(ext)) return [css()];
  return [];
}

/** Builds the nested folder structure the tree view renders, from the flat list the API returns. */
interface Node { name: string; path: string; type: "file" | "dir"; children: Node[] }
function buildTree(entries: TreeEntry[]): Node[] {
  const root: Node = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  const ensureDir = (path: string): Node => {
    if (dirs.has(path)) return dirs.get(path)!;
    const slash = path.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : path.slice(0, slash));
    const node: Node = { name: path.slice(slash + 1), path, type: "dir", children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (e.type === "dir") ensureDir(e.path);
    else {
      const slash = e.path.lastIndexOf("/");
      ensureDir(slash === -1 ? "" : e.path.slice(0, slash)).children.push({ name: e.path.slice(slash + 1), path: e.path, type: "file", children: [] });
    }
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

function TreeView({ nodes, current, dirty, onPick, depth = 0 }: { nodes: Node[]; current: string | null; dirty: Set<string>; onPick: (path: string) => void; depth?: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => (depth === 0 ? { [nodes[0]?.path ?? ""]: true } : {}));
  return (
    <ul className="select-none">
      {nodes.map((n) =>
        n.type === "dir" ? (
          <li key={n.path}>
            <button onClick={() => setOpen((o) => ({ ...o, [n.path]: !o[n.path] }))} className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg" style={{ paddingLeft: depth * 12 + 6 }}>
              <ChevronRight className={cx("size-3.5 shrink-0 transition-transform", open[n.path] && "rotate-90")} />
              {open[n.path] ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
              <span className="truncate">{n.name}</span>
            </button>
            {open[n.path] && <TreeView nodes={n.children} current={current} dirty={dirty} onPick={onPick} depth={depth + 1} />}
          </li>
        ) : (
          <li key={n.path}>
            <button onClick={() => onPick(n.path)} className={cx("flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-panel-2", current === n.path ? "bg-panel-2 font-medium text-fg" : "text-muted hover:text-fg")} style={{ paddingLeft: depth * 12 + 22 }}>
              <FileIcon className="size-4 shrink-0" />
              <span className="truncate">{n.name}</span>
              {dirty.has(n.path) && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500" title="Unsaved changes" />}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** In-dashboard code editor for a Git-connected service: browse, edit and commit straight to the deploy branch. */
export function CodeEditor({ serviceId, canEdit }: { serviceId: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [theme] = useTheme();
  const [params] = useSearchParams();
  const treeQ = useQuery({ queryKey: ["code-tree", serviceId], queryFn: () => get<TreeResponse>(`/services/${serviceId}/code/tree`) });

  const [path, setPath] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // edited content, keyed by path
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState(false);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);

  const dirty = useMemo(() => new Set(Object.keys(drafts).filter((p) => drafts[p] !== original[p])), [drafts, original]);
  const nodes = useMemo(() => (treeQ.data ? buildTree(treeQ.data.tree) : []), [treeQ.data]);

  const openFile = async (p: string) => {
    setTreeOpen(false);
    setPath(p);
    if (drafts[p] !== undefined) return;
    setLoadingFile(true);
    try {
      const r = await get<{ path: string; content: string }>(`/services/${serviceId}/code/file?path=${encodeURIComponent(p)}`);
      setOriginal((o) => ({ ...o, [p]: r.content }));
      setDrafts((d) => ({ ...d, [p]: r.content }));
    } catch (e) {
      toast("error", (e as Error).message);
      setPath(null);
    } finally {
      setLoadingFile(false);
    }
  };

  // Deep link from an error ("Open in editor"): ?file=src/x.js opens that file once the tree is ready.
  const wantFile = params.get("file");
  useEffect(() => {
    if (wantFile && treeQ.data && path === null) void openFile(wantFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantFile, treeQ.data]);

  const commit = async () => {
    const changes = [...dirty].map((p) => ({ path: p, content: drafts[p]! }));
    if (!changes.length || !message.trim()) return;
    setCommitting(true);
    try {
      const r = await post<{ sha: string; files: number }>(`/services/${serviceId}/code/commit`, { message, changes });
      setOriginal((o) => ({ ...o, ...Object.fromEntries(changes.map((c) => [c.path, c.content])) }));
      setMessage("");
      toast("success", t("Committed {{n}} file(s) · {{sha}}. The service is redeploying.", { n: r.files, sha: r.sha.slice(0, 7) }));
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setCommitting(false);
    }
  };

  if (treeQ.isLoading) return <LoadingRows rows={6} />;
  if (treeQ.error) return <ErrorState error={treeQ.error} onRetry={() => treeQ.refetch()} />;

  const tree = (
    <div className="overflow-y-auto p-2">
      <TreeView nodes={nodes} current={path} dirty={dirty} onPick={openFile} />
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-13rem)] min-h-96 overflow-hidden rounded-lg border border-line bg-panel">
      {/* File tree: a column on desktop, a slide-over drawer on phones. */}
      <aside className="hidden w-60 shrink-0 border-r border-line md:block">{tree}</aside>
      {treeOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setTreeOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-panel shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-sm font-medium">{t("Files")}</span>
              <button aria-label={t("Close")} onClick={() => setTreeOpen(false)} className="rounded p-1 hover:bg-panel-2"><X className="size-4" /></button>
            </div>
            {tree}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <button aria-label={t("Files")} onClick={() => setTreeOpen(true)} className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-fg md:hidden"><PanelLeft className="size-4" /></button>
          <span className="truncate font-mono text-xs text-muted">{treeQ.data!.repo}</span>
          <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">{treeQ.data!.branch}</span>
          {path && <span className="ml-1 truncate font-mono text-xs text-fg">{path.split("/").pop()}{dirty.has(path) ? " •" : ""}</span>}
          {path && dirty.has(path) && (
            <button className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => setDrafts((d) => ({ ...d, [path]: original[path]! }))}>
              <RotateCcw className="size-3.5" /> {t("Revert")}
            </button>
          )}
        </div>

        <div className="relative min-h-0 flex-1">
          {loadingFile ? (
            <div className="p-4"><LoadingRows rows={8} /></div>
          ) : path && drafts[path] !== undefined ? (
            <CmEditor key={path} value={drafts[path]!} readOnly={!canEdit} dark={theme === "dark"} language={langFor(path)} gotoLine={params.get("line") ? Number(params.get("line")) : undefined} onChange={(v) => setDrafts((d) => ({ ...d, [path]: v }))} />
          ) : (
            <EmptyState icon={<FileIcon className="size-6" />} title={t("Pick a file to edit")} description={t("Browse the repository on the left and open any file.")} action={<Button className="md:hidden" onClick={() => setTreeOpen(true)}>{t("Browse files")}</Button>} />
          )}
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={dirty.size ? t("Describe your change…") : t("No unsaved changes")} disabled={!dirty.size} className="min-w-0 flex-1" />
            <Button variant="primary" loading={committing} disabled={!dirty.size || !message.trim()} onClick={commit}>
              <GitCommit className="size-4" /> {t("Commit & deploy")}{dirty.size ? ` (${dirty.size})` : ""}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Thin React wrapper around a CodeMirror 6 EditorView. */
function CmEditor({ value, readOnly, dark, language, gotoLine, onChange }: { value: string; readOnly: boolean; dark: boolean; language: Extension[]; gotoLine?: number; onChange: (v: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      ...language,
      ...(dark ? [oneDark] : []),
      EditorView.theme({ "&": { height: "100%", fontSize: "13px" }, ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflow: "auto" }, "&.cm-focused": { outline: "none" } }),
      EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: host.current });
    view.current = v;
    if (gotoLine && gotoLine > 0) {
      try {
        const line = v.state.doc.line(Math.min(gotoLine, v.state.doc.lines));
        v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
      } catch { /* out of range: ignore */ }
    }
    return () => v.destroy();
    // Recreate the view when the file, theme or edit-mode changes (value is managed outside after that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, readOnly]);

  // Keep the document in sync when the value prop changes from outside (e.g. Revert) without retyping.
  useEffect(() => {
    const v = view.current;
    if (v && value !== v.state.doc.toString()) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="absolute inset-0 overflow-hidden" />;
}
