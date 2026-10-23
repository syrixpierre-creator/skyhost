import PDFDocument from "pdfkit";

export interface InvoiceForPdf {
  number: string;
  createdAt: Date;
  paidAt: Date | null;
  status: string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  lines: Array<{ description: string; amountCents: number; quantity?: number }>;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

const money = (c: number, cur: string) => `${(c / 100).toFixed(2)} ${cur.toUpperCase()}`;

export function renderInvoicePdf(inv: InvoiceForPdf, team: { name: string; billingEmail?: string | null; taxId?: string | null; billingCountry?: string | null }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Invoice ${inv.number}`, Author: "SYRIX VISION COMPANY" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("SKYHOST", { continued: true }).fontSize(10).fillColor("#666").text("  by SYRIX VISION COMPANY");
    doc.moveDown().fillColor("#000").fontSize(16).text(`Invoice ${inv.number}`);
    doc.fontSize(10).fillColor("#444");
    doc.text(`Date: ${inv.createdAt.toISOString().slice(0, 10)}`);
    doc.text(`Status: ${inv.status.toUpperCase()}${inv.paidAt ? ` (paid ${inv.paidAt.toISOString().slice(0, 10)})` : ""}`);
    if (inv.periodStart && inv.periodEnd) doc.text(`Period: ${inv.periodStart.toISOString().slice(0, 10)} – ${inv.periodEnd.toISOString().slice(0, 10)}`);
    doc.moveDown().fillColor("#000").fontSize(11).text("Billed to");
    doc.fontSize(10).fillColor("#444").text(team.name);
    if (team.billingEmail) doc.text(team.billingEmail);
    if (team.billingCountry) doc.text(team.billingCountry);
    if (team.taxId) doc.text(`Tax ID: ${team.taxId}`);
    doc.moveDown(1.5);

    const top = doc.y;
    doc.fillColor("#000").fontSize(10).text("Description", 50, top).text("Amount", 450, top, { width: 95, align: "right" });
    doc.moveTo(50, top + 15).lineTo(545, top + 15).strokeColor("#ddd").stroke();
    let y = top + 25;
    for (const l of inv.lines) {
      doc.fillColor("#222").text(`${l.description}${l.quantity && l.quantity > 1 ? ` × ${l.quantity}` : ""}`, 50, y, { width: 380 });
      doc.text(money(l.amountCents, inv.currency), 450, y, { width: 95, align: "right" });
      y += 20;
    }
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#ddd").stroke();
    y += 10;
    const row = (label: string, v: string, bold = false) => {
      doc.fontSize(bold ? 11 : 10).fillColor(bold ? "#000" : "#444").text(label, 300, y, { width: 140, align: "right" }).text(v, 450, y, { width: 95, align: "right" });
      y += 18;
    };
    row("Subtotal", money(inv.subtotalCents, inv.currency));
    row("Tax", money(inv.taxCents, inv.currency));
    row("Total", money(inv.totalCents, inv.currency), true);
    doc.fontSize(8).fillColor("#888").text("Thank you for using SKYHOST.", 50, 760, { align: "center", width: 495 });
    doc.end();
  });
}
