/**
 * Invoice PDF rendering — the supplier-facing document behind
 * GET /finance/invoices/:id/pdf.
 *
 * One A4 page (more only when the booking table overflows), GetYourGuide's
 * invoice anatomy: brand header, "invoiced to" block, invoice meta, money
 * summary, booking line items, payment details with a masked destination,
 * and a page footer. Uses PDF standard fonts (Helvetica) so no font files
 * ship with the service.
 *
 * The document deliberately carries NO customer data and only masked payout
 * details — invoices get forwarded to accountants and sit in email inboxes.
 */

const PDFDocument = require('pdfkit');
const { getBrand } = require('../../../config/brands');
const { describePayoutDestination } = require('./financeHelpers');

// ── Layout ──
const PAGE_H = 841.89; // A4 in points
const MARGIN = 48;
const CONTENT_W = 595.28 - MARGIN * 2; // 499.28
const FOOTER_RESERVE = 36; // never let content run into the footer band

// ── Palette (mirrors the supplier dashboard: emerald accent, gray scale) ──
const INK = '#111827';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const LINE = '#E5E7EB';
const SOFT_BG = '#F9FAFB';

const STATUS_META = {
  INVOICED: { label: 'Due', color: '#B45309' },
  APPROVED: { label: 'Approved', color: '#0369A1' },
  PAID: { label: 'Paid', color: '#047857' },
  CANCELLED: { label: 'Voided', color: '#6B7280' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const numberFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money as the rest of the product writes it: "USD 1,234.56". */
function fmtMoney(amount, currency) {
  const n = parseFloat(amount);
  return `${currency || 'USD'} ${numberFmt.format(Number.isFinite(n) ? n : 0)}`;
}

/** Plain numbers for table cells — the currency sits in the column header. */
function fmtAmount(amount) {
  const n = parseFloat(amount);
  return numberFmt.format(Number.isFinite(n) ? n : 0);
}

/** "Oct 1, 2026" — UTC parts, so a server timezone can never shift a date. */
function fmtDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Line-item columns. `tour` takes the remaining width. Money columns print
// plain numbers — the currency is a single code in the header (an invoice is
// single-currency), which keeps the figures readable in narrow columns.
const COLS = [
  { key: 'booking', label: 'Booking', width: 88, align: 'left' },
  { key: 'travelDate', label: 'Travel date', width: 74, align: 'left' },
  { key: 'tour', label: 'Tour', width: 137, align: 'left' },
  { key: 'gross', label: 'Gross', width: 62, align: 'right', money: true },
  { key: 'commission', label: 'Commission', width: 74, align: 'right', money: true },
  { key: 'net', label: 'Net', width: 64, align: 'right', money: true },
];

/**
 * Render an invoice to a PDF buffer.
 *
 * @param {object} params
 * @param {object} params.invoice    an Invoice row (Decimals are fine)
 * @param {object[]} [params.items]  InvoiceItem rows incl. booking (no customer)
 * @param {object} [params.supplier] User subset: name, email, address, city, country
 * @param {object} [params.payoutMethod] PayoutMethod subset (masked on the doc)
 * @param {string} [params.brandKey='ghana']
 * @returns {Promise<Buffer>}
 */
function renderInvoicePdf({ invoice, items = [], supplier = null, payoutMethod = null, brandKey = 'ghana' }) {
  const brand = getBrand(brandKey);
  const status = STATUS_META[invoice.status] || { label: invoice.status || '—', color: MUTED };
  const currency = invoice.currency || 'USD';

  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `Invoice ${invoice.invoiceNumber}`,
      Author: brand.brandName,
      Subject: `Invoice ${invoice.invoiceNumber} — ${invoice.cycleLabel || ''}`.trim(),
      Producer: `${brand.brandName} Supplier Portal`,
    },
  });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  let y = MARGIN;

  // ── Header: brand block (left) + INVOICE title (right) ──
  doc.fillColor(brand.email?.accentColor || '#065F46').font('Helvetica-Bold').fontSize(17);
  doc.text(brand.brandName, MARGIN, y, { lineBreak: false });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8);
  doc.text(`${brand.supplierDashboardUrl || brand.storefrontDomain} · ${brand.supportEmail}`, MARGIN, y + 21, { lineBreak: false });

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22);
  doc.text('INVOICE', MARGIN, y - 2, { width: CONTENT_W, align: 'right', lineBreak: false });
  doc.fillColor(status.color).fontSize(9);
  doc.text(status.label.toUpperCase(), MARGIN, y + 22, { width: CONTENT_W, align: 'right', lineBreak: false });

  y += 40;
  doc.rect(MARGIN, y, CONTENT_W, 2).fill(brand.email?.accentColor || '#065F46');
  y += 22;

  // ── Invoiced to (left) + invoice meta (right) ──
  const metaW = 232;
  const leftW = CONTENT_W - metaW - 20;

  doc.fillColor(FAINT).font('Helvetica-Bold').fontSize(7.5);
  doc.text('INVOICED TO', MARGIN, y, { lineBreak: false });
  let ly = y + 13;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11);
  doc.text(supplier?.name || 'Supplier', MARGIN, ly, { width: leftW, lineBreak: false, height: 14, ellipsis: true });
  ly += 16;
  const supplierLines = [
    supplier?.email,
    [supplier?.address, supplier?.city, supplier?.country].filter(Boolean).join(' · ') || null,
  ].filter(Boolean);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
  for (const line of supplierLines) {
    doc.text(line, MARGIN, ly, { width: leftW, lineBreak: false, height: 12, ellipsis: true });
    ly += 12;
  }

  const metaX = MARGIN + leftW + 20;
  const period = invoice.cycleStartDate && invoice.cycleEndDate
    ? `${fmtDate(invoice.cycleStartDate)} – ${fmtDate(invoice.cycleEndDate)}`
    : invoice.cycleLabel || '—';
  const metaRows = [
    ['Invoice number', invoice.invoiceNumber, true],
    ['Invoice date', fmtDate(invoice.invoicedAt) || '—', false],
    ['Activity period', period, false],
    ['Bookings', String(invoice.bookingCount ?? items.length), false],
    ['Payment due', fmtDate(invoice.paymentScheduledAt) || '—', false],
    ['Reference', invoice.reference || '—', false],
  ];
  doc.font('Helvetica').fontSize(8.5);
  let my = y;
  for (const [label, value, bold] of metaRows) {
    doc.fillColor(MUTED).text(label, metaX, my, { width: 88, lineBreak: false });
    doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(String(value), metaX + 92, my, { width: metaW - 92, lineBreak: false, height: 11, ellipsis: true });
    doc.font('Helvetica');
    my += 14;
  }
  y = Math.max(ly, my) + 14;

  // ── Money summary strip ──
  const gross = num(invoice.grossTotal);
  const commission = num(invoice.commissionTotal);
  const net = num(invoice.netTotal);
  const rate = gross > 0 ? Math.round((commission / gross) * 1000) / 10 : null;
  const boxGap = 8;
  const boxW = (CONTENT_W - boxGap * 2) / 3;
  const boxes = [
    { label: 'Gross — bookings total', value: fmtMoney(gross, currency) },
    { label: rate != null ? `Platform commission (${rate}%)` : 'Platform commission', value: `− ${fmtMoney(commission, currency)}` },
    { label: 'Net payable to you', value: fmtMoney(net, currency), emphasis: true },
  ];
  boxes.forEach((box, i) => {
    const bx = MARGIN + i * (boxW + boxGap);
    doc.roundedRect(bx, y, boxW, 46, 6).fill(box.emphasis ? (brand.email?.accentSoft || '#E7F5EF') : SOFT_BG);
    doc.fillColor(FAINT).font('Helvetica-Bold').fontSize(7.5);
    doc.text(box.label, bx + 10, y + 9, { width: boxW - 20, lineBreak: false, height: 10, ellipsis: true });
    doc.fillColor(box.emphasis ? (brand.email?.accentDark || '#044B3B') : INK).font('Helvetica-Bold').fontSize(box.emphasis ? 12 : 11);
    doc.text(box.value, bx + 10, y + 23, { width: boxW - 20, lineBreak: false, height: 15, ellipsis: true });
  });
  y += 46 + 24;

  // ── Booking line items ──
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11);
  doc.text('Bookings on this invoice', MARGIN, y, { lineBreak: false });
  y += 18;

  const rowH = 20;
  const drawTableHeader = (top) => {
    doc.rect(MARGIN, top, CONTENT_W, 18).fill(SOFT_BG);
    let x = MARGIN;
    for (const col of COLS) {
      if (col.money) {
        doc.fillColor(FAINT).font('Helvetica-Bold').fontSize(7.5);
        doc.text(col.label.toUpperCase(), x + 6, top + 3, { width: col.width - 12, align: col.align, lineBreak: false });
        doc.fillColor(FAINT).font('Helvetica').fontSize(7);
        doc.text(currency, x + 6, top + 10, { width: col.width - 12, align: col.align, lineBreak: false });
      } else {
        doc.fillColor(FAINT).font('Helvetica-Bold').fontSize(7.5);
        doc.text(col.label.toUpperCase(), x + 6, top + 5, { width: col.width - 12, align: col.align, lineBreak: false });
      }
      x += col.width;
    }
    return top + 18;
  };

  const pageLimit = () => PAGE_H - MARGIN - FOOTER_RESERVE;

  y = drawTableHeader(y);
  if (items.length === 0) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(9);
    doc.text('No booking lines are recorded on this invoice.', MARGIN + 6, y + 6, { lineBreak: false });
    y += rowH;
  }
  for (const item of items) {
    if (y + rowH > pageLimit()) {
      doc.addPage();
      y = drawTableHeader(MARGIN);
    }
    const booking = item.booking || {};
    const cells = {
      booking: booking.bookingNumber || '—',
      travelDate: fmtDate(booking.travelDate) || '—',
      tour: booking.tour?.title || '—',
      gross: fmtAmount(item.grossAmount, item.currency || currency),
      commission: fmtAmount(item.platformCommission, item.currency || currency),
      net: fmtAmount(item.supplierPayout, item.currency || currency),
    };
    let x = MARGIN;
    for (const col of COLS) {
      doc.fillColor(col.key === 'net' ? INK : MUTED)
        .font(col.key === 'net' ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8.5);
      doc.text(String(cells[col.key]), x + 6, y + 6, {
        width: col.width - 12,
        align: col.align,
        height: 11,
        ellipsis: true,
      });
      x += col.width;
    }
    doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).lineWidth(0.5).strokeColor(LINE).stroke();
    y += rowH;
  }

  // Totals row
  if (y + 24 > pageLimit()) {
    doc.addPage();
    y = MARGIN;
  }
  y += 6;
  const totalsX = MARGIN + COLS.slice(0, 3).reduce((s, c) => s + c.width, 0);
  const totalsW = COLS.slice(3).reduce((s, c) => s + c.width, 0);
  doc.moveTo(totalsX, y).lineTo(totalsX + totalsW, y).lineWidth(1).strokeColor(INK).stroke();
  y += 8;
  const totals = { gross: fmtAmount(gross, currency), commission: `-${fmtAmount(commission, currency)}`, net: fmtAmount(net, currency) };
  let tx = totalsX;
  for (const col of COLS.slice(3)) {
    doc.fillColor(col.key === 'net' ? INK : MUTED).font('Helvetica-Bold').fontSize(9);
    doc.text(totals[col.key], tx + 6, y, { width: col.width - 12, align: 'right', lineBreak: false });
    tx += col.width;
  }
  y += 26;

  // ── Payment details ──
  if (y + 74 > pageLimit()) {
    doc.addPage();
    y = MARGIN;
  }
  const boxTop = y;
  const destination = payoutMethod ? describePayoutDestination(payoutMethod) : null;
  const noteByStatus = {
    INVOICED: invoice.paymentScheduledAt
      ? `Payment is scheduled for ${fmtDate(invoice.paymentScheduledAt)}. Your bank may credit it a few days later.`
      : 'Payment is being processed. Your bank may credit it a few days after invoicing.',
    APPROVED: invoice.paymentScheduledAt
      ? `Approved for payment on ${fmtDate(invoice.paymentScheduledAt)}.`
      : 'Approved for payment.',
    PAID: `Paid${invoice.paidAt ? ` on ${fmtDate(invoice.paidAt)}` : ''}${invoice.reference ? ` · Reference ${invoice.reference}` : ''}.`,
    CANCELLED: 'This invoice was voided — no payment is due.',
  };
  const note = noteByStatus[invoice.status] || '';
  const destLine1 = destination
    ? [destination.label, destination.accountName].filter(Boolean).join(' · ')
    : 'No payout method on file';
  const destLine2 = destination?.maskedDetail || '';

  const boxH = 46 + (destLine2 ? 12 : 0) + (note ? 12 : 0);
  doc.roundedRect(MARGIN, boxTop, CONTENT_W, boxH, 6).fill(SOFT_BG);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5);
  doc.text('Payment details', MARGIN + 12, boxTop + 10, { lineBreak: false });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
  doc.text(destLine1, MARGIN + 12, boxTop + 24, { width: CONTENT_W - 24, lineBreak: false, height: 11, ellipsis: true });
  let py = boxTop + 36;
  if (destLine2) {
    doc.fillColor(FAINT).text(destLine2, MARGIN + 12, py, { width: CONTENT_W - 24, lineBreak: false, height: 11, ellipsis: true });
    py += 12;
  }
  if (note) {
    doc.fillColor(MUTED).text(note, MARGIN + 12, py, { width: CONTENT_W - 24, lineBreak: false, height: 11, ellipsis: true });
  }
  y = boxTop + boxH + 14;

  doc.fillColor(FAINT).font('Helvetica').fontSize(7.5);
  doc.text(
    `Generated electronically by ${brand.brandName} — no signature required. Questions? Reply to ${brand.supportEmail}.`,
    MARGIN,
    y,
    { width: CONTENT_W, lineBreak: false, height: 10, ellipsis: true }
  );

  // ── Footers (buffered pages) ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const footY = PAGE_H - MARGIN - 14;
    doc.moveTo(MARGIN, footY - 6).lineTo(MARGIN + CONTENT_W, footY - 6).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.fillColor(FAINT).font('Helvetica').fontSize(7.5);
    doc.text(`${brand.brandName} · Invoice ${invoice.invoiceNumber}`, MARGIN, footY, { lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN, footY, {
      width: CONTENT_W,
      align: 'right',
      lineBreak: false,
    });
  }

  doc.end();
  return finished;
}

module.exports = {
  renderInvoicePdf,
  STATUS_META,
  fmtMoney,
  fmtDate,
};
