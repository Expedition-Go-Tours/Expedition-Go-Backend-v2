/**
 * Proof of payment PDF — the document behind
 * `GET /admin/bookings/:id/proof-of-payment`.
 *
 * One A4 portrait page an admin can hand to a customer, a supplier or a bank:
 * brand header, the amount actually received, what it was for, who paid, the
 * account the money settled into, the money breakdown and the processor
 * identifiers that make it verifiable.
 *
 * Deliberately customer-safe: commission, supplier payout and margin are
 * finance-internal numbers and never appear here, so the file can be
 * forwarded without a leak. Those live in the invoice and the payout receipt.
 *
 * The renderer is pure — it takes the booking, the settlement facts already
 * resolved by `paymentSettlement.js` and an optional logo buffer. Nothing here
 * touches the database, Stripe or the network, which keeps it unit-testable.
 */

const PDFDocument = require('pdfkit');
const { getBrandEmail } = require('../../../config/brands');

// ── Layout (A4 portrait, points) ──
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const CW = PAGE_W - M * 2;

// ── Palette (mirrors the admin dashboard: emerald accent, gray scale) ──
const INK = '#111827';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const LINE = '#E5E7EB';
const SOFT_BG = '#F9FAFB';
const GREEN = '#047857';
const GREEN_SOFT = '#ECFDF5';
const GREEN_BORDER = '#A7F3D0';
const AMBER = '#B45309';
const RED = '#B91C1C';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Small pure helpers (exported for tests) ──

function capitalize(text) {
  const s = String(text == null ? '' : text);
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}

function formatMoney(amount, currency = 'USD') {
  const n = Number(amount || 0);
  const fixed = Math.abs(n).toFixed(2);
  const [whole, cents] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency || 'USD'} ${n < 0 ? '-' : ''}${grouped}.${cents}`;
}

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(value)} · ${hh}:${mm} UTC`;
}

