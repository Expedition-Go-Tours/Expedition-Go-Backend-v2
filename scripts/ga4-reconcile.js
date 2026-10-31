#!/usr/bin/env node
/**
 * GA4 → database reconciliation for money events.
 *
 * Built after the 2026-10-30 incident: the API ran for a week with the numeric
 * data-stream ID as `GA4_API_SECRET`. GA answers 204 to that, the code logged
 * `purchase sent`, and the only evidence of the loss was in pm2 logs that had
 * already rotated. There was no way to ask "which bookings never reached GA?"
 *
 * There is now: `Booking.ga4ReportedAt` is written only after Google accepted
 * the purchase, so the answer is one query. This script prints that ledger and,
 * with `--backfill`, delivers the bookings GA is missing. `--mark-reported`
 * and `--mark-refund-reported` record deliveries known to be in GA already
 * (from before the ledger existed) so they are not listed as missing and never
 * double-delivered. `--forget-reported` is the inverse: the first run of this
 * script was handed four bookings whose only evidence was a `purchase sent` log
 * line from the period when a bad secret made GA discard everything silently,
 * and the read side then proved GA never received them. A mark you cannot
 * unmark is a mark that stays wrong.
 *
 * The read side is also the only independent check on the write side: it is how
 * "we sent it" gets corrected to "GA has it".
 *
 * Usage (from the app directory, so it can read .env):
 *
 *   node scripts/ga4-reconcile.js                     # last 28 days, report only
 *   node scripts/ga4-reconcile.js --since 2026-10-01   # explicit window
 *   node scripts/ga4-reconcile.js --backfill          # deliver what is missing
 *   node scripts/ga4-reconcile.js --mark-reported TRG-1,TRG-2
 *   node scripts/ga4-reconcile.js --mark-refund-reported TRG-1  # refunds GA already has
 *   node scripts/ga4-reconcile.js --forget-reported TRG-1        # a mark that was wrong
 *   node scripts/ga4-reconcile.js --json
 *
 * `--backfill` sends an event with the CURRENT timestamp. The Measurement
 * Protocol rejects anything older than 72 hours, so a purchase from last week
 * can only be delivered "now": the total becomes right, the day does not. Each
 * such event carries `reconciled=true`, `original_paid_at` and `days_late` so
 * the distortion is visible inside GA instead of living in someone's memory.
 *
 * It also repairs refunds, in both directions: a refunded booking whose purchase
 * is missing gets its refund in the same pass (otherwise backfilling the
 * purchase would invent revenue the customer already had returned), and a
 * confirmed purchase whose refund event never landed gets the shortfall sent.
 *
 * When the read side is configured (GA4_PROPERTY_ID + a service account) the
 * script also fetches GA's own transaction ledger and diffs it against the
 * database, which is how a phantom item like `credential check` gets named.
 */

require('dotenv').config();

const prisma = require('../src/core/services/prismaClient');
const { sendPurchase, sendRefund, isEnabled } = require('../src/core/services/ga4Measurement');
const ga4Reporting = require('../src/core/services/ga4Reporting');

const SETTLED = new Set(['SUCCEEDED', 'REFUNDED']);

