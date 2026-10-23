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

/** Minimal, accessible HTML layout for transactional emails. */
export function renderEmail(title: string, paragraphs: string[], action?: { label: string; url: string }): { text: string; html: string } {
  const text = [title, "", ...paragraphs, ...(action ? ["", `${action.label}: ${action.url}`] : []), "", "SKYHOST by SYRIX VISION COMPANY"].join("\n");
  const html = `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#f4f4f5;padding:24px;color:#18181b">
<div style="max-width:520px;margin:auto;background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:24px">
<div style="font-weight:700;letter-spacing:.04em;margin-bottom:16px">SKYHOST</div>
<h1 style="font-size:18px;margin:0 0 12px">${escape(title)}</h1>
${paragraphs.map((p) => `<p style="line-height:1.5;margin:0 0 12px">${escape(p)}</p>`).join("")}
${action ? `<p><a href="${escape(action.url)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">${escape(action.label)}</a></p>` : ""}
<p style="color:#71717a;font-size:12px;margin-top:24px">SKYHOST by SYRIX VISION COMPANY</p></div></body></html>`;
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