function cardLabel(booking, settlement) {
  const brand = (settlement && settlement.charge && settlement.charge.brand) || booking.paymentMethodBrand;
  const last4 = (settlement && settlement.charge && settlement.charge.last4) || booking.paymentMethodLast4;
  if (!last4) return null;
  const name = String(brand || 'card');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} •••• ${last4}`;
}

function travelerSummary(travelers) {
  const t = travelers && typeof travelers === 'object' ? travelers : {};
  const parts = [];
  if (t.adults) parts.push(`${t.adults} ${t.adults === 1 ? 'adult' : 'adults'}`);
  if (t.children) parts.push(`${t.children} ${t.children === 1 ? 'child' : 'children'}`);
  if (t.infants) parts.push(`${t.infants} ${t.infants === 1 ? 'infant' : 'infants'}`);
  if (t.seniors) parts.push(`${t.seniors} ${t.seniors === 1 ? 'senior' : 'seniors'}`);
  return parts.join(' · ');
}

/**
 * The party to address: an account holder, or the walk-in guest the supplier
 * recorded. Never both — a guest booking has no customer row.
 */
function contactOf(booking) {
  const c = booking.customer;
  if (c) {
    return {
      name: c.name || booking.leadTravelerName || null,
      email: c.email || null,
      phone: c.phone || null,
    };
  }

  const g = booking.guest;
  if (g) {
    return {
      name: g.name || booking.leadTravelerName || null,
      email: g.email || booking.leadTravelerEmail || null,
      phone: g.phone || null,
    };
  }

  return {
    name: booking.leadTravelerName || null,
    email: booking.leadTravelerEmail || null,
    phone: booking.leadTravelerPhone || null,
  };
}

/**
 * Money a supplier reported collecting offline (cash, MoMo, bank transfer).
 * Reversed rows are corrections, not money in hand, so they are excluded.
 */
function collectedTotals(booking) {
  const list = Array.isArray(booking.collections) ? booking.collections : [];
  const currency = booking.currency || 'USD';
  const relevant = list.filter(
    (c) => (c.currency || currency) === currency && String(c.status || 'RECORDED').toUpperCase() !== 'REVERSED',
  );
  const total = relevant.reduce((sum, c) => sum + Number(c.amount || 0), 0);
  return { count: relevant.length, total, first: relevant[0] || null };
}

function statusOf(booking) {
  const status = String(booking.paymentStatus || 'PENDING').toUpperCase();
  const refunded = Number(booking.refundAmount || 0) > 0 || status === 'REFUNDED';
  if (refunded) {
    return { key: 'refunded', label: 'REFUNDED', color: '#1D4ED8', soft: '#EFF6FF', border: '#BFDBFE', hero: 'PAYMENT REFUNDED' };
  }
  if (status === 'SUCCEEDED' || status === 'PAID' || status === 'COMPLETED') {
    return { key: 'paid', label: 'PAID', color: GREEN, soft: GREEN_SOFT, border: GREEN_BORDER, hero: 'PAYMENT RECEIVED IN FULL' };
  }
  if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
    return { key: 'failed', label: 'FAILED', color: RED, soft: '#FEF2F2', border: '#FECACA', hero: 'PAYMENT NOT COMPLETED' };
  }

  // No processor money, but the supplier recorded collections: the customer has
  // paid even though `paymentStatus` (which tracks the platform processor)
  // still reads PENDING. Saying "awaiting payment" here would be a lie on a
  // receipt the customer is holding.
  const collected = collectedTotals(booking);
  if (collected.total > 0) {
    const gross = Number(booking.grossAmount || 0);
    const settledInFull = gross > 0 && collected.total + 0.005 >= gross;
    return settledInFull
      ? { key: 'collected', label: 'RECEIVED', color: GREEN, soft: GREEN_SOFT, border: GREEN_BORDER, hero: 'PAYMENT RECEIVED IN FULL' }
      : { key: 'partial', label: 'PART PAYMENT', color: AMBER, soft: '#FFFBEB', border: '#FDE68A', hero: 'PART PAYMENT RECEIVED' };
  }

  return { key: 'pending', label: 'PENDING', color: AMBER, soft: '#FFFBEB', border: '#FDE68A', hero: 'AWAITING PAYMENT' };
}

// ── Drawing helpers ──

function rule(doc, y, color = LINE, width = 0.7) {
  doc.save().strokeColor(color).lineWidth(width).moveTo(M, y).lineTo(PAGE_W - M, y).stroke().restore();
}

function label(doc, text, x, y, opts = {}) {
  doc
    .font('Helvetica-Bold')
    .fontSize(opts.size || 7.3)
    .fillColor(opts.color || MUTED)
    .text(String(text || '').toUpperCase(), x, y, {
      width: opts.width || CW,
      characterSpacing: 0.9,
      lineBreak: false,
    });
}

function value(doc, text, x, y, opts = {}) {
  doc
    .font(opts.bold === false ? 'Helvetica' : 'Helvetica-Bold')
    .fontSize(opts.size || 9.6)
    .fillColor(opts.color || INK)
    .text(String(text == null || text === '' ? '—' : text), x, y, {
      width: opts.width || CW,
      height: opts.height,
      ellipsis: Boolean(opts.height),
      lineGap: 0.6,
      align: opts.align || 'left',
    });
}

function sub(doc, text, x, y, opts = {}) {
  if (!text) return;
  doc
    .font('Helvetica')
    .fontSize(opts.size || 8.4)
    .fillColor(opts.color || MUTED)
    .text(String(text), x, y, {
      width: opts.width || CW,
      height: opts.height,
      ellipsis: Boolean(opts.height),
      lineGap: 0.6,
    });
}

function box(doc, x, y, w, h, fill = SOFT_BG, stroke = LINE, radius = 8) {
  doc.save().roundedRect(x, y, w, h, radius).fillAndStroke(fill, stroke).lineWidth(0.7).restore();
}

function pill(doc, text, xRight, y, meta) {
  doc.font('Helvetica-Bold').fontSize(7.6);
  const w = doc.widthOfString(String(text).toUpperCase(), { characterSpacing: 0.8 }) + 20;
  const x = xRight - w;
  box(doc, x, y, w, 19, meta.soft, meta.border, 9.5);
  doc
    .font('Helvetica-Bold')
    .fontSize(7.6)
    .fillColor(meta.color)
    .text(String(text).toUpperCase(), x, y + 6, { width: w, align: 'center', characterSpacing: 0.8, lineBreak: false });
  return { x, w };
}

function checkmark(doc, cx, cy, radius, statusKey = 'paid', color = GREEN) {
  doc.save().circle(cx, cy, radius).fill(color).restore();
  doc.save().lineWidth(2.4).lineCap('round').lineJoin('round').strokeColor('#FFFFFF');

  if (statusKey === 'paid' || statusKey === 'collected') {
    doc
      .moveTo(cx - radius * 0.42, cy + radius * 0.04)
      .lineTo(cx - radius * 0.1, cy + radius * 0.36)
      .lineTo(cx + radius * 0.44, cy - radius * 0.32);
  } else if (statusKey === 'pending' || statusKey === 'partial') {
    // clock: outer ring + hands
    doc.circle(cx, cy, radius * 0.44).moveTo(cx, cy).lineTo(cx, cy - radius * 0.28).moveTo(cx, cy).lineTo(cx + radius * 0.2, cy + radius * 0.08);
  } else if (statusKey === 'refunded') {
    // return arrow
    doc
      .moveTo(cx + radius * 0.34, cy - radius * 0.05)
      .lineTo(cx - radius * 0.3, cy - radius * 0.05)
      .moveTo(cx - radius * 0.08, cy - radius * 0.28)
      .lineTo(cx - radius * 0.32, cy - radius * 0.05)
      .lineTo(cx - radius * 0.08, cy + radius * 0.18);
  } else {
    // exclamation
    doc.moveTo(cx, cy - radius * 0.36).lineTo(cx, cy + radius * 0.1).moveTo(cx, cy + radius * 0.32).lineTo(cx, cy + radius * 0.34);
  }

  doc.stroke().restore();
}

// ── Sections ──

function drawHeader(doc, { brandName, logo }) {
  doc.rect(0, 0, PAGE_W, 6).fill(GREEN);

  let headerBottom = 92;
  if (logo) {
    try {
      doc.image(logo, M, 42, { fit: [150, 42] });
    } catch {
      // A corrupt bitmap must not kill the document.
      doc.font('Helvetica-Bold').fontSize(17).fillColor(INK).text(brandName.toUpperCase(), M, 50);
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(17).fillColor(INK).text(brandName.toUpperCase(), M, 50, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Travel bookings', M, 72, { lineBreak: false });
    headerBottom = 96;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(7.6)
    .fillColor(MUTED)
    .text('PROOF OF PAYMENT', PAGE_W - M - 220, 46, { width: 220, align: 'right', characterSpacing: 1.4, lineBreak: false });
  doc
    .font('Helvetica-Bold')
    .fontSize(23)
    .fillColor(INK)
    .text('RECEIPT', PAGE_W - M - 220, 58, { width: 220, align: 'right', characterSpacing: 0.2, lineBreak: false });

  rule(doc, Math.max(headerBottom, 104), INK, 1.1);
  return Math.max(headerBottom, 104);
}

function drawHero(doc, { booking, settlement, status, card }) {
  const top = 128;
  checkmark(doc, M + 22, top + 20, 20, status.key, status.color);

  const x = M + 56;
  const heroLabel = status.hero;
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(status.color)
    .text(heroLabel, x, top + 2, { characterSpacing: 1.1, lineBreak: false, width: 320 });

  const amount = booking.grossAmount != null ? booking.grossAmount : 0;
  doc
    .font('Helvetica-Bold')
    .fontSize(30)
    .fillColor(INK)
    .text(formatMoney(amount, booking.currency), x, top + 13, { lineBreak: false, width: 340 });

  const bits = [];
  if (status.key === 'paid' && booking.paidAt) bits.push(formatDateTime(booking.paidAt));
  if (status.key === 'pending') {
    bits.push(booking.paymentTiming === 'later' ? 'Card on file — charged before the activity date' : 'Charged at booking');
  }
  if (status.key === 'collected' || status.key === 'partial') {
    const collected = collectedTotals(booking);
    const supplier = booking.tour && booking.tour.supplier && booking.tour.supplier.name;
    bits.push(
      [
        supplier ? `Collected by ${supplier}` : 'Collected by the supplier',
        collected.count > 1 ? `${collected.count} recordings` : null,
        collected.first && collected.first.collectedAt ? `recorded ${formatDate(collected.first.collectedAt)}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }
  if (status.key === 'refunded' && booking.refundedAt) bits.push(`Refunded ${formatDateTime(booking.refundedAt)}`);
  if (card) bits.push(card);
  if (settlement && settlement.livemode === false) bits.push('test mode');

  sub(doc, bits.join(' · '), x, top + 50, { size: 8.6, width: 340 });

  pill(doc, `${status.label}${settlement && settlement.charge ? ' · STRIPE' : booking.paymentProvider && booking.paymentProvider !== 'STRIPE' ? ` · ${booking.paymentProvider}` : ''}`, PAGE_W - M, top + 4, status);
  return top + 74;
}

