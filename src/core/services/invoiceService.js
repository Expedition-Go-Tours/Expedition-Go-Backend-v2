/**
 * Finance v3 — automatic supplier invoicing (GetYourGuide model).
 *
 * Invoices are generated from the booking's ACTIVITY date (travelDate), never
 * the purchase date. Each activity date belongs to exactly one invoice window
 * (payoutCycles.invoiceWindowFor); when the window's `invoicedOn` date arrives,
 * the scheduled job creates an Invoice for every enrolled supplier with
 * confirmed, paid bookings in that window.
 *
 *   Scheduled run:   generateDueInvoices() — idempotent via
 *                    Invoice.runKey = "invoice:<supplierId>:<cycleStartISO>:<currency>"
 *                    Only ELIGIBLE bookings are invoiced. A booking that is
 *                    still clearing when its window runs is picked up by a
 *                    later run — appended to the window's unpaid invoice, or
 *                    raised on its own catch-up invoice if that one is already
 *                    closed. Bookings are never double invoiced:
 *                    InvoiceItem.bookingId is unique.
 *   Money movement:  finance approves the invoice (approveInvoice — maker,
 *                    checker, audit), sends the transfer itself, then records
 *                    the real bank reference with markInvoicePaid — no
 *                    provider API, and no way from INVOICED to PAID without
 *                    passing through APPROVED.
 *   Estimate:        buildInvoiceEstimate() — the "Next payout" projection,
 *                    which counts only ELIGIBLE money in the pending window and
 *                    recalculates on cancellations/refunds/date changes because
 *                    it is a live query, not a snapshot.
 *
 * Point of no return: once an invoice exists for a supplier+window+currency,
 * its line items are immutable; corrections go through the admin finance queue
 * (cancellations before payment detach the line item and re-open the booking,
 * mirroring detachBookingFromActiveRequests for v2 requests).
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const { logActivity } = require('./auditLogger');
const { enqueueNotification } = require('./queue');
const { invoiceWindowFor, nextInvoiceWindow } = require('./payoutCycles');
const { resolvePayoutMethod, promoteDueCycles } = require('./payoutRuns');
const { PAYABLE_BOOKING_STATUSES } = require('./financeHelpers');
const { applyChargesToInvoice } = require('./commissionLedger');

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The finance-v3 booking predicate: only ELIGIBLE money moves. A booking counts
 * once the eligibility sweep has released it — its activity date has passed
 * (plus any clearance buffer), the customer paid, the booking is in a payable
 * status and nothing is frozen by an open dispute. Still-clearing (PENDING)
 * bookings — including tours whose activity date is in the future — are
 * deliberately excluded from both the estimate and the invoice.
 * NO_SHOW bookings are payable (non-refundable, supplier performed —
 * GetYourGuide Supplier T&C §3.9(ii); see PAYABLE_BOOKING_STATUSES).
 * Bookings already claimed by an invoice (INVOICED/PAID) or a legacy v2 payout
 * request (REQUESTED/PAID) are excluded; InvoiceItem.bookingId @unique backs
 * the "never invoiced twice" rule at the database level.
 */
function v3BookingsWhere({ supplierId, window }) {
  return {
    isSimulated: false,
    paymentStatus: 'SUCCEEDED',
    status: { in: [...PAYABLE_BOOKING_STATUSES] },
    payoutStatus: 'ELIGIBLE',
    travelDate: { gte: window.start, lte: window.end },
    tour: { supplierId },
    // Belt and braces, not the primary guard: a supplier-created booking's
    // paymentStatus is PENDING, so it can never be selected here anyway. But
    // paying it out would pay the supplier twice for money they already
    // collected, and that should not depend on one field staying untouched.
    origin: { not: 'SUPPLIER_CREATED' },
  };
}

