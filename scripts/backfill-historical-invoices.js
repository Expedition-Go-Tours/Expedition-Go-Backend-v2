/**
 * Backfill historical invoices for suppliers who were PAID before finance v3
 * invoicing existed.
 *
 * Finance v3 (automatic invoicing) only ever touches ELIGIBLE money: the hourly
 * `generateDueInvoices` sweep picks up bookings whose payoutStatus is ELIGIBLE
 * and raises an Invoice for them. But suppliers paid out under the legacy v2
 * flow have bookings sitting at payoutStatus = PAID — funds already released,
 * ledger rows already written — with no Invoice backing them. Their Invoices
 * tab (and any per-window finance report) is therefore empty for every payout
 * that predates the invoicing launch.
 *
 * This script reconstructs those missing invoices: for every booking that is
 * already PAID but has never been claimed by an InvoiceItem, it groups the
 * bookings by (supplier, invoice window, currency) and creates the Invoice that
 * *should* have existed, written directly in its final PAID state.
 *
 * Safety guarantees:
 *   - Only payoutStatus = 'PAID' bookings are considered. ELIGIBLE / INVOICED /
 *     REQUESTED / DISPUTED / CANCELLED money is never touched, so this can not
 *     double-pay or re-invoice anything still in flight.
 *   - `invoiceItems: { none: {} }` + the InvoiceItem.bookingId @unique index mean
 *     a booking can never be claimed twice, even across concurrent runs.
 *   - runKey uses the SAME key as the scheduler (`invoiceRunKey`), so a window +
 *     currency that already has an invoice collides on the unique index and is
 *     skipped instead of duplicated. (These bookings are PAID, not ELIGIBLE, so
 *     the scheduler would never pick them up — the key is belt-and-braces.)
 *   - Nothing existing is mutated: this only INSERTs invoices + line items.
 *
 * The invoices are created straight in PAID state (approvedAt/paidAt set to the
 * window's scheduled payment date) because the money has already moved — there
 * is nothing left to approve or pay. `reference` is stamped `BACKFILL-…` so
 * finance can tell reconstructed rows apart from real bank references.
 *
 * Usage:
 *   node scripts/backfill-historical-invoices.js --dry-run          # report only
 *   node scripts/backfill-historical-invoices.js                    # apply (all suppliers)
 *   node scripts/backfill-historical-invoices.js --supplierId=<id>  # one supplier
 *   node scripts/backfill-historical-invoices.js --since=2025-01-01 # travelDate floor
 *   node scripts/backfill-historical-invoices.js --cycle=MONTHLY    # fallback cadence
 *
 * No --all flag: every supplier with PAID-but-uninvoiced bookings is in scope
 * by default; use --supplierId to narrow to one.
 */
const prisma = require('../src/core/services/prismaClient');
const { invoiceWindowFor } = require('../src/core/services/payoutCycles');
const {
  invoiceRunKey,
  nextInvoiceNumber,
} = require('../src/core/services/invoiceService');
const { resolvePayoutMethod, getDefaultCycle, VALID_CYCLES } = require('../src/core/services/payoutRuns');
const { PAYABLE_BOOKING_STATUSES } = require('../src/core/services/financeHelpers');

