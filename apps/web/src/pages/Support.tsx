import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LifeBuoy } from "lucide-react";
import { get, post } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Card, cx, EmptyState, ErrorState, Field, Input, LoadingRows, Modal, PageHeader, Select, StatusBadge, Textarea, timeAgo, useToast } from "../components/ui";

export interface Ticket {
  id: string;
  subject: string;
  category: string;
  status: "open" | "answered" | "closed";
  lastMessageAt: string;
  createdAt: string;
  userName?: string;
  userEmail?: string;
}

interface Thread {
  ticket: Ticket;
  owner: { name: string; email: string } | null;
  staff: boolean;
  messages: Array<{ id: string; body: string; fromStaff: boolean; author: string | null; createdAt: string }>;
}

const CATEGORIES = [
  ["technical", "Technical issue"],
  ["billing", "Billing"],
  ["account", "Account"],
  ["abuse", "Abuse"],
  ["other", "Other"],
] as const;

export const TICKET_STATUS = { open: "Waiting for support", answered: "Answered", closed: "Closed" } as const;

export function TicketRows({ tickets, admin }: { tickets: Ticket[]; admin?: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y divide-line">
      {tickets.map((tk) => (
        <li key={tk.id}>
          <Link to={`/support/${tk.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-panel-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{tk.subject}</div>
              <div className="text-xs text-muted">
                {admin && `${tk.userName} <${tk.userEmail}> · `}
                {t(CATEGORIES.find(([k]) => k === tk.category)?.[1] ?? tk.category)} · {timeAgo(tk.lastMessageAt)}
              </div>
            </div>
            <StatusBadge status={tk.status === "open" ? "pending" : tk.status === "answered" ? "active" : "closed"} label={t(TICKET_STATUS[tk.status])} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SupportList() {
  const { t } = useTranslation();
  const { team } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["support"], queryFn: () => get<{ tickets: Ticket[] }>("/support/tickets") });
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("technical");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () => post<{ ticket: Ticket }>("/support/tickets", { subject, category, body, teamId: team?.id }),
    onSuccess: (r) => { toast("success", t("Ticket sent. We reply by email.")); nav(`/support/${r.ticket.id}`); },
    onError: (e) => toast("error", (e as Error).message),
  });
  const newButton = <Button variant="primary" onClick={() => setOpen(true)}>{t("New ticket")}</Button>;
  return (
    <>
      <PageHeader title={t("Support")} subtitle={t("Ask the SKYHOST team for help. Replies also arrive by email.")} actions={newButton} />
      <p className="mb-4 text-sm text-muted">
        {t("Many answers are already in the")} <Link to="/docs" className="text-accent hover:underline">{t("documentation")}</Link>.
      </p>
      {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data!.tickets.length === 0 ? (
        <EmptyState icon={<LifeBuoy className="size-6" />} title={t("No tickets yet")} description={t("Open a ticket when something does not work as expected.")} action={newButton} />
      ) : (
        <Card padded={false}><TicketRows tickets={q.data!.tickets} /></Card>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("New ticket")}
        footer={<><Button onClick={() => setOpen(false)}>{t("Cancel")}</Button><Button variant="primary" loading={create.isPending} disabled={subject.trim().length < 3 || !body.trim()} onClick={() => create.mutate()}>{t("Send")}</Button></>}
      >
        <div className="space-y-3">
          <Field label={t("Subject")}><Input value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label={t("Category")}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
            </Select>
          </Field>
          <Field label={t("Message")} hint={t("Include the project or service name and what you expected to happen.")}>
            <Textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

function TicketThread({ id }: { id: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useQuery({ queryKey: ["support", id], queryFn: () => get<Thread>(`/support/tickets/${id}`) });
  const [body, setBody] = useState("");
  const reply = useMutation({
    mutationFn: () => post(`/support/tickets/${id}/messages`, { body }),
    onSuccess: () => { setBody(""); void q.refetch(); },
    onError: (e) => toast("error", (e as Error).message),
  });
  const close = useMutation({
    mutationFn: () => post(`/support/tickets/${id}/close`),
    onSuccess: () => { void q.refetch(); toast("success", t("Ticket closed")); },
  });
  if (q.isLoading) return <LoadingRows rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { ticket, messages, owner, staff } = q.data!;
  return (
    <>
      <PageHeader
        breadcrumbs={<Link to={staff && owner ? "/admin/support" : "/support"} className="hover:text-fg">{t("Support")}</Link>}
        title={ticket.subject}
        subtitle={owner ? `${owner.name} <${owner.email}>` : undefined}
        actions={<>
          <StatusBadge status={ticket.status === "open" ? "pending" : ticket.status === "answered" ? "active" : "closed"} label={t(TICKET_STATUS[ticket.status])} />
          {ticket.status !== "closed" && <Button size="sm" loading={close.isPending} onClick={() => close.mutate()}>{t("Close ticket")}</Button>}
        </>}
      />
      <div className="space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={cx("rounded-lg border p-4", m.fromStaff ? "border-accent/40 bg-accent/5" : "border-line bg-panel")}>
            <div className="mb-2 flex items-center justify-between text-xs text-muted">
              <span className="font-medium text-fg">{m.author ?? t("Deleted user")}</span>
              <span>{timeAgo(m.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
          </div>
        ))}
      </div>
      <Card className="mt-6" title={ticket.status === "closed" ? t("Reopen with a reply") : t("Reply")}>
        <Textarea rows={5} aria-label={t("Reply")} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="mt-3 flex justify-end">
          <Button variant="primary" loading={reply.isPending} disabled={!body.trim()} onClick={() => reply.mutate()}>{t("Send reply")}</Button>
        </div>
      </Card>
    </>
  );
}

export default function Support() {
  const { ticketId } = useParams();
  return ticketId ? <TicketThread key={ticketId} id={ticketId} /> : <SupportList />;
}