function parseArgs(argv) {
  const args = { since: null, until: null, backfill: false, json: false, markReported: [], markRefundReported: [], forgetReported: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backfill') args.backfill = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--until') args.until = argv[++i];
    else if (arg.startsWith('--mark-reported=')) args.markReported.push(...arg.slice(16).split(','));
    else if (arg === '--mark-reported') args.markReported.push(...String(argv[++i] || '').split(','));
    else if (arg.startsWith('--mark-refund-reported=')) args.markRefundReported.push(...arg.slice(23).split(','));
    else if (arg === '--mark-refund-reported') args.markRefundReported.push(...String(argv[++i] || '').split(','));
    else if (arg.startsWith('--forget-reported=')) args.forgetReported.push(...arg.slice(18).split(','));
    else if (arg === '--forget-reported') args.forgetReported.push(...String(argv[++i] || '').split(','));
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  args.markReported = args.markReported.map((s) => s.trim()).filter(Boolean);
  args.markRefundReported = args.markRefundReported.map((s) => s.trim()).filter(Boolean);
  args.forgetReported = args.forgetReported.map((s) => s.trim()).filter(Boolean);
  return args;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function defaultWindow() {
  const until = new Date();
  const since = new Date(until.getTime() - 28 * 24 * 60 * 60 * 1000);
  return { since: isoDay(since), until: isoDay(until) };
}

/** The reporting bucket a booking falls in, mirroring ga4Measurement's gate. */
function consentBucket(booking) {
  if (booking.analyticsConsent === true) return 'consented';
  if (booking.analyticsConsent === false) return 'declined';
  return 'not-captured';
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/ga4-reconcile.js [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--backfill] [--mark-reported TRG-..] [--mark-refund-reported TRG-..] [--forget-reported TRG-..] [--json]');
    return;
  }

  const window = args.since
    ? { since: args.since, until: args.until || defaultWindow().until }
    : { ...defaultWindow(), ...(args.until ? { until: args.until } : {}) };

  const from = new Date(`${window.since}T00:00:00.000Z`);
  // Inclusive of the whole `until` day.
  const to = new Date(`${window.until}T23:59:59.999Z`);

  // Clear marks that turned out to be wrong. `--mark-reported` was once handed
  // four bookings whose only evidence was a `purchase sent` log line from the
  // period when the bad secret meant GA discarded everything silently. GA's own
  // ledger disagreed, and a mark that cannot be unmarked is a mark that will be
  // trusted for the wrong booking forever.
  if (args.forgetReported.length) {
    const { count } = await prisma.booking.updateMany({
      where: { bookingNumber: { in: args.forgetReported } },
      data: { ga4ReportedAt: null, ga4RefundReportedAt: null, ga4RefundReportedAmount: null },
    });
    console.log(`cleared ${count} booking(s) from the delivery ledger: ${args.forgetReported.join(', ')}\n`);
  }

  // Record known-good deliveries BEFORE reading, so this same run reports the
  // state the operator just told us about instead of re-listing them.
  if (args.markReported.length) {
    const { count } = await prisma.booking.updateMany({
      where: { bookingNumber: { in: args.markReported }, ga4ReportedAt: null },
      data: { ga4ReportedAt: new Date() },
    });
    console.log(`marked ${count} booking(s) as already delivered to GA: ${args.markReported.join(', ')}\n`);
  }

  // Same for refunds delivered before the refund ledger existed. Without this
  // they would read as missing, and a backfill would subtract money GA has
  // already reversed.
  if (args.markRefundReported.length) {
    const targets = await prisma.booking.findMany({
      where: { bookingNumber: { in: args.markRefundReported }, refundAmount: { gt: 0 } },
      select: { id: true, bookingNumber: true, refundAmount: true, ga4RefundReportedAmount: true },
    });
    let marked = 0;
    for (const row of targets) {
      const reported = row.ga4RefundReportedAmount != null ? Number(row.ga4RefundReportedAmount) : 0;
      if (reported >= Number(row.refundAmount)) continue;
      // Sequential on purpose: a handful of rows, and it keeps the log honest.
      await prisma.booking.update({
        where: { id: row.id },
        data: { ga4RefundReportedAt: new Date(), ga4RefundReportedAmount: Number(row.refundAmount) },
      });
      marked += 1;
    }
    console.log(`marked ${marked}/${targets.length} booking(s) as having their refund already delivered to GA: ${args.markRefundReported.join(', ')}\n`);
  }

  const bookings = await prisma.booking.findMany({
    where: { paidAt: { gte: from, lte: to } },
    select: {
      id: true,
      bookingNumber: true,
      paidAt: true,
      grossAmount: true,
      currency: true,
      paymentStatus: true,
      analyticsConsent: true,
      gaClientId: true,
      ga4ReportedAt: true,
      refundedAt: true,
      refundAmount: true,
      ga4RefundReportedAmount: true,
      tour: { select: { title: true } },
    },
    orderBy: { paidAt: 'asc' },
  });

  const settled = bookings.filter((b) => SETTLED.has(String(b.paymentStatus)));

  const bucket = { consented: [], declined: [], 'not-captured': [] };
  for (const b of settled) bucket[consentBucket(b)].push(b);

  const reported = bucket.consented.filter((b) => b.ga4ReportedAt);
  const missing = bucket.consented.filter((b) => !b.ga4ReportedAt);

  const sum = (rows) => rows.reduce((acc, b) => acc + Number(b.grossAmount), 0);
  const refunded = (b) => (b.refundAmount != null ? Number(b.refundAmount) : 0);
  const refundConfirmed = (b) => (b.ga4RefundReportedAmount != null ? Number(b.ga4RefundReportedAmount) : 0);

  // A refund only has a GA purchase to reverse when the purchase itself was
  // confirmed; otherwise backfilling the purchase carries the refund with it.
  const refundDue = (b) => {
    if (!b.ga4ReportedAt) return 0;
    return Number((refunded(b) - refundConfirmed(b)).toFixed(2));
  };
  const underreportedRefunds = reported.filter((b) => refundDue(b) > 0.005);

  const report = {
    window,
    settled: { count: settled.length, revenue: sum(settled) },
    consented: { count: bucket.consented.length, revenue: sum(bucket.consented) },
    reported: { count: reported.length, revenue: sum(reported) },
    missing: {
      count: missing.length,
      revenue: sum(missing),
      bookings: missing.map((b) => ({
        bookingNumber: b.bookingNumber,
        paidAt: b.paidAt.toISOString(),
        amount: Number(b.grossAmount),
        currency: b.currency,
        tour: b.tour?.title || null,
        hasClientId: Boolean(b.gaClientId),
      })),
    },
    excluded: {
      declined: { count: bucket.declined.length, revenue: sum(bucket.declined) },
      notCaptured: { count: bucket['not-captured'].length, revenue: sum(bucket['not-captured']) },
    },
    // Money coming back out. GA subtracts refund events from purchase revenue,
    // so an undelivered refund leaves revenue overstated by exactly this much.
    refunds: {
      count: reported.filter((b) => refunded(b) > 0).length,
      expected: reported.reduce((acc, b) => acc + refunded(b), 0),
      confirmed: reported.reduce((acc, b) => acc + Math.min(refundConfirmed(b), refunded(b)), 0),
      missing: {
        count: underreportedRefunds.length,
        revenue: underreportedRefunds.reduce((acc, b) => acc + refundDue(b), 0),
        bookings: underreportedRefunds.map((b) => ({
          bookingNumber: b.bookingNumber,
          refundedAt: b.refundedAt ? b.refundedAt.toISOString() : null,
          refundAmount: refunded(b),
          confirmedInGa: refundConfirmed(b),
          shortfall: refundDue(b),
          currency: b.currency,
        })),
      },
    },
    errors: [],
  };

  // Read side: only when a service account exists. Without it this is a
  // database-side audit, which is still the authoritative half.
  if (ga4Reporting.isConfigured()) {
    try {
      const ledger = await ga4Reporting.fetchPurchaseLedger({ from: window.since, to: window.until });
      const inGa = new Map(ledger.map((r) => [r.transactionId, r]));
      // Only consented bookings were ever supposed to reach GA. Diffing against
      // every settled booking would report every declined and every
      // no-consent booking as "absent from GA", which is a correct omission,
      // not a discrepancy — that is what made the first run say 41 missing
      // when the real answer was 10.
      const inDb = new Set(bucket.consented.map((b) => b.bookingNumber));
      report.ga = {
        revenue: ledger.reduce((acc, r) => acc + r.revenue, 0),
        transactions: ledger.length,
        itemsPurchased: ledger.reduce((acc, r) => acc + r.itemsPurchased, 0),
        // In GA with no matching booking: a manual test, a duplicate, or a
        // booking deleted from the database.
        unknownToDb: ledger.filter((r) => !inDb.has(r.transactionId)).map((r) => ({ transactionId: r.transactionId, revenue: r.revenue })),
        // Consent was granted, so these were supposed to be in GA and are not.
        absentFromGa: [...inDb].filter((num) => !inGa.has(num)),
        // Declined or never captured: GA must NOT have them. Present here only
        // so a report that reads clean on both sides is unambiguous.
        correctlyExcluded: [...bucket.declined, ...bucket['not-captured']]
          .filter((b) => inGa.has(b.bookingNumber))
          .map((b) => b.bookingNumber),
      };
    } catch (err) {
      report.errors.push(`GA4 read failed: ${err.message}`);
    }
  } else {
    report.ga = null;
    report.errors.push('GA4 read side not configured (GA4_PROPERTY_ID + GA4_SERVICE_ACCOUNT_JSON) — database audit only');
  }

  if (args.backfill) {
    if (!isEnabled()) {
      report.errors.push('GA4 write side not configured (GA4_MEASUREMENT_ID + GA4_API_SECRET) — nothing sent');
    } else {
      const delivered = [];
      const reconciledParams = (b) => ({
        reconciled: true,
        original_paid_at: b.paidAt.toISOString(),
        days_late: Math.floor((Date.now() - b.paidAt.getTime()) / (24 * 60 * 60 * 1000)),
      });

      // Missing purchases first. A refunded booking must carry its refund in the
      // same pass, or backfilling the purchase would add revenue GA never had.
      for (const b of missing) {
        // GA4 accepts timestamp_micros up to 72h back, so a recent booking can be
        // reported on the day it was actually paid instead of today. Older ones
        // cannot, and the current timestamp is the only option — the total still
        // becomes right, the day does not.
        const ageMs = Date.now() - b.paidAt.getTime();
        const withinWindow = ageMs >= 0 && ageMs < 72 * 60 * 60 * 1000;
        const opts = { extraParams: reconciledParams(b) };
        if (withinWindow) opts.timestampMicros = Math.floor(b.paidAt.getTime() * 1000);

        // Sequential on purpose: keeps the log readable and GA calm.
        const outcome = await sendPurchase(b, opts);
        delivered.push({
          kind: 'purchase',
          bookingNumber: b.bookingNumber,
          amount: Number(b.grossAmount),
          datedOriginal: withinWindow,
          ...outcome,
        });

        const due = refunded(b);
        if (outcome.ok && due > 0) {
          const refundOpts = { value: due, extraParams: reconciledParams(b) };
          if (withinWindow) refundOpts.timestampMicros = Math.floor(b.paidAt.getTime() * 1000);
          const refund = await sendRefund(b, refundOpts);
          delivered.push({ kind: 'refund', bookingNumber: b.bookingNumber, amount: due, datedOriginal: withinWindow, ...refund });
        }
      }

      // Confirmed purchases with a refund GA never received (or only partly).
      for (const b of underreportedRefunds) {
        const due = refundDue(b);
        const refund = await sendRefund(b, { value: due, extraParams: reconciledParams(b) });
        delivered.push({ kind: 'refund', bookingNumber: b.bookingNumber, amount: due, ...refund });
      }

      report.backfill = delivered;
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const { window: w } = report;
  console.log(`GA4 reconciliation  ${w.since} → ${w.until}`);
  console.log(`settled bookings      ${String(report.settled.count).padStart(3)}  ${money(report.settled.revenue)}`);
  console.log(`  consented           ${String(report.consented.count).padStart(3)}  ${money(report.consented.revenue)}`);
  console.log(`    confirmed in GA   ${String(report.reported.count).padStart(3)}  ${money(report.reported.revenue)}`);
  console.log(`    missing           ${String(report.missing.count).padStart(3)}  ${money(report.missing.revenue)}`);
  console.log(`  declined            ${String(report.excluded.declined.count).padStart(3)}  ${money(report.excluded.declined.revenue)}  (correctly excluded)`);
  console.log(`  consent not captured${String(report.excluded.notCaptured.count).padStart(3)}  ${money(report.excluded.notCaptured.revenue)}  (correctly excluded)`);
  console.log(`  refunds expected    ${String(report.refunds.count).padStart(3)}  ${money(report.refunds.expected)}  (${money(report.refunds.confirmed)} confirmed in GA)`);
  console.log(`    refunds missing   ${String(report.refunds.missing.count).padStart(3)}  ${money(report.refunds.missing.revenue)}`);

  if (report.missing.bookings.length) {
    console.log('\nmissing from GA:');
    for (const b of report.missing.bookings) {
      console.log(`  ${b.bookingNumber}  ${b.paidAt.slice(0, 16).replace('T', ' ')}  ${money(b.amount)}  ${b.tour || ''}${b.hasClientId ? '' : '  [no client_id]'}`);
    }
  }

  if (report.refunds.missing.bookings.length) {
    console.log('\nrefunds GA has not been told about:');
    for (const b of report.refunds.missing.bookings) {
      console.log(`  ${b.bookingNumber}  ${money(b.shortfall)} of ${money(b.refundAmount)}  (${money(b.confirmedInGa)} confirmed)`);
    }
  }

  if (report.ga) {
    console.log(`\nGA4 reports           ${String(report.ga.transactions).padStart(3)} transactions  ${money(report.ga.revenue)}  ${report.ga.itemsPurchased} items`);
    if (report.ga.unknownToDb.length) {
      console.log('in GA but not in the database:');
      for (const r of report.ga.unknownToDb) console.log(`  ${r.transactionId || '(no transaction_id)'}  ${money(r.revenue)}`);
    }
    if (report.ga.absentFromGa.length) {
      console.log(`consented but absent from GA: ${report.ga.absentFromGa.length}`);
      for (const num of report.ga.absentFromGa) console.log(`  ${num}`);
    }
    if (report.ga.correctlyExcluded.length) {
      console.log(`in GA despite no consent (should be empty): ${report.ga.correctlyExcluded.join(', ')}`);
    }
  } else {
    console.log('\nGA read side not configured — set GA4_PROPERTY_ID and GA4_SERVICE_ACCOUNT_JSON to diff both sides.');
  }

  if (report.backfill) {
    const purchases = report.backfill.filter((r) => r.kind === 'purchase');
    const refunds = report.backfill.filter((r) => r.kind === 'refund');
    const okSum = (rows) => rows.filter((r) => r.ok).reduce((a, r) => a + r.amount, 0);
    console.log(
      `\nbackfill: ${purchases.filter((r) => r.ok).length}/${purchases.length} purchase(s) accepted (${money(okSum(purchases))}), ` +
        `${refunds.filter((r) => r.ok).length}/${refunds.length} refund(s) accepted (${money(okSum(refunds))}) — dated now`
    );
    for (const r of report.backfill.filter((x) => !x.ok)) {
      console.log(`  ${r.kind} ${r.bookingNumber} failed: ${r.reason}`);
    }
  }

  for (const e of report.errors) console.log(`\n! ${e}`);
}

main()
  .catch((err) => {
    console.error(`reconcile failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
