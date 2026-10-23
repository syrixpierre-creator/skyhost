import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { ARTICLES, SECTIONS, type Article } from "../docs/articles";
import { useSession } from "../lib/session";
import { Logo } from "../components/Logo";
import { cx, Input } from "../components/ui";

/** Inline Markdown: `code`, **bold** and [text](href). Internal links stay in the app. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = out.length;
    if (m[1] !== undefined) out.push(<code key={k} className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.85em]">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k} className="font-semibold">{m[2]}</strong>);
    else if (/^https?:/.test(m[4]!) || m[4]!.startsWith("/api/")) out.push(<a key={k} href={m[4]} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">{m[3]}</a>);
    else out.push(<Link key={k} to={m[4]!} className="text-accent underline-offset-2 hover:underline">{m[3]}</Link>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The Markdown subset used by docs/articles.ts. */
function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    const k = blocks.length;
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      i++;
      blocks.push(<pre key={k} className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-xs leading-5">{code.join("\n")}</pre>);
    } else if (line.startsWith("## ")) {
      blocks.push(<h2 key={k} className="pt-4 text-lg font-semibold tracking-tight">{inline(line.slice(3))}</h2>);
      i++;
    } else if (line.startsWith("### ")) {
      blocks.push(<h3 key={k} className="pt-2 font-semibold">{inline(line.slice(4))}</h3>);
      i++;
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = !line.startsWith("- ");
      const items: string[] = [];
      for (; i < lines.length && /^(- |\d+\. )/.test(lines[i]!); i++) items.push(lines[i]!.replace(/^(- |\d+\. )/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={k} className={cx("space-y-1.5 pl-5", ordered ? "list-decimal" : "list-disc")}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</List>);
    } else if (line.startsWith("> ")) {
      blocks.push(<div key={k} className="rounded-lg border border-line bg-panel px-4 py-3 text-sm">{inline(line.slice(2))}</div>);
      i++;
    } else if (line.trim()) {
      blocks.push(<p key={k}>{inline(line)}</p>);
      i++;
    } else i++;
  }
  return <div className="space-y-3 text-[15px] leading-7">{blocks}</div>;
}

/** Public user documentation: /docs and /docs/:slug. */
export default function Docs() {
  const { t, i18n } = useTranslation();
  const { me } = useSession();
  const { slug } = useParams();
  const lang = i18n.language.startsWith("fr") ? "fr" : "en";
  const [query, setQuery] = useState("");
  const article = slug ? ARTICLES.find((a) => a.slug === slug) : undefined;
  useEffect(() => {
    document.title = `${article ? article.title[lang] : t("Documentation")} · SKYHOST`;
    window.scrollTo(0, 0);
  }, [article, lang, t]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ARTICLES;
    return ARTICLES.filter((a) => `${a.title[lang]} ${a.summary[lang]} ${a.body[lang]}`.toLowerCase().includes(q));
  }, [query, lang]);

  const nav = (Object.keys(SECTIONS) as Article["section"][]).map((s) => (
    <div key={s} className="mb-4">
      <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-faint">{SECTIONS[s][lang]}</div>
      {ARTICLES.filter((a) => a.section === s).map((a) => (
        <Link key={a.slug} to={`/docs/${a.slug}`} className={cx("block rounded-md px-2 py-1 text-sm", a.slug === slug ? "bg-panel-2 font-medium text-fg" : "text-muted hover:text-fg")}>{a.title[lang]}</Link>
      ))}
    </div>
  ));

  return (
    <div className="min-h-full bg-bg text-fg">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/"><Logo size="sm" /></Link>
          <Link to="/docs" className="text-sm font-medium">{t("Documentation")}</Link>
          <div className="ml-auto flex items-center gap-2">
            {me ? (
              <Link to="/" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover">{t("Dashboard")}</Link>
            ) : (
              <>
                <Link to="/login" className="rounded-md px-3 py-1.5 text-sm hover:bg-panel-2">{t("auth.login")}</Link>
                <Link to="/signup" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover">{t("Get started")}</Link>
              </>
            )}
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-10 px-4 py-8">
        <aside className="hidden w-56 shrink-0 md:block"><nav className="sticky top-20">{nav}</nav></aside>
        <main className="min-w-0 flex-1">
          {article ? (
            <article className="max-w-3xl">
              <p className="mb-1 text-sm text-muted"><Link to="/docs" className="hover:text-fg">{t("Documentation")}</Link> / {SECTIONS[article.section][lang]}</p>
              <h1 className="text-3xl font-semibold tracking-tight">{article.title[lang]}</h1>
              <p className="mt-2 mb-6 text-muted">{article.summary[lang]}</p>
              <Markdown source={article.body[lang]} />
              <div className="mt-10 border-t border-line pt-6 text-sm text-muted">
                {t("Did not find your answer?")} <Link to="/support" className="text-accent hover:underline">{t("Contact support")}</Link>
              </div>
            </article>
          ) : slug ? (
            <p className="text-muted">{t("This page does not exist.")} <Link to="/docs" className="text-accent hover:underline">{t("Documentation")}</Link></p>
          ) : (
            <>
              <h1 className="text-3xl font-semibold tracking-tight">{t("Documentation")}</h1>
              <p className="mt-2 text-muted">{t("Everything you need to deploy and run your apps on SKYHOST.")}</p>
              <div className="relative mt-6 max-w-md">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                <Input aria-label={t("Search the documentation")} placeholder={t("Search the documentation")} className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {matches.map((a) => (
                  <Link key={a.slug} to={`/docs/${a.slug}`} className="rounded-lg border border-line bg-panel p-5 transition-colors hover:border-line-strong">
                    <div className="text-xs text-faint">{SECTIONS[a.section][lang]}</div>
                    <h2 className="mt-1 font-medium">{a.title[lang]}</h2>
                    <p className="mt-1 text-sm text-muted">{a.summary[lang]}</p>
                  </Link>
                ))}
                {matches.length === 0 && <p className="text-sm text-muted">{t("No results.")}</p>}
              </div>
              <div className="mt-8 md:hidden">{nav}</div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
