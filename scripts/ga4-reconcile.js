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
 * with `--backfill`, delivers the bookings GA is missing.
 *
 * Usage (from the app directory, so it can read .env):
 *
 *   node scripts/ga4-reconcile.js                     # last 28 days, report only
 *   node scripts/ga4-reconcile.js --since 2026-10-01   # explicit window
 *   node scripts/ga4-reconcile.js --backfill          # deliver what is missing
 *   node scripts/ga4-reconcile.js --mark-reported TRG-1,TRG-2
 *   node scripts/ga4-reconcile.js --json
 *
 * `--backfill` sends an event with the CURRENT timestamp. The Measurement
 * Protocol rejects anything older than 72 hours, so a purchase from last week
 * can only be delivered "now": the total becomes right, the day does not. Each
 * such event carries `reconciled=true`, `original_paid_at` and `days_late` so
 * the distortion is visible inside GA instead of living in someone's memory.
 *
 * When the read side is configured (GA4_PROPERTY_ID + a service account) the
 * script also fetches GA's own transaction ledger and diffs it against the
 * database, which is how a phantom item like `credential check` gets named.
 */

require('dotenv').config();

const prisma = require('../src/core/services/prismaClient');
const { sendPurchase, isEnabled } = require('../src/core/services/ga4Measurement');
const ga4Reporting = require('../src/core/services/ga4Reporting');

const SETTLED = new Set(['SUCCEEDED', 'REFUNDED']);

function parseArgs(argv) {
  const args = { since: null, until: null, backfill: false, json: false, markReported: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backfill') args.backfill = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--until') args.until = argv[++i];
    else if (arg.startsWith('--mark-reported=')) args.markReported.push(...arg.slice(16).split(','));
    else if (arg === '--mark-reported') args.markReported.push(...String(argv[++i] || '').split(','));
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  args.markReported = args.markReported.map((s) => s.trim()).filter(Boolean);
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
    console.log('Usage: node scripts/ga4-reconcile.js [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--backfill] [--mark-reported TRG-..,TRG-..] [--json]');
    return;
  }

  const window = args.since
    ? { since: args.since, until: args.until || defaultWindow().until }
    : { ...defaultWindow(), ...(args.until ? { until: args.until } : {}) };

  const from = new Date(`${window.since}T00:00:00.000Z`);
  // Inclusive of the whole `until` day.
  const to = new Date(`${window.until}T23:59:59.999Z`);

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
      tour: { select: { title: true } },
    },
    orderBy: { paidAt: 'asc' },
  });

  const settled = bookings.filter((b) => SETTLED.has(String(b.paymentStatus)));

  if (args.markReported.length) {
    const { count } = await prisma.booking.updateMany({
      where: { bookingNumber: { in: args.markReported }, ga4ReportedAt: null },
      data: { ga4ReportedAt: new Date() },
    });
    console.log(`marked ${count} booking(s) as already delivered to GA: ${args.markReported.join(', ')}\n`);
  }

  const bucket = { consented: [], declined: [], 'not-captured': [] };
  for (const b of settled) bucket[consentBucket(b)].push(b);

  const reported = bucket.consented.filter((b) => b.ga4ReportedAt);
  const missing = bucket.consented.filter((b) => !b.ga4ReportedAt);

  const sum = (rows) => rows.reduce((acc, b) => acc + Number(b.grossAmount), 0);

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
    errors: [],
  };

  // Read side: only when a service account exists. Without it this is a
  // database-side audit, which is still the authoritative half.
  if (ga4Reporting.isConfigured()) {
    try {
      const ledger = await ga4Reporting.fetchPurchaseLedger({ from: window.since, to: window.until });
      const inGa = new Map(ledger.map((r) => [r.transactionId, r]));
      const inDb = new Set(settled.map((b) => b.bookingNumber));
      report.ga = {
        revenue: ledger.reduce((acc, r) => acc + r.revenue, 0),
        transactions: ledger.length,
        itemsPurchased: ledger.reduce((acc, r) => acc + r.itemsPurchased, 0),
        // In GA with no matching booking: a manual test, a duplicate, or a
        // booking deleted from the database.
        unknownToDb: ledger.filter((r) => !inDb.has(r.transactionId)).map((r) => ({ transactionId: r.transactionId, revenue: r.revenue })),
        // In the database, consented, but absent from GA.
        absentFromGa: [...inDb].filter((num) => !inGa.has(num)),
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
      for (const b of missing) {
        const daysLate = Math.floor((Date.now() - b.paidAt.getTime()) / (24 * 60 * 60 * 1000));
        // Sequential on purpose: keeps the log readable and GA calm.
        const outcome = await sendPurchase(b, {
          extraParams: {
            reconciled: true,
            original_paid_at: b.paidAt.toISOString(),
            days_late: daysLate,
          },
        });
        delivered.push({ bookingNumber: b.bookingNumber, amount: Number(b.grossAmount), ...outcome });
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

  if (report.missing.bookings.length) {
    console.log('\nmissing from GA:');
    for (const b of report.missing.bookings) {
      console.log(`  ${b.bookingNumber}  ${b.paidAt.slice(0, 16).replace('T', ' ')}  ${money(b.amount)}  ${b.tour || ''}${b.hasClientId ? '' : '  [no client_id]'}`);
    }
  }

  if (report.ga) {
    console.log(`\nGA4 reports           ${String(report.ga.transactions).padStart(3)} transactions  ${money(report.ga.revenue)}  ${report.ga.itemsPurchased} items`);
    if (report.ga.unknownToDb.length) {
      console.log('in GA but not in the database:');
      for (const r of report.ga.unknownToDb) console.log(`  ${r.transactionId || '(no transaction_id)'}  ${money(r.revenue)}`);
    }
    if (report.ga.absentFromGa.length) {
      console.log(`in the database but absent from GA: ${report.ga.absentFromGa.length}`);
    }
  } else {
    console.log('\nGA read side not configured — set GA4_PROPERTY_ID and GA4_SERVICE_ACCOUNT_JSON to diff both sides.');
  }

  if (report.backfill) {
    const ok = report.backfill.filter((r) => r.ok);
    console.log(`\nbackfill: ${ok.length}/${report.backfill.length} accepted, ${money(ok.reduce((a, r) => a + r.amount, 0))} reported with the current timestamp`);
    for (const r of report.backfill.filter((x) => !x.ok)) console.log(`  ${r.bookingNumber} failed: ${r.reason}`);
  }

  for (const e of report.errors) console.log(`\n! ${e}`);
}

main()
  .catch((err) => {
    console.error(`reconcile failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