const DRY_RUN = process.argv.includes('--dry-run');
const supplierArg = (process.argv.find((a) => a.startsWith('--supplierId=')) || '').split('=')[1];
const sinceArg = (process.argv.find((a) => a.startsWith('--since=')) || '').split('=')[1];
const cycleArg = (process.argv.find((a) => a.startsWith('--cycle=')) || '').split('=')[1];

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function main() {
  const fallbackCycle = cycleArg ? String(cycleArg).toUpperCase() : await getDefaultCycle();
  if (!VALID_CYCLES.includes(fallbackCycle)) {
    console.error(`Invalid --cycle "${cycleArg}". Expected one of ${VALID_CYCLES.join(', ')}`);
    process.exit(1);
  }

  const sinceDate = sinceArg ? new Date(`${sinceArg}T00:00:00Z`) : null;
  if (sinceArg && Number.isNaN(sinceDate.getTime())) {
    console.error(`Invalid --since "${sinceArg}". Use YYYY-MM-DD.`);
    process.exit(1);
  }

  // Every booking that was paid out but never invoiced.
  const where = {
    payoutStatus: 'PAID',
    isSimulated: false,
    paymentStatus: 'SUCCEEDED',
    status: { in: [...PAYABLE_BOOKING_STATUSES] },
    invoiceItems: { none: {} },
    ...(sinceDate ? { travelDate: { gte: sinceDate } } : {}),
    ...(supplierArg ? { tour: { supplierId: supplierArg } } : {}),
  };

  const bookings = await prisma.booking.findMany({
    where,
    select: {
      id: true,
      bookingNumber: true,
      travelDate: true,
      currency: true,
      grossAmount: true,
      platformCommission: true,
      supplierPayout: true,
      tour: { select: { supplierId: true } },
    },
    orderBy: [{ travelDate: 'asc' }, { createdAt: 'asc' }],
  });

  console.log(
    `Historical invoice backfill ${DRY_RUN ? '(DRY RUN — no writes)' : ''}\n` +
      `  PAID bookings with no invoice: ${bookings.length}` +
      `${sinceDate ? ` (travelDate >= ${sinceArg})` : ''}` +
      `${supplierArg ? ` (supplier ${supplierArg})` : ''}`
  );

  if (bookings.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Group by supplier → (runKey = supplier + window + currency).
  const bySupplier = new Map();
  for (const b of bookings) {
    const supplierId = b.tour?.supplierId;
    if (!supplierId) continue;

    // The cadence decides the window boundaries; suppliers not yet enrolled on
    // a schedule fall back to the platform default so their history still maps
    // onto sensible windows.
    const profile = await prisma.supplierProfile.findUnique({
      where: { userId: supplierId },
      select: { payoutCycle: true },
    });
    const cycle = (profile && profile.payoutCycle) || fallbackCycle;

    const window = invoiceWindowFor(b.travelDate, cycle);
    if (!window) continue;

    const currency = b.currency || 'USD';
    const key = invoiceRunKey(supplierId, window, currency);

    if (!bySupplier.has(supplierId)) bySupplier.set(supplierId, new Map());
    const groups = bySupplier.get(supplierId);
    if (!groups.has(key)) groups.set(key, { supplierId, cycle, window, currency, items: [] });
    groups.get(key).items.push(b);
  }

  let totalInvoices = 0;
  let totalBookings = 0;
  let totalNet = 0;
  const report = { created: 0, skippedExisting: 0, errors: 0 };

  for (const [supplierId, groups] of bySupplier) {
    const supplier = await prisma.user.findUnique({
      where: { id: supplierId },
      select: { email: true, name: true },
    });
    console.log(`\n• ${supplier?.email || supplierId} — ${groups.size} window(s)`);

    const method = await resolvePayoutMethod({ supplierId });

    for (const [key, group] of groups) {
      const grossTotal = round2(group.items.reduce((s, b) => s + toNumber(b.grossAmount), 0));
      const commissionTotal = round2(group.items.reduce((s, b) => s + toNumber(b.platformCommission), 0));
      const netTotal = round2(group.items.reduce((s, b) => s + toNumber(b.supplierPayout), 0));
      const label = group.window.label || 'unknown window';

      // Belt-and-braces: if an invoice already exists for this window+currency,
      // never create a second one.
      const existing = await prisma.invoice.findUnique({
        where: { runKey: key },
        select: { id: true, invoiceNumber: true, status: true },
      });
      if (existing) {
        report.skippedExisting += 1;
        console.log(`   ↷ ${label} — already invoiced (${existing.invoiceNumber}, ${existing.status})`);
        continue;
      }

      console.log(
        `   ${DRY_RUN ? '→ would create' : '+ creating'} ${label}` +
          ` · ${group.items.length} booking(s) · ${group.currency} ${netTotal.toFixed(2)} net` +
          `${method ? '' : ' · (no payout method on file)'}`
      );

      if (DRY_RUN) {
        totalInvoices += 1;
        totalBookings += group.items.length;
        totalNet += netTotal;
        continue;
      }

      try {
        const paidOn = group.window.paidOn || group.window.invoicedOn || new Date();
        await prisma.$transaction(async (tx) => {
          const created = await tx.invoice.create({
            data: {
              invoiceNumber: nextInvoiceNumber(paidOn),
              supplierId,
              cycle: group.cycle,
              cycleStartDate: group.window.start,
              cycleEndDate: group.window.end,
              cycleLabel: label,
              invoicedAt: group.window.invoicedOn || paidOn,
              paymentScheduledAt: paidOn,
              approvedAt: paidOn,
              paidAt: paidOn,
              status: 'PAID',
              reference: `BACKFILL-${paidOn.toISOString().slice(0, 10)}`,
              grossTotal,
              commissionTotal,
              netTotal,
              currency: group.currency,
              bookingCount: group.items.length,
              payoutMethodId: method ? method.id : null,
              runKey: key,
              items: {
                create: group.items.map((b) => ({
                  bookingId: b.id,
                  grossAmount: toNumber(b.grossAmount),
                  platformCommission: toNumber(b.platformCommission),
                  supplierPayout: toNumber(b.supplierPayout),
                  currency: b.currency || 'USD',
                })),
              },
            },
          });
          return created;
        });

        report.created += 1;
        totalInvoices += 1;
        totalBookings += group.items.length;
        totalNet += netTotal;
      } catch (err) {
        if (String(err?.code) === 'P2002') {
          report.skippedExisting += 1;
          console.log(`   ↷ ${label} — concurrent run already invoiced it`);
        } else {
          report.errors += 1;
          console.error(`   ✗ ${label} — ${err.message}`);
        }
      }
    }
  }

  console.log(
    `\n${DRY_RUN ? 'Would create' : 'Created'} ${totalInvoices} invoice(s) covering ` +
      `${totalBookings} booking(s) · net ${round2(totalNet).toFixed(2)} (mixed currencies).` +
      `\n  skipped (already invoiced): ${report.skippedExisting}` +
      `${report.errors ? `  errors: ${report.errors}` : ''}`
  );

  if (DRY_RUN) {
    console.log('\nRe-run without --dry-run to apply.');
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