async function selectInvoiceBookings({ supplierId, window }) {
  return prisma.booking.findMany({
    where: v3BookingsWhere({ supplierId, window }),
    orderBy: [{ travelDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      bookingNumber: true,
      travelDate: true,
      currency: true,
      grossAmount: true,
      platformCommission: true,
      supplierPayout: true,
    },
  });
}

/** Split bookings into one group per currency with net-of-commission totals. */
function groupBookingsByCurrency(bookings) {
  const groups = new Map();
  for (const b of bookings) {
    const currency = b.currency || 'USD';
    if (!groups.has(currency)) groups.set(currency, []);
    groups.get(currency).push(b);
  }
  return [...groups.entries()].map(([currency, items]) => ({
    currency,
    bookingCount: items.length,
    grossTotal: round2(items.reduce((s, b) => s + toNumber(b.grossAmount), 0)),
    commissionTotal: round2(items.reduce((s, b) => s + toNumber(b.platformCommission), 0)),
    netTotal: round2(items.reduce((s, b) => s + toNumber(b.supplierPayout), 0)),
    items,
  }));
}

/**
 * Idempotency key for SCHEDULED runs — one runKey per supplier + window +
 * currency. Catch-up invoices (raised when a booking only cleared after its
 * window's invoice was already settled) deliberately have no runKey, so they
 * can never collide with the scheduled invoice on the unique index.
 */
function invoiceRunKey(supplierId, window, currency) {
  return `invoice:${supplierId}:${new Date(window.start).toISOString()}:${currency || 'USD'}`;
}

/**
 * Human-readable reference, e.g. INV-20261016-1842a9T3 — the same shape as the
 * v2 PR-YYYYMMDD-... request numbers (timestamp + random suffix; unique index).
 */
function nextInvoiceNumber(now = new Date()) {
  const d = new Date(now);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const ts = String(Date.now()).slice(-6);
  const rand = Math.random().toString(36).slice(2, 6);
  return `INV-${datePart}-${ts}${rand}`;
}

// Light hygiene only (mirrors the v2 complete-payout reference check): block
// placeholders and nonsense lengths without enforcing a single format — bank
// references vary by country and institution.
const REFERENCE_PLACEHOLDERS = new Set(['n/a', 'na', 'none', 'null', 'test', 'tbd', 'xxx', '-', 'pending', 'later']);

function normalizeReference(raw) {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!value) return { error: 'A payment reference is required to mark an invoice paid' };
  if (REFERENCE_PLACEHOLDERS.has(value.toLowerCase())) {
    return { error: 'Reference looks like a placeholder. Enter the actual bank/transaction reference' };
  }
  if (value.length < 4) return { error: 'Reference is too short to be a valid transaction reference (min 4 characters)' };
  if (value.length > 100) return { error: 'Reference is too long (max 100 characters)' };
  return { value };
}

function invoiceItemData(booking, invoiceId = null) {
  return {
    ...(invoiceId ? { invoiceId } : {}),
    bookingId: booking.id,
    grossAmount: toNumber(booking.grossAmount),
    platformCommission: toNumber(booking.platformCommission),
    supplierPayout: toNumber(booking.supplierPayout),
    currency: booking.currency || 'USD',
  };
}

/**
 * The "Next payout" estimate — the pre-invoicing projection for a supplier's
 * pending window. Counts only ELIGIBLE money (see v3BookingsWhere), shows the
 * exact activity-date range + processing dates, and resets to the next window
 * once an invoice for the pending window has been generated.
 *
 * @returns {{ window: object|null, bookingCount, grossTotal, commissionTotal,
 *             netTotal, byCurrency: Array }}
 */
async function buildInvoiceEstimate({ supplierId, cycle, now = new Date() }) {
  const window = nextInvoiceWindow(cycle, now);
  if (!window) {
    return {
      window: null,
      bookingCount: 0,
      grossTotal: 0,
      commissionTotal: 0,
      netTotal: 0,
      byCurrency: [],
    };
  }
  const bookings = await selectInvoiceBookings({ supplierId, window });
  const byCurrency = groupBookingsByCurrency(bookings);
  return {
    window: {
      cycle: window.cycle,
      slot: window.slot,
      label: window.label,
      start: window.start,
      end: window.end,
      invoicedOn: window.invoicedOn,
      paidOn: window.paidOn,
    },
    bookingCount: bookings.length,
    grossTotal: round2(byCurrency.reduce((s, g) => s + g.grossTotal, 0)),
    commissionTotal: round2(byCurrency.reduce((s, g) => s + g.commissionTotal, 0)),
    netTotal: round2(byCurrency.reduce((s, g) => s + g.netTotal, 0)),
    byCurrency,
  };
}

