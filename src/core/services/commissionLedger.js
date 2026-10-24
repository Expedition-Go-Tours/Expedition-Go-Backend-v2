/**
 * Commission on money a supplier collected OFFLINE.
 *
 * ── The invariant ──────────────────────────────────────────────────────
 *
 *   for every supplier-created booking
 *     sum(NON-REVERSED SUPPLIER_COMMISSION charges)
 *       == round(rate × sum(RECORDED BookingCollection.amount)) ± 1¢/row
 *
 * Commission follows money actually collected, never the booking value: an
 * unpaid reservation raises nothing, a later collection raises its share, and
 * a refund returns the commission on the refunded money. There is no separate
 * settlement ledger — a charge is the same OPEN `SupplierCharge` the
 * cancellation fee uses, so both settle through the machinery finance already
 * runs (payout requests and invoices).
 *
 * ── No credit ──────────────────────────────────────────────────────────
 *
 * Commission is a receivable: the platform never touched the cash. Rather
 * than let one accrue, a collection is only accepted when the supplier's
 * AVAILABLE BALANCE covers the commission it raises:
 *
 *     available = eligible unpaid earnings − OPEN platform charges
 *
 * Both sides come from existing predicates — `eligibleBookingsWhere` (the
 * same clause that decides what gets paid) and every OPEN charge — so a
 * supplier cannot create a receivable by reporting money the platform is not
 * already holding on their behalf. The gate is re-checked inside the
 * transaction on every money event, under a per-supplier lock, so two
 * concurrent collections cannot both claim the same balance.
 *
 * ── Rate freeze ────────────────────────────────────────────────────────
 *
 * `Booking.commissionRate` + `Booking.commissionPolicy` are written at
 * creation and never re-read from config afterwards. Changing the global rate
 * must not retroactively reprice a booking the supplier already quoted a
 * customer for, and one rate per booking is what makes the invariant above
 * checkable. `policyFor` only falls back to config for rows created before
 * this column existed.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const getConfig = require('./getConfig');
const { eligibleBookingsWhere } = require('./financeHelpers');
const { logActivity } = require('./auditLogger');

const REASON = 'SUPPLIER_COMMISSION';

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toNumber(v) {
  return v == null ? 0 : Number(v);
}

/**
 * The configured policy. `APPLY` charges the frozen rate on money collected;
 * `WAIVE` is a deliberate, auditable waiver. Read only for bookings that predate
 * the `commissionPolicy` column.
 */
async function configuredPolicy() {
  const raw = String(await getConfig('feature.supplierCreatedCommissionPolicy', 'APPLY')).toUpperCase();
  return raw === 'WAIVE' ? 'WAIVE' : 'APPLY';
}

/** The policy this booking was struck under. */
async function policyFor(booking) {
  if (booking && booking.commissionPolicy) {
    return booking.commissionPolicy === 'WAIVE' ? 'WAIVE' : 'APPLY';
  }
  return configuredPolicy();
}

/**
 * Commission owed on `amount` of money for `booking`, using its frozen rate.
 * Signed: a negative amount (a refund) yields a credit. Zero when waived or
 * when the rate is zero, so a WAIVE booking can never raise a charge by
 * accident.
 */
