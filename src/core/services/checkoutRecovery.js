/**
 * Abandoned-checkout recovery.
 *
 * The seat hold released in bookingCleanup.expireCheckoutHolds() is the moment
 * a checkout became abandoned. This sweep picks up those released drafts — and
 * only those — and emails the traveller once.
 *
 * Guards, in the order they matter:
 *   1. the flag (FF_CHECKOUT_RECOVERY) must be on, so a deploy never starts
 *      mailing real customers on its own;
 *   2. `abandonedNotifiedAt IS NULL` is the idempotency key — the column is set
 *      BEFORE the send is retried only when the send threw, so a crashed sweep
 *      can at worst re-send a draft it already sent once in the same run, never
 *      a second sweep;
 *   3. a payment handle must exist, so drafts that never reached a payment step
 *      (or were superseded) are not mailed;
 *   4. no booking may exist for the draft — a late webhook that materialised a
 *      booking after the sweep started must not be told it was abandoned.
 *
 * One email, ever. There is no drip.
 */

const { isEnabled } = require('./featureFlags');

const BATCH_LIMIT = 50;
const WINDOW_DAYS = 7;

async function recoverAbandonedCheckouts({ batchLimit = BATCH_LIMIT } = {}) {
  if (!isEnabled('checkoutRecovery')) return { scanned: 0, sent: 0, skipped: 0, disabled: true };

  const prisma = require('./prismaClient');
  const { sendCheckoutRecoveryEmail } = require('./emailService');

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const candidates = await prisma.checkoutDraft.findMany({
    where: {
      status: 'EXPIRED',
      abandonedNotifiedAt: null,
      createdAt: { gte: since },
      // A payment handle means the traveller actually got as far as paying.
      OR: [{ stripeSessionId: { not: null } }, { paypalOrderId: { not: null } }],
      bookingId: null,
    },
    orderBy: { expiresAt: 'asc' },
    take: batchLimit,
    include: {
      customer: { select: { id: true, name: true, email: true } },
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const draft of candidates) {
    // Claim the row first: `abandonedNotifiedAt` is the guard, so a second
    // worker racing this one sees the claim and skips instead of sending.
    const claimed = await prisma.checkoutDraft.updateMany({
      where: { id: draft.id, abandonedNotifiedAt: null },
      data: { abandonedNotifiedAt: new Date() },
    });
    if (claimed.count === 0) {
      skipped += 1;
      continue;
    }

    // Re-read the row's booking link: the webhook may have landed between the
    // claim and the send. A late booking must never get recovery mail.
    const settled = await prisma.checkoutDraft.findUnique({
      where: { id: draft.id },
      select: { bookingId: true, status: true },
    });
    if (settled?.bookingId || settled?.status === 'PAID') {
      skipped += 1;
      continue;
    }

    const to = draft.guestEmail || draft.customer?.email;
    if (!to) {
      skipped += 1;
      continue;
    }

    try {
      await sendCheckoutRecoveryEmail(draft);
      sent += 1;
      console.log(`[CheckoutRecovery] sent for draft ${draft.id} → ${to}`);
    } catch (err) {
      // The claim stays set: a send that failed for a permanent reason
      // (hard bounce, missing tour) must not be retried forever.
      skipped += 1;
      console.error(`[CheckoutRecovery] send failed for draft ${draft.id}:`, err.message);
    }
  }

  return { scanned: candidates.length, sent, skipped };
}

module.exports = { recoverAbandonedCheckouts, BATCH_LIMIT, WINDOW_DAYS };