/**
 * Finance approves the invoice — the maker–checker step between generation
 * and payment. Only INVOICED invoices can be approved (409 otherwise), the
 * approval records WHO authorized the transfer and WHEN, and markInvoicePaid
 * refuses to run on anything but APPROVED — so the gate can never be skipped
 * or auto-bypassed; there is deliberately no scheduled auto-approval.
 *
 * @param {object} params
 * @param {string} params.invoiceId
 * @param {string} params.adminUserId
 * @param {string} [params.adminEmail]
 * @returns {Promise<object>} the updated invoice row
 */
async function approveInvoice({ invoiceId, adminUserId, adminEmail }) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, invoiceNumber: true, status: true },
  });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status !== 'INVOICED') {
    throw new AppError(
      `Invoice ${invoice.invoiceNumber} is already ${invoice.status.toLowerCase()} — only an awaiting-approval invoice can be approved`,
      409
    );
  }

  const approved = await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: adminUserId },
    select: { id: true, invoiceNumber: true, status: true, approvedAt: true, approvedBy: true },
  });

  await logActivity({
    userId: adminUserId || undefined,
    userEmail: adminEmail || undefined,
    action: 'invoice.approved',
    resource: 'Invoice',
    resourceId: invoice.id,
    oldValues: { status: 'INVOICED' },
    newValues: { status: 'APPROVED' },
    metadata: { invoiceNumber: invoice.invoiceNumber },
  }).catch(() => {});

  return approved;
}

/**
 * Admin marks an approved invoice as actually paid, recording the real
 * bank/transaction reference (money movement stays manual — no provider API;
 * approval already happened via approveInvoice). Flips the line items'
 * bookings to PAID so every payout figure stays consistent.
 *
 * @returns {Promise<object>} the updated invoice row
 */
async function markInvoicePaid({ invoiceId, reference, adminUserId, adminEmail }) {
  const refCheck = normalizeReference(reference);
  if (refCheck.error) throw new AppError(refCheck.error, 400);

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      items: { select: { bookingId: true } },
    },
  });
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status !== 'APPROVED') {
    throw new AppError(
      invoice.status === 'INVOICED'
        ? `Invoice ${invoice.invoiceNumber} is awaiting approval — approve it before recording payment`
        : `Invoice ${invoice.invoiceNumber} is already marked ${invoice.status.toLowerCase()}`,
      409
    );
  }

  const bookingIds = invoice.items.map((i) => i.bookingId);

  const paid = await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt: new Date(), paidBy: adminUserId, reference: refCheck.value },
      select: { id: true, invoiceNumber: true, status: true, paidAt: true, paidBy: true, reference: true },
    });
    if (bookingIds.length > 0) {
      await tx.booking.updateMany({
        where: { id: { in: bookingIds } },
        data: { payoutStatus: 'PAID' },
      });
    }
    // The charges this invoice withheld are now collected — money the
    // platform was owed on bookings the supplier collected offline, and any
    // credits it applied. They were reserved (invoiceId set, still OPEN) at
    // generation; this is the moment they leave the supplier's balance.
    const settledCharges = await tx.supplierCharge.updateMany({
      where: { invoiceId: invoice.id, status: 'OPEN' },
      data: { status: 'SETTLED', settledAt: new Date() },
    });
    return { ...updated, settledCharges: settledCharges.count };
  });

  await logActivity({
    userId: adminUserId || undefined,
    userEmail: adminEmail || undefined,
    action: 'invoice.marked_paid',
    resource: 'Invoice',
    resourceId: invoice.id,
    oldValues: { status: 'APPROVED' },
    newValues: { status: 'PAID', reference: paid.reference },
    metadata: { invoiceNumber: paid.invoiceNumber, bookings: bookingIds.length, chargesSettled: paid.settledCharges || 0 },
  }).catch(() => {});

  return paid;
}