function drawFacts(doc, { booking, contact, travelers, top }) {
  const colW = (CW - 28) / 2;
  const col2 = M + colW + 28;
  const rowH = 66;

  const rows = [
    [
      {
        label: 'Booking',
        value: booking.bookingNumber,
        sub: [
          booking.status ? capitalize(String(booking.status).replace(/_/g, ' ').toLowerCase()) : null,
          booking.travelDate ? `travel ${formatDate(booking.travelDate)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      },
      {
        label: 'Tour',
        value: booking.tour && booking.tour.title ? booking.tour.title : '—',
        valueHeight: 26,
        sub: [travelers, booking.selectedTime].filter(Boolean).join(' · '),
      },
    ],
    [
      {
        label: 'Booked by',
        value: contact.name,
        sub: contact.email,
      },
      {
        label: 'Lead traveller',
        value: booking.leadTravelerName || contact.name,
        valueHeight: 13,
        sub: [booking.leadTravelerEmail || (booking.leadTravelerName ? null : contact.email), booking.leadTravelerPhone]
          .filter(Boolean)
          .join(' · '),
      },
    ],
  ];

  rows.forEach((row, rowIndex) => {
    const y = top + rowIndex * rowH;
    row.forEach((cell, colIndex) => {
      const x = colIndex === 0 ? M : col2;
      const width = colW;
      label(doc, cell.label, x, y, { width });
      value(doc, cell.value, x, y + 12, { width, height: cell.valueHeight || 14 });
      sub(doc, cell.sub, x, y + (cell.valueHeight || 14) + 15, { width, height: 22 });
    });
  });

  return top + rows.length * rowH;
}

function collectionMethods(collections) {
  const list = Array.isArray(collections) ? collections : [];
  const methods = Array.from(
    new Set(list.map((c) => String(c.method || 'OTHER').replace(/_/g, ' ').toLowerCase())),
  );
  return methods.map((m) => `${m.charAt(0).toUpperCase()}${m.slice(1)}`).join(' + ');
}

/** What the customer paid with, in the wording the receipt should use. */
function paymentMethodLabel(booking, settlement) {
  const card = cardLabel(booking, settlement);
  if (card) return card;
  if (booking.paymentProvider === 'PAYPAL' || booking.paypalCaptureId || booking.paypalOrderId) return 'PayPal';
  const methods = collectionMethods(booking.collections);
  if (methods) return methods;
  return null;
}

function drawSettlement(doc, { booking, settlement, card, top }) {
  const h = 74;
  const x = M + 14;
  const innerW = CW - 28;

  const collections = Array.isArray(booking.collections) ? booking.collections : [];
  let kicker;
  let name;
  let meta;
  let badge;
  let detail = null;
  let tone = 'neutral';

  if (settlement && settlement.account) {
    tone = 'green';
    kicker = 'Settled to';
    name = settlement.account.name || 'Stripe';
    meta = [
      settlement.account.id ? `Stripe account ${settlement.account.id}` : null,
      settlement.account.country,
      settlement.account.defaultCurrency ? `default currency ${settlement.account.defaultCurrency}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    badge = settlement.account.connected ? 'Connected account' : 'Platform account';
    if (settlement.charge && settlement.charge.id) detail = `Charge ${settlement.charge.id}`;
  } else if (booking.paymentProvider === 'PAYPAL' || booking.paypalCaptureId || booking.paypalOrderId) {
    kicker = 'Paid via';
    name = 'PayPal';
    meta = [booking.paypalOrderId ? `Order ${booking.paypalOrderId}` : null, booking.paypalCaptureId ? `Capture ${booking.paypalCaptureId}` : null]
      .filter(Boolean)
      .join(' · ');
    badge = 'PayPal';
  } else if (collections.length) {
    kicker = 'Collected';
    name = collectionMethods(collections);
    const total = collections.reduce((sum, c) => sum + Number(c.amount || 0), 0);
    const first = collections[0];
    meta = [
      formatMoney(total, first.currency || booking.currency),
      first.collectedAt ? `recorded ${formatDate(first.collectedAt)}` : null,
      first.externalRef ? `ref ${first.externalRef}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    badge = 'Recorded by supplier';
  } else if (settlement && settlement.error) {
    tone = 'amber';
    kicker = 'Settled through';
    name = 'Stripe';
    meta = 'Account details were unavailable when this document was generated.';
    badge = 'Stripe';
  } else {
    kicker = 'Settlement';
    name = 'No payment recorded';
    meta = 'This booking has not been paid yet.';
    badge = 'Unpaid';
  }

  const tones = {
    green: { fill: GREEN_SOFT, border: GREEN_BORDER, accent: GREEN, meta: '#065F46' },
    amber: { fill: '#FFFBEB', border: '#FDE68A', accent: AMBER, meta: '#92400E' },
    neutral: { fill: SOFT_BG, border: LINE, accent: MUTED, meta: MUTED },
  };
  const toneSet = tones[tone];

  box(doc, M, top, CW, h, toneSet.fill, toneSet.border, 9);

  label(doc, kicker, x, top + 13, { color: toneSet.accent, width: innerW - 210 });
  value(doc, name, x, top + 24, { size: 12.4, width: innerW - 210, height: 16 });
  sub(doc, meta, x, top + 43, { width: innerW - 200, height: 24, color: toneSet.meta });

  // Right column: what kind of account, and the processor reference.
  doc.font('Helvetica-Bold').fontSize(7.4);
  const badgeW = doc.widthOfString(String(badge).toUpperCase(), { characterSpacing: 0.8 }) + 18;
  const badgeX = PAGE_W - M - 14 - badgeW;
  box(doc, badgeX, top + 13, badgeW, 17, '#FFFFFF', toneSet.border, 8.5);
  doc
    .font('Helvetica-Bold')
    .fontSize(7.4)
    .fillColor(toneSet.accent)
    .text(String(badge).toUpperCase(), badgeX, top + 18, { width: badgeW, align: 'center', characterSpacing: 0.8, lineBreak: false });

  if (detail) {
    doc
      .font('Helvetica')
      .fontSize(7.4)
      .fillColor(MUTED)
      .text(detail, PAGE_W - M - 14 - 200, top + 40, { width: 200, align: 'right', lineBreak: false });
  } else if (card) {
    doc
      .font('Helvetica')
      .fontSize(7.4)
      .fillColor(MUTED)
      .text(card, PAGE_W - M - 14 - 200, top + 40, { width: 200, align: 'right', lineBreak: false });
  }

  return top + h;
}

function drawBreakdown(doc, { booking, status, top }) {
  const h = 58;
  box(doc, M, top, CW, h, '#FFFFFF', LINE, 9);

  const cells = [
    { label: 'Subtotal', value: formatMoney(booking.subtotal, booking.currency) },
    { label: 'Taxes', value: formatMoney(booking.taxes, booking.currency) },
    { label: 'Fees', value: formatMoney(booking.fees, booking.currency) },
    { label: 'Discounts', value: Number(booking.discounts || 0) ? `-${formatMoney(booking.discounts, booking.currency)}` : formatMoney(0, booking.currency) },
  ];

  const innerW = CW - 28;
  const cellW = (innerW - 150) / 4;
  cells.forEach((cell, i) => {
    const x = M + 14 + i * cellW;
    label(doc, cell.label, x, top + 14, { width: cellW - 8 });
    value(doc, cell.value, x, top + 26, { size: 9.2, bold: false, width: cellW - 8, color: INK });
  });

  // The total means "money in" only for a settled booking; on an unpaid one it
  // is still a bill, and the document must not claim otherwise.
  const paid = status.key === 'paid' || status.key === 'collected';
  const totalLabel = paid ? 'Total paid' : status.key === 'refunded' ? 'Total' : 'Total due';
  const totalX = M + 14 + (innerW - 150) + 6;
  label(doc, totalLabel, totalX, top + 14, { color: paid ? GREEN : INK, width: 144 });
  value(doc, formatMoney(booking.grossAmount, booking.currency), totalX, top + 25, {
    size: 13,
    width: 144,
    color: paid ? GREEN : INK,
  });

  return top + h;
}

function drawTimeline(doc, { booking, top }) {
  const cols = [
    { label: 'Booked', value: formatDate(booking.createdAt) || '—' },
    { label: 'Paid', value: booking.paidAt ? formatDate(booking.paidAt) : '—' },
    { label: 'Activity date', value: formatDate(booking.travelDate) || '—' },
  ];
  const colW = (CW - 24) / 3;
  cols.forEach((col, i) => {
    const x = M + i * (colW + 12);
    label(doc, col.label, x, top);
    value(doc, col.value, x, top + 12, { size: 9.2, bold: false, width: colW });
  });
  return top + 40;
}

function drawIdentifiers(doc, { booking, settlement, top }) {
  const rows = [];
  if (booking.stripePaymentIntentId) rows.push({ label: 'PaymentIntent', value: booking.stripePaymentIntentId });
  if (settlement && settlement.charge && settlement.charge.balanceTransactionId) {
    rows.push({ label: 'Balance transaction', value: settlement.charge.balanceTransactionId });
  }
  if (booking.paypalOrderId) rows.push({ label: 'PayPal order', value: booking.paypalOrderId });
  if (booking.paypalCaptureId) rows.push({ label: 'PayPal capture', value: booking.paypalCaptureId });
  rows.push({ label: 'Payment method', value: paymentMethodLabel(booking, settlement) || '—' });

  const shown = rows.slice(0, 3);
  const colW = (CW - 24) / 3;
  shown.forEach((row, i) => {
    const x = M + i * (colW + 12);
    label(doc, row.label, x, top, { width: colW });
    doc
      .font('Helvetica')
      .fontSize(7.8)
      .fillColor(INK)
      .text(String(row.value), x, top + 12, { width: colW, height: 12, ellipsis: true, lineBreak: false });
  });
  return top + 28;
}

/**
 * Who delivered the experience and where it starts — the two facts a customer
 * quotes back at support. Skipped entirely when the booking carries neither.
 */
function drawServiceProvider(doc, { booking, top }) {
  const tour = booking.tour || {};
  const supplier = tour.supplier || {};
  const travelers = booking.travelers && typeof booking.travelers === 'object' ? booking.travelers : {};
  const pickup =
    travelers.location ||
    (booking.pickup && booking.pickup.address && booking.pickup.address.address) ||
    (booking.pickup && booking.pickup.areaName) ||
    null;

  if (!supplier.name && !pickup) return top;

  const colW = (CW - 28) / 2;
  const place = [tour.city, tour.country].filter(Boolean).join(', ');

  if (supplier.name) {
    label(doc, 'Operated by', M, top);
    value(doc, supplier.name, M, top + 12, { size: 9.2, bold: false, width: colW, height: 12 });
    sub(doc, place || null, M, top + 26, { width: colW });
  }
  if (pickup) {
    label(doc, 'Pickup', M + colW + 28, top);
    value(doc, pickup, M + colW + 28, top + 12, { size: 9.2, bold: false, width: colW, height: 24 });
  }

  return top + 42;
}

function drawFooter(doc, { booking, brandName, settlement, issuedAt }) {
  const y = PAGE_H - 84;
  rule(doc, y, LINE, 0.7);
  doc
    .font('Helvetica')
    .fontSize(7.6)
    .fillColor(MUTED)
    .text('This confirms payment received for the booking above. It is not a tax invoice.', M, y + 10, { width: CW - 170 });
  doc
    .font('Helvetica')
    .fontSize(7.6)
    .fillColor(FAINT)
    .text(`Issued ${formatDate(issuedAt)} by ${brandName} · ${booking.bookingNumber}`, M, y + 22, { width: CW - 170 });

  const receiptUrl = settlement && settlement.charge && settlement.charge.receiptUrl;
  if (receiptUrl) {
    const text = 'Open the Stripe receipt';
    doc.font('Helvetica-Bold').fontSize(7.6);
    const w = doc.widthOfString(text);
    doc.fillColor(GREEN).text(text, PAGE_W - M - w, y + 10, { lineBreak: false });
    doc.link(PAGE_W - M - w, y + 8, w, 12, receiptUrl);
    doc
      .font('Helvetica')
      .fontSize(7.6)
      .fillColor(FAINT)
      .text('Hosted by Stripe', PAGE_W - M - 90, y + 22, { width: 90, align: 'right', lineBreak: false });
  }
}

/**
 * Render a proof-of-payment PDF.
 *
 * @param {object} params
 * @param {object} params.booking          Booking row (decimal fields may be strings)
 * @param {object|null} [params.settlement] output of getStripeSettlement(), or null
 * @param {Buffer|null} [params.logo]      brand logo (PNG); falls back to a wordmark
 * @param {string} [params.brandKey]       brand registry key
 * @param {Date} [params.issuedAt]         issue date (defaults to now; injectable for tests)
 * @param {boolean} [params.compress]      pdfkit compression (disabled in tests)
 * @returns {Promise<Buffer>}
 */
function renderProofOfPaymentPdf({
  booking,
  settlement = null,
  logo = null,
  brandKey = 'ghana',
  issuedAt = new Date(),
  compress = true,
} = {}) {
  if (!booking || !booking.bookingNumber) {
    return Promise.reject(new Error('A booking with a bookingNumber is required'));
  }

  const brand = getBrandEmail(brandKey);
  const brandName = brand.brandName || 'Travio';
  const status = statusOf(booking);
  const contact = contactOf(booking);
  const travelers = travelerSummary(booking.travelers);
  const card = cardLabel(booking, settlement);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: M,
        bufferPages: false,
        compress,
        info: {
          Title: `Proof of payment ${booking.bookingNumber}`,
          Author: brandName,
          Subject: `Payment receipt for booking ${booking.bookingNumber}`,
          Creator: brandName,
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const bottomOfHeader = drawHeader(doc, { brandName, logo });
      let y = bottomOfHeader + 24;

      y = drawHero(doc, { booking, settlement, status, card }) + 18;
      y = drawFacts(doc, { booking, contact, travelers, top: y }) + 6;
      y = drawSettlement(doc, { booking, settlement, card, top: y }) + 16;
      y = drawBreakdown(doc, { booking, status, top: y }) + 20;
      y = drawTimeline(doc, { booking, top: y }) + 4;
      y = drawIdentifiers(doc, { booking, settlement, top: y }) + 18;
      drawServiceProvider(doc, { booking, top: y });
      drawFooter(doc, { booking, brandName, settlement, issuedAt });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  renderProofOfPaymentPdf,
  collectedTotals,
  // exported for tests and for callers that need the same formatting
  formatMoney,
  formatDate,
  formatDateTime,
  travelerSummary,
  contactOf,
  statusOf,
};
