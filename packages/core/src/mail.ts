import nodemailer, { type Transporter } from "nodemailer";
import { serverConfig } from "./config";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Messages captured when no SMTP server is configured (development and tests). */
export const outbox: MailMessage[] = [];

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  const url = serverConfig().SMTP_URL;
  if (!url) return null;
  transporter ??= nodemailer.createTransport(url);
  return transporter;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Minimal, accessible HTML layout for transactional emails (black and white, like the dashboard). */
export function renderEmail(
  title: string,
  paragraphs: string[],
  action?: { label: string; url: string },
  extra: { details?: Array<[string, string]>; code?: string } = {},
): { text: string; html: string } {
  const details = extra.details?.filter(([, v]) => v) ?? [];
  const code = extra.code?.trim() ? extra.code.trim().split("\n").slice(-40).join("\n").slice(-4000) : "";
  const text = [
    title,
    "",
    ...paragraphs,
    ...details.flatMap(([k, v]) => ["", `${k}: ${v}`]),
    ...(code ? ["", "Last log lines:", code] : []),
    ...(action ? ["", `${action.label}: ${action.url}`] : []),
    "",
    "SKYHOST by SYRIX VISION COMPANY",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#fafafa;padding:24px;color:#0a0a0a">
<div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:28px">
<div style="font-weight:700;letter-spacing:.06em;font-size:13px;margin-bottom:20px">SKYHOST</div>
<h1 style="font-size:18px;line-height:1.35;margin:0 0 12px">${escape(title)}</h1>
${paragraphs.map((p) => `<p style="line-height:1.55;margin:0 0 12px;color:#3f3f3f">${escape(p)}</p>`).join("")}
${details.map(([k, v]) => `<p style="line-height:1.55;margin:0 0 10px"><strong>${escape(k)}</strong><br><span style="color:#3f3f3f">${escape(v)}</span></p>`).join("")}
${code ? `<p style="margin:16px 0 6px;font-size:12px;color:#5e5e5e">Last log lines</p><pre style="margin:0 0 12px;background:#0a0a0a;color:#ededed;padding:12px;border-radius:6px;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word;font-family:Menlo,Consolas,monospace">${escape(code)}</pre>` : ""}
${action ? `<p style="margin-top:20px"><a href="${escape(action.url)}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">${escape(action.label)}</a></p>` : ""}
<p style="color:#8f8f8f;font-size:12px;margin-top:28px;border-top:1px solid #e8e8e8;padding-top:12px">SKYHOST by SYRIX VISION COMPANY · You can choose which emails you receive in Account → Notifications.</p></div></body></html>`;
  return { text, html };
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const t = getTransport();
  if (!t) {
    outbox.push(msg);
    if (outbox.length > 500) outbox.shift();
    if (!serverConfig().isTest) console.info(`[mail] to=${msg.to} subject="${msg.subject}" (SMTP_URL not set; message kept in memory)`);
    return;
  }
  await t.sendMail({ from: serverConfig().MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
}