/**
 * Recompute an unpaid invoice's money from its remaining line items and its
 * share of the supplier's open charges.
 *
 * Charges are released and re-selected rather than incrementally adjusted:
 * the greedy oldest-first order is the only thing that makes the result
 * deterministic no matter how many times it runs, and re-running it after any
 * change (a detached booking, a new collection, a reversal) cannot drift.
 *
 * An invoice left with no line items is cancelled and its charges released in
 * full — nothing is owed on a document that will never pay.
 *
 * @param {object} tx Prisma transaction client (or prisma)
 * @param {string} invoiceId
 * @param {object} [opts] options for rows the caller already holds
 * @param {object} [opts.invoice] the invoice row when the caller already has
 *   it (a create just wrote it in this same transaction).
 * @param {object[]} [opts.items] the invoice's line items when the caller
 *   already has them, so the totals are computed from what was written rather
 *   than re-read.
 * @returns {Promise<{status: string, grossTotal: number, commissionTotal:
 *          number, chargesTotal: number, netTotal: number, bookingCount: number}|null>}
 */
async function rebalanceInvoice(tx, invoiceId, { items, invoice: known } = {}) {
  const client = tx || prisma;
  const invoice = known || (await client.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, status: true, supplierId: true, currency: true },
  }));
  if (!invoice) return null;
  if (invoice.status === 'PAID') {
    // Immutable once paid — its charges settled with it.
    return { status: invoice.status, grossTotal: 0, commissionTotal: 0, chargesTotal: 0, netTotal: 0, bookingCount: 0 };
  }

  const lines = items || (await client.invoiceItem.findMany({
    where: { invoiceId },
    select: { grossAmount: true, platformCommission: true, supplierPayout: true },
  }));

  // Release whatever this invoice was holding, then re-select against what
  // remains. A charge that no longer fits goes back into the open pool for
  // the next cycle rather than pushing the invoice negative.
  await client.supplierCharge.updateMany({ where: { invoiceId }, data: { invoiceId: null } });

  if (lines.length === 0) {
    const money = { status: 'CANCELLED', grossTotal: 0, commissionTotal: 0, chargesTotal: 0, netTotal: 0, bookingCount: 0 };
    await client.invoice.update({ where: { id: invoiceId }, data: money });
    return money;
  }

  const grossTotal = round2(lines.reduce((s, r) => s + toNumber(r.grossAmount), 0));
  const commissionTotal = round2(lines.reduce((s, r) => s + toNumber(r.platformCommission), 0));
  const payments = round2(lines.reduce((s, r) => s + toNumber(r.supplierPayout), 0));
  const { chargesTotal, netTotal } = await applyChargesToInvoice(client, {
    supplierId: invoice.supplierId,
    currency: invoice.currency,
    payments,
    invoiceId,
  });

  const money = { status: invoice.status, grossTotal, commissionTotal, chargesTotal, netTotal, bookingCount: lines.length };
  await client.invoice.update({ where: { id: invoiceId }, data: money });
  return money;
}

/**
 * Detach a booking from any unpaid (INVOICED or APPROVED) invoice. Removes
 * the line item and rebalances the invoice's money totals + bookingCount from
 * its remaining items (re-selecting its share of open charges on the way);
 * cancels a now-empty invoice and releases every charge it held. PAID
 * invoices are left untouched — their ledger rows are immutable and
 * corrections happen via disputes (mirrors detachBookingFromActiveRequests
 * for v2 payout requests).
 *
 * @param {object} tx Prisma transaction client (or prisma)
 * @param {string} bookingId
 * @returns {Promise<number>} number of invoiced line items removed
 */
async function detachBookingFromInvoices(tx, bookingId) {
  const client = tx || prisma;

  const items = await client.invoiceItem.findMany({
    where: { bookingId, invoice: { status: { in: ['INVOICED', 'APPROVED'] } } },
    select: { id: true, invoiceId: true },
  });

  let adjusted = 0;
  for (const item of items) {
    await client.invoiceItem.delete({ where: { id: item.id } });
    await rebalanceInvoice(client, item.invoiceId);
    adjusted += 1;
  }
  return adjusted;
}