function commissionFor(booking, amount, policy) {
  if (policy === 'WAIVE') return 0;
  const rate = toNumber(booking?.commissionRate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return round2(rate * toNumber(amount));
}

// ── Available balance ──────────────────────────────────────────────────

/**
 * How much of the supplier's money the platform is currently holding, per
 * currency: what is genuinely payable now, minus everything the supplier
 * already owes.
 *
 * Only ELIGIBLE bookings count — still-clearing (PENDING) money is not yet
 * the supplier's to spend, and money already committed to an unpaid invoice
 * is already spoken for. `eligibleBookingsWhere` is the same predicate the
 * payout path pays from, so "available" here cannot disagree with what a
 * payout would actually pay.
 *
 * @returns {Promise<object>} map of currency → { available, eligible, openCharges }
 */
async function coverBalance(supplierId, tx = prisma) {
  const [earnings, charges] = await Promise.all([
    tx.booking.groupBy({
      by: ['currency'],
      where: eligibleBookingsWhere(supplierId),
      _sum: { supplierPayout: true },
    }),
    tx.supplierCharge.groupBy({
      by: ['currency'],
      where: { supplierId, status: 'OPEN' },
      _sum: { amount: true },
    }),
  ]);

  const byCurrency = {};
  const put = (currency, key, value) => {
    const c = currency || 'USD';
    byCurrency[c] = byCurrency[c] || { available: 0, eligible: 0, openCharges: 0 };
    byCurrency[c][key] = round2((byCurrency[c][key] || 0) + value);
  };
  for (const row of earnings) put(row.currency, 'eligible', toNumber(row._sum.supplierPayout));
  for (const row of charges) put(row.currency, 'openCharges', toNumber(row._sum.amount));
  for (const c of Object.keys(byCurrency)) {
    byCurrency[c].available = round2(byCurrency[c].eligible - byCurrency[c].openCharges);
  }
  return byCurrency;
}

/**
 * Refuse the money event when the supplier's available balance cannot cover
 * the commission it raises. This is the whole of "no credit" — the button and
 * the quote only ever preview this same check.
 *
 * @param {object} opts
 * @param {object} opts.tx        transaction client (locked supplier row)
 * @param {string} opts.supplierId
 * @param {string} opts.currency
 * @param {number} opts.required  commission this event would raise
 * @param {string} [opts.verb]    "create this booking" | "record this collection"
 */
async function assertCover({ tx, supplierId, currency, required, verb = 'record this collection' }) {
  if (!(required > 0)) return; // waived / zero rate / a refund
  const balance = await coverBalance(supplierId, tx);
  const line = balance[currency || 'USD'] || { available: 0 };
  const available = line.available;
  if (available + 0.005 >= required) return;
  throw new AppError(
    available <= 0.005
      ? `You have no available earnings in ${currency} to cover the commission on this booking. `
        + `Settle your balance or wait for an eligible payout before you can ${verb}.`
      : `You have ${available.toFixed(2)} ${currency} available but this needs ${required.toFixed(2)} `
        + `${currency} to cover commission. Settle your balance first.`,
    409,
  );
}

// ── Raising ────────────────────────────────────────────────────────────

/**
 * Raise the commission a single collection owes. One charge per collection
 * row, enforced by `SupplierCharge.collectionId @unique` — a replayed
 * collection cannot double-charge, and the database, not this code, is what
 * guarantees it.
 *
 * @returns {Promise<object|null>} the charge, or null when nothing is owed
 */
async function raiseCollectionCommission(tx, { booking, collection, supplierId, actorId }) {
  const policy = await policyFor(booking);
  const amount = commissionFor(booking, collection.amount, policy);
  if (!amount) return null;

  const existing = await tx.supplierCharge.findUnique({ where: { collectionId: collection.id } });
  if (existing) return existing;

  const charge = await tx.supplierCharge.create({
    data: {
      supplierId,
      bookingId: booking.id,
      collectionId: collection.id,
      amount,
      currency: collection.currency || booking.currency || 'USD',
      reason: REASON,
      status: 'OPEN',
      notes: `Commission on offline collection (${collection.method}) at ${(toNumber(booking.commissionRate) * 100).toFixed(2)}%`,
    },
  });

  await logActivity({
    userId: actorId,
    action: 'booking.commission_raised',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: {
      collectionId: collection.id,
      chargeId: charge.id,
      amount,
      currency: charge.currency,
      rate: toNumber(booking.commissionRate),
      policy,
    },
  }).catch(() => {});

  return charge;
}

/**
 * Take back the commission on a collection that is being corrected.
 *
 * If the charge has not settled, it is voided in place (`REVERSED`) — no
 * second row, no double count. If it HAS settled, the supplier already paid
 * it, so a paid document is never mutated: a compensating credit is written
 * against the original and lands on the next settlement.
 */
async function reverseCollectionCommission(tx, { booking, originalCollection, actorId }) {
  const charge = await tx.supplierCharge.findUnique({
    where: { collectionId: originalCollection.id },
  });
  if (!charge) return null;
  if (['REVERSED', 'WAIVED'].includes(charge.status)) return null; // already taken back, or never charged

  const settledOrReserved = charge.status === 'SETTLED' || Boolean(charge.invoiceId) || Boolean(charge.payoutRequestId);

  if (!settledOrReserved) {
    const reversed = await tx.supplierCharge.update({
      where: { id: charge.id },
      data: { status: 'REVERSED', notes: `${charge.notes || ''} · reversed by a corrected collection`.trim() },
    });
    await logActivity({
      userId: actorId,
      action: 'booking.commission_reversed',
      resource: 'Booking',
      resourceId: booking.id,
      metadata: { chargeId: charge.id, amount: toNumber(charge.amount), mode: 'voided' },
    }).catch(() => {});
    return reversed;
  }

  const existingCredit = await tx.supplierCharge.findUnique({ where: { reversalOfId: charge.id } });
  if (existingCredit) return existingCredit;

  const credit = await tx.supplierCharge.create({
    data: {
      supplierId: charge.supplierId,
      bookingId: charge.bookingId,
      // NOT `collectionId`: the original charge already owns that unique slot.
      // `reversalOfId` is the link, and it is unique too.
      reversalOfId: charge.id,
      amount: -toNumber(charge.amount),
      currency: charge.currency,
      reason: REASON,
      status: 'OPEN',
      notes: `Credit: commission reversed on a corrected collection (original ${toNumber(charge.amount).toFixed(2)} ${charge.currency})`,
    },
  });
  await logActivity({
    userId: actorId,
    action: 'booking.commission_reversed',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { chargeId: credit.id, originalChargeId: credit.id, amount: toNumber(credit.amount), mode: 'credit' },
  }).catch(() => {});
  return credit;
}

/**
 * A booking refunded to zero owns no commission. Rather than reverse each
 * charge by its own rounded amount — which can leave a one-cent residue after
 * several collections — every non-reversed charge on the booking is voided
 * (or credited, if already settled) so the booking lands on exactly zero.
 */
async function zeroBookingCommission(tx, { booking, actorId }) {
  const charges = await tx.supplierCharge.findMany({
    where: { bookingId: booking.id, reason: REASON, status: { in: ['OPEN', 'SETTLED'] } },
  });
  const results = [];
  for (const charge of charges) {
    const settledOrReserved = charge.status === 'SETTLED' || Boolean(charge.invoiceId) || Boolean(charge.payoutRequestId);
    if (!settledOrReserved) {
      await tx.supplierCharge.update({ where: { id: charge.id }, data: { status: 'REVERSED', notes: `${charge.notes || ''} · refunded to zero`.trim() } });
      results.push({ chargeId: charge.id, amount: 0 });
    } else if (!(await tx.supplierCharge.findUnique({ where: { reversalOfId: charge.id } }))) {
      const credit = await tx.supplierCharge.create({
        data: {
          supplierId: charge.supplierId,
          bookingId: charge.bookingId,
          reversalOfId: charge.id,
          amount: -toNumber(charge.amount),
          currency: charge.currency,
          reason: REASON,
          status: 'OPEN',
          notes: `Credit: booking refunded to zero (original ${toNumber(charge.amount).toFixed(2)} ${charge.currency})`,
        },
      });
      results.push({ chargeId: credit.id, amount: toNumber(credit.amount) });
    }
  }
  if (results.length > 0) {
    await logActivity({
      userId: actorId,
      action: 'booking.commission_zeroed',
      resource: 'Booking',
      resourceId: booking.id,
      metadata: { charges: results.length },
    }).catch(() => {});
  }
  return results;
}

/** The booking's own commission ledger, for the detail view and tests. */
async function bookingCommission(bookingId, tx = prisma) {
  const [booking, charges] = await Promise.all([
    tx.booking.findUnique({ where: { id: bookingId }, select: { commissionRate: true, commissionPolicy: true } }),
    tx.supplierCharge.findMany({ where: { bookingId, reason: REASON }, orderBy: { createdAt: 'asc' } }),
  ]);
  const live = charges.filter((c) => c.status !== 'REVERSED');
  const net = round2(live.reduce((s, c) => s + toNumber(c.amount), 0));
  return {
    rate: toNumber(booking?.commissionRate),
    policy: booking?.commissionPolicy || null,
    accrued: Math.abs(net) < 0.005 ? 0 : net,
    settled: round2(live.filter((c) => c.status === 'SETTLED').reduce((s, c) => s + toNumber(c.amount), 0)),
    open: round2(live.filter((c) => c.status === 'OPEN').reduce((s, c) => s + toNumber(c.amount), 0)),
    charges: charges.map((c) => ({
      id: c.id,
      amount: toNumber(c.amount),
      currency: c.currency,
      status: c.status,
      collectionId: c.collectionId,
      reversalOfId: c.reversalOfId,
      invoiceId: c.invoiceId,
      payoutRequestId: c.payoutRequestId,
      settledAt: c.settledAt,
      createdAt: c.createdAt,
    })),
  };
}

// ── Settlement ─────────────────────────────────────────────────────────

/**
 * Choose which open charges an invoice can carry, and reserve them against it.
 *
 * Credits apply in full (they raise the payout — the platform owes the
 * supplier). Positive charges are applied oldest-first and stop at the first
 * one that does not fit, so an invoice can never go negative and the remainder
 * simply carries to the next cycle. Charges already reserved by another unpaid
 * invoice or payout request are invisible here, so two invoices cannot both
 * claim the same money.
 *
 * The charges stay OPEN — an unpaid invoice is a reservation, not a payment.
 * `markInvoicePaid` settles them; a cancelled invoice releases them.
 *
 * @returns {Promise<{chargesTotal: number, netTotal: number, applied: object[]}>}
 */
async function applyChargesToInvoice(tx, { supplierId, currency, payments, invoiceId }) {
  const candidates = await tx.supplierCharge.findMany({
    where: { supplierId, currency, status: 'OPEN', invoiceId: null, payoutRequestId: null },
    orderBy: { createdAt: 'asc' },
  });

  const credits = candidates.filter((c) => toNumber(c.amount) < 0);
  const debits = candidates.filter((c) => toNumber(c.amount) > 0);

  let remaining = toNumber(payments);
  const applied = [];
  for (const charge of credits) {
    applied.push(charge);
    remaining = round2(remaining - toNumber(charge.amount));
  }
  for (const charge of debits) {
    const amount = toNumber(charge.amount);
    if (amount > remaining + 0.005) break;
    applied.push(charge);
    remaining = round2(remaining - amount);
  }

  if (applied.length > 0) {
    await tx.supplierCharge.updateMany({
      where: { id: { in: applied.map((c) => c.id) } },
      data: { invoiceId },
    });
  }

  const chargesTotal = round2(applied.reduce((s, c) => s + toNumber(c.amount), 0));
  return { chargesTotal, netTotal: round2(toNumber(payments) - chargesTotal), applied };
}

module.exports = {
  REASON,
  round2,
  toNumber,
  configuredPolicy,
  policyFor,
  commissionFor,
  coverBalance,
  assertCover,
  raiseCollectionCommission,
  reverseCollectionCommission,
  zeroBookingCommission,
  bookingCommission,
  applyChargesToInvoice,
};
