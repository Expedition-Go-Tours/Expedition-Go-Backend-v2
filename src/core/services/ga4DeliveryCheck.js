/**
 * Recurring alarm: settled purchases that GA never confirmed receiving.
 *
 * The 2026-10-30 incident was not hard to fix once someone noticed — it was
 * hard to notice. The Measurement Protocol answers 204 to an unusable secret,
 * the code said `purchase sent`, and the loss only surfaced when a human
 * compared the GA4 UI against the database a week later.
 *
 * Now every confirmed delivery is stamped on the booking
 * (`Booking.ga4ReportedAt`, see ga4Measurement.markReported). This sweep looks
 * for the opposite: a booking that *should* have been reported — analytics
 * consent granted, a GA client_id captured, money actually settled — with no
 * confirmation stamp. That is a configuration fault, not a business choice, so
 * it belongs in the error log where the incident monitor can see it.
 *
 * Deliberately not auto-repairing: a silent re-send loop could double-count
 * revenue. The message names the script that fixes it.
 *
 * The same sweep covers refunds (see findUnderreportedRefunds): a purchase that
 * reached GA but whose refund did not is equally wrong, just in the other
 * direction.
 *
 * Neither alarm can see a *wrong* stamp: `ga4ReportedAt` is written on any 2xx,
 * and GA answers 204 to an unusable API secret as readily as to a good one.
 * When the read side is configured, reportBookingsGaNeverReceived asks GA's own
 * reports instead — see the note on that function.
 */

const prisma = require('./prismaClient');

/** Grace period: the send is fire-and-forget, so give it time to land. */
const DEFAULT_GRACE_MS = 60 * 60 * 1000;
/** How far back a sweep looks. Runs every few hours, so 7 days is generous. */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SETTLED = ['SUCCEEDED', 'REFUNDED'];

/**
 * Bookings that owed GA a purchase event and never got a confirmed delivery.
 *
 * @param {{ now?: number, lookbackMs?: number, graceMs?: number }} [opts]
 * @returns {Promise<Array>} bookings, oldest first
 */
async function findUnreportedPurchases({
  now = Date.now(),
  lookbackMs = DEFAULT_LOOKBACK_MS,
  graceMs = DEFAULT_GRACE_MS,
} = {}) {
  return prisma.booking.findMany({
    where: {
      paidAt: { gte: new Date(now - lookbackMs), lte: new Date(now - graceMs) },
      analyticsConsent: true,
      gaClientId: { not: null },
      ga4ReportedAt: null,
      paymentStatus: { in: SETTLED },
    },
    select: {
      bookingNumber: true,
      paidAt: true,
      grossAmount: true,
      currency: true,
      gaClientId: true,
    },
    orderBy: { paidAt: 'asc' },
  });
}

/**
 * Log one line naming every booking GA should have but does not. Returns the
 * summary so a test (or an admin endpoint) can assert on it without parsing
 * logs.
 *
 * @returns {Promise<{count: number, revenue: number, bookings: string[]}>}
 */
async function reportUnreportedPurchases(opts = {}) {
  const bookings = await findUnreportedPurchases(opts);
  const revenue = bookings.reduce((sum, b) => sum + Number(b.grossAmount), 0);

  if (bookings.length > 0) {
    const refs = bookings.map((b) => b.bookingNumber).join(', ');
    console.error(
      `[ga4Health] ${bookings.length} consented purchase(s) worth $${revenue.toFixed(2)} settled but were ` +
        `never confirmed by GA4: ${refs}. GA4 will not show this revenue. ` +
        'Check GA4_API_SECRET (it must be the 22-character Measurement Protocol secret, not the data-stream ID), ' +
        'then run `node scripts/ga4-reconcile.js --backfill`.'
    );
  }

  return { count: bookings.length, revenue, bookings: bookings.map((b) => b.bookingNumber) };
}

/**
 * The same alarm for money coming back out.
 *
 * A refund whose event never reached GA leaves the purchase standing: the
 * booking is stamped as reported, revenue looks fine, and GA keeps counting
 * money the customer has had returned. `ga4RefundReportedAmount` is a running
 * total, so a partial refund that failed after an earlier one succeeded shows
 * up as a shortfall rather than a boolean that is already true.
 *
 * Only bookings whose *purchase* was confirmed are considered: if the purchase
 * never landed, the purchase alarm already names it, and backfilling that
 * booking sends its refund in the same pass.
 */
async function findUnderreportedRefunds({
  now = Date.now(),
  lookbackMs = DEFAULT_LOOKBACK_MS,
  graceMs = DEFAULT_GRACE_MS,
} = {}) {
  const rows = await prisma.booking.findMany({
    where: {
      refundedAt: { gte: new Date(now - lookbackMs), lte: new Date(now - graceMs) },
      analyticsConsent: true,
      gaClientId: { not: null },
      ga4ReportedAt: { not: null },
      refundAmount: { gt: 0 },
    },
    select: {
      bookingNumber: true,
      refundedAt: true,
      refundAmount: true,
      ga4RefundReportedAmount: true,
      currency: true,
    },
    orderBy: { refundedAt: 'asc' },
  });

  return rows
    .map((b) => ({
      ...b,
      shortfall: Number((Number(b.refundAmount) - Number(b.ga4RefundReportedAmount || 0)).toFixed(2)),
    }))
    // Floating point: anything under a cent is noise, not a missing event.
    .filter((b) => b.shortfall > 0.005);
}

/**
 * Log one line naming every refund GA should have but does not, and how much
 * revenue it is still counting for money that was returned.
 *
 * @returns {Promise<{count: number, revenue: number, bookings: string[]}>}
 */
async function reportUnreportedRefunds(opts = {}) {
  const refunds = await findUnderreportedRefunds(opts);
  const revenue = refunds.reduce((sum, b) => sum + b.shortfall, 0);

  if (refunds.length > 0) {
    const refs = refunds.map((b) => b.bookingNumber).join(', ');
    console.error(
      `[ga4Health] ${refunds.length} consented refund(s) worth $${revenue.toFixed(2)} were never confirmed by GA4: ` +
        `${refs}. GA4 is still counting this money as revenue. ` +
        'Check GA4_API_SECRET, then run `node scripts/ga4-reconcile.js --backfill`.'
    );
  }

  return { count: refunds.length, revenue, bookings: refunds.map((b) => b.bookingNumber) };
}

/**
 * ── The independent check ──────────────────────────────────────────────────

const ga4Reporting = require('./ga4Reporting');

/** GA's standard reports need time; alarm only on events old enough to have landed. */
const DEFAULT_MIN_AGE_MS = 48 * 60 * 60 * 1000;

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Consent-granted, settled purchases GA does not list.
 *
 * @param {{ now?: number, lookbackMs?: number, minAgeMs?: number, fetchImpl?: Function }} [opts]
 * @returns {Promise<{skipped: string|null, bookings: Array}>}
 */
async function findBookingsGaNeverReceived({
  now = Date.now(),
  lookbackMs = 7 * 24 * 60 * 60 * 1000,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  fetchImpl = fetch,
} = {}) {
  // Required lazily: the DB-side alarms must work with no read side configured,
  // and this module should not drag in the reporting service when it cannot be
  // used anyway.
  const ga4Reporting = require('./ga4Reporting');
  if (!ga4Reporting.isConfigured()) return { skipped: 'read-side-not-configured', bookings: [] };

  const bookings = await prisma.booking.findMany({
    where: {
      paidAt: { gte: new Date(now - lookbackMs), lte: new Date(now - minAgeMs) },
      analyticsConsent: true,
      gaClientId: { not: null },
      paymentStatus: { in: SETTLED },
    },
    select: { bookingNumber: true, paidAt: true, grossAmount: true, currency: true },
    orderBy: { paidAt: 'asc' },
  });
  if (bookings.length === 0) return { skipped: null, bookings: [] };

  const ledger = await ga4Reporting.fetchPurchaseLedger(
    { from: isoDay(now - lookbackMs), to: isoDay(now - minAgeMs) },
    { fetchImpl }
  );
  const inGa = new Set(ledger.map((row) => row.transactionId));

  return { skipped: null, bookings: bookings.filter((b) => !inGa.has(b.bookingNumber)) };
}

/**
 * Alarm on purchases GA's own reports do not contain.
 *
 * Returns `{ skipped }` when the read side is unavailable, so a caller can
 * distinguish "checked and clean" from "nobody looked" — a silent zero here
 * would be the same class of lie this whole module was built to prevent.
 *
 * @returns {Promise<{skipped: string|null, count: number, revenue: number, bookings: string[]}>}
 */
async function reportBookingsGaNeverReceived(opts = {}) {
  const { skipped, bookings } = await findBookingsGaNeverReceived(opts);
  if (skipped) return { skipped, count: 0, revenue: 0, bookings: [] };

  const revenue = bookings.reduce((sum, b) => sum + Number(b.grossAmount), 0);
  if (bookings.length > 0) {
    const refs = bookings.map((b) => b.bookingNumber).join(', ');
    console.error(
      `[ga4Health] ${bookings.length} consented purchase(s) worth $${revenue.toFixed(2)} are marked delivered in ` +
        `the database but GA4's own reports do not contain them: ${refs}. The delivery ledger is a 2xx, not ` +
        'proof of receipt — GA4 answers 204 to an unusable API secret. Check GA4_API_SECRET, then run ' +
        '`node scripts/ga4-reconcile.js --backfill`.'
    );
  }

  return { skipped: null, count: bookings.length, revenue, bookings: bookings.map((b) => b.bookingNumber) };
}

module.exports = {
  findUnreportedPurchases,
  reportUnreportedPurchases,
  findUnderreportedRefunds,
  reportUnreportedRefunds,
  findBookingsGaNeverReceived,
  reportBookingsGaNeverReceived,
  DEFAULT_GRACE_MS,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_MIN_AGE_MS,
};