/**
 * The scheduled invoice job (hourly; idempotent). For every enrolled supplier
 * it collects confirmed/paid bookings whose invoice window's invoice date has
 * arrived, groups them by (window, currency) and creates one Invoice per group
 * under a stable runKey. Re-fires are no-ops; bookings that land after the
 * invoice was created (e.g. a delayed payment confirmation) are appended to
 * the existing unpaid invoice (INVOICED or APPROVED). Missed days self-heal:
 * the window stays due until its invoice exists.
 *
 * Also promotes pending payout-cycle switches (previously inside the v2 sweep,
 * which v3 supersedes).
 */
async function generateDueInvoices(now = new Date()) {
  const promoted = await promoteDueCycles(now);

  const report = {
    windows: 0,
    invoicesCreated: 0,
    bookingsInvoiced: 0,
    appendedBookings: 0,
    skippedNoMethod: 0,
    skippedNoFunds: 0,
  };

  const profiles = await prisma.supplierProfile.findMany({
    where: { payoutCycle: { not: null }, status: { in: ['APPROVED', 'ACTIVE'] } },
    select: { userId: true, payoutCycle: true },
  });

  // A booking's invoice date is at most ~16 days after its window starts, so
  // nothing beyond ~45 days out can be due — keeps the per-supplier query cheap.
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + 45);

  for (const profile of profiles) {
    const cycle = profile.payoutCycle;

    const method = await resolvePayoutMethod({ supplierId: profile.userId });
    if (!method) {
      // No verified destination — eligible bookings stay un-invoiced and the
      // hourly run retries once the supplier adds one. Never stranded.
      report.skippedNoMethod += 1;
      continue;
    }

    const bookings = await prisma.booking.findMany({
      where: {
        isSimulated: false,
        paymentStatus: 'SUCCEEDED',
        status: { in: [...PAYABLE_BOOKING_STATUSES] },
        payoutStatus: 'ELIGIBLE',
        travelDate: { lte: horizon },
        tour: { supplierId: profile.userId },
        // See v3BookingsWhere: never pay out money the supplier already
        // collected themselves.
        origin: { not: 'SUPPLIER_CREATED' },
      },
      select: {
        id: true,
        bookingNumber: true,
        travelDate: true,
        currency: true,
        grossAmount: true,
        platformCommission: true,
        supplierPayout: true,
      },
    });
    if (bookings.length === 0) {
      report.skippedNoFunds += 1;
      continue;
    }

    // Group by (window, currency). Windows whose invoice date has not arrived
    // stay on the "Next payout" estimate.
    const byRunKey = new Map();
    for (const b of bookings) {
      const window = invoiceWindowFor(b.travelDate, cycle);
      if (!window || window.invoicedOn > now) continue;
      const currency = b.currency || 'USD';
      const key = invoiceRunKey(profile.userId, window, currency);
      if (!byRunKey.has(key)) byRunKey.set(key, { window, currency, items: [] });
      byRunKey.get(key).items.push(b);
    }

    const createdThisSupplier = [];
    for (const [key, group] of byRunKey) {
      const grossTotal = round2(group.items.reduce((s, b) => s + toNumber(b.grossAmount), 0));
      const commissionTotal = round2(group.items.reduce((s, b) => s + toNumber(b.platformCommission), 0));
      const netTotal = round2(group.items.reduce((s, b) => s + toNumber(b.supplierPayout), 0));

      const existing = await prisma.invoice.findUnique({
        where: { runKey: key },
        select: { id: true, status: true },
      });

      // An unpaid invoice (INVOICED/APPROVED) already exists for this
      // window+currency and absorbs anything that arrives after it was created
      // (a delayed payment confirm, a booking that only just cleared). A closed
      // invoice (PAID/CANCELLED) cannot be touched, so a late-clearing booking
      // is raised on its own catch-up invoice instead of being stranded:
      // runKey is unique per window+currency, so the catch-up carries none.
      // InvoiceItem.bookingId uniqueness + the ELIGIBLE filter guarantee the
      // booking is never invoiced twice.
      const openExisting = Boolean(existing && ['INVOICED', 'APPROVED'].includes(existing.status));

      if (openExisting) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.invoiceItem.createMany({
              data: group.items.map((b) => invoiceItemData(b, existing.id)),
            });
            await tx.booking.updateMany({
              where: { id: { in: group.items.map((b) => b.id) } },
              data: { payoutStatus: 'INVOICED' },
            });
            // Rebuilt from the full set of items rather than incremented: an
            // appended invoice also re-selects the supplier's open charges
            // against the larger payment, so a commission raised since the
            // invoice was created is picked up here and netted off it.
            await rebalanceInvoice(tx, existing.id);
          });
          report.appendedBookings += group.items.length;
        } catch (err) {
          if (String(err?.code) !== 'P2002') throw err;
          // Already appended by a concurrent run — next run reconciles.
        }
      } else {
        if (!existing) report.windows += 1;
        try {
          const invoice = await prisma.$transaction(async (tx) => {
            const created = await tx.invoice.create({
              data: {
                invoiceNumber: nextInvoiceNumber(now),
                supplierId: profile.userId,
                cycle,
                cycleStartDate: group.window.start,
                cycleEndDate: group.window.end,
                cycleLabel: group.window.label,
                invoicedAt: new Date(now),
                paymentScheduledAt: group.window.paidOn,
                payoutMethodId: method.id,
                grossTotal,
                commissionTotal,
                // Payment before charges; rebalanceInvoice below nets the
                // supplier's open charges off this and writes the result.
                netTotal,
                currency: group.currency,
                bookingCount: group.items.length,
                runKey: existing ? null : key,
                items: { create: group.items.map((b) => invoiceItemData(b)) },
              },
            });
            await tx.booking.updateMany({
              where: { id: { in: group.items.map((b) => b.id) } },
              data: { payoutStatus: 'INVOICED' },
            });
            const money = await rebalanceInvoice(tx, created.id, { invoice: created, items: group.items });
            // The invoice as it now stands: payments minus whatever charge
            // share it carries. Reading the rebalanced figures rather than the
            // placeholders written at create keeps the notification honest.
            return { ...created, ...(money || {}) };
          });
          report.invoicesCreated += 1;
          report.bookingsInvoiced += group.items.length;
          createdThisSupplier.push({
            invoiceNumber: invoice.invoiceNumber,
            netTotal: toNumber(invoice.netTotal),
            chargesTotal: toNumber(invoice.chargesTotal),
            currency: group.currency,
            label: group.window.label,
            paidOn: group.window.paidOn,
          });
        } catch (err) {
          if (String(err?.code) !== 'P2002') throw err; // real DB failure → BullMQ retries
          // Unique clash (runKey or bookingId): a concurrent run created the
          // invoice / claimed the bookings. The next hourly run reconciles.
        }
      }
    }

    if (createdThisSupplier.length > 0) {
      enqueueNotification({
        userId: profile.userId,
        type: 'INVOICE_GENERATED',
        title: 'Your invoice has been generated',
        message: createdThisSupplier
          .map((c) => `${c.invoiceNumber} (${c.label}): ${c.currency} ${c.netTotal.toFixed(2)}`
            + (c.chargesTotal ? ` after ${c.currency} ${c.chargesTotal.toFixed(2)} in platform charges` : '')
            + ` — payment scheduled ${c.paidOn.toISOString().slice(0, 10)}`)
          .join(' · '),
        data: { invoices: createdThisSupplier.map((c) => c.invoiceNumber) },
      }).catch(() => {});
    }
  }

  console.log(
    `[Finance] v3 invoices: ${report.invoicesCreated} new (${report.bookingsInvoiced} bookings), `
    + `${report.appendedBookings} appended, ${report.windows} window(s) processed, `
    + `${report.skippedNoMethod} skipped (no payout method), ${report.skippedNoFunds} without funds, `
    + `${promoted} pending cycle switch(es) applied`
  );

  return report;
}

module.exports = {
  v3BookingsWhere,
  selectInvoiceBookings,
  groupBookingsByCurrency,
  invoiceRunKey,
  nextInvoiceNumber,
  normalizeReference,
  buildInvoiceEstimate,
  approveInvoice,
  markInvoicePaid,
  generateDueInvoices,
  detachBookingFromInvoices,
  rebalanceInvoice,
};