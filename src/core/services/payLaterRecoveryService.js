/**
 * Automatic pay-later recovery.
 *
 * A failed deferred charge leaves the customer needing a hosted payment page.
 * This sweep sends the FIRST direct-link email, and after that link expires it
 * may send exactly ONE replacement in the same episode. Never more.
 *
 * Stop conditions are persisted facts, not scheduler memory:
 *   - a supplier sent/regenerated a link (episode closed by the attempt service)
 *   - payment settled
 *   - the booking terminalized
 *   - the activity is too close for a safe Stripe session
 *   - two automatic emails were already sent
 *
 * Supplier notifications are separate from the customer email: a customer who
 * never receives the email must not hide a real action-needed booking from the
 * supplier, and a notification retry must not resend the customer email.
 */

const prisma = require('./prismaClient');
const { enqueueNotification } = require('./queue');
const { logActivity } = require('./auditLogger');
const logger = require('./logger');
const {
  FLAGS,
  flagEnabled,
  paymentLinkDeadlineFor,
  sendAutomaticRecoveryLink,
  reapStalePaymentAttempts,
  reapStalePaymentLinkSends,
} = require('./paymentLinkService');

const MAX_AUTOMATIC_EMAILS = 2;
const MIN_SESSION_MS = 30 * 60 * 1000;
const LIMIT = 100;

const ACTIVE_ATTEMPT_STATUSES = ['CREATING', 'ACTIVE'];

function supplierNotification(booking, { type, title, message, dedupeKey, data = {} }) {
  if (!booking.tour?.supplierId) return Promise.resolve();
  return enqueueNotification({
    userId: booking.tour.supplierId,
    type,
    title,
    message,
    data: { bookingId: booking.id, ...data },
    dedupeKey,
  }).catch(() => {});
}

async function closeEpisode(booking, reason) {
  const now = new Date();
  const closed = await prisma.booking.updateMany({
    where: { id: booking.id, recoveryClosedAt: null },
    data: { recoveryClosedAt: now, recoveryClosedReason: reason },
  }).catch(() => ({ count: 0 }));
  return closed.count > 0;
}

async function notifyLimitReached(booking) {
  const episodeKey = booking.recoveryEpisodeKey || `${booking.id}:${Date.now()}`;
  await supplierNotification(booking, {
    type: 'PAYMENT_ACTION_REQUIRED',
    title: 'Payment link recovery finished',
    message: 'Two automatic payment-link attempts have been used and payment is still unconfirmed. Resend a link or contact the customer before the activity.',
    dedupeKey: `booking:${booking.id}:recovery:${episodeKey}:limit`,
    data: { reasonCode: 'RECOVERY_LIMIT_REACHED' },
  });
}

async function notifyEmailFailure(booking, send) {
  await supplierNotification(booking, {
    type: 'PAYMENT_ACTION_REQUIRED',
    title: 'Payment link email could not be sent',
    message: 'The secure payment link could not be emailed. Resend it from the booking or check the customer email address.',
    dedupeKey: `booking:${booking.id}:payment-link-send:${send.id}:failed`,
    data: { reasonCode: 'PAYMENT_LINK_EMAIL_FAILED' },
  });
}

async function loadCandidates() {
  return prisma.booking.findMany({
    where: {
      paymentTiming: 'later',
      paymentStatus: 'PENDING',
      status: { in: ['PENDING', 'CONFIRMED'] },
      paidAt: null,
      recoveryClosedAt: null,
      // Only an escalated, manual-payment booking gets automatic recovery. A
      // transient decline with a scheduled retry must finish its retry ladder
      // first; sending a link then would pause the sweep and split collection
      // across two mechanisms.
      requiresPaymentActionAt: { not: null },
      nextRetryAt: null,
    },
    include: {
      tour: { select: { id: true, title: true, supplierId: true, bookingAndTickets: true } },
      customer: { select: { id: true, email: true } },
      guest: { select: { id: true, email: true } },
    },
    orderBy: { travelDate: 'asc' },
    take: LIMIT,
  });
}

async function automaticEmailCountsFor(bookings) {
  const ids = bookings.map((b) => b.id);
  if (ids.length === 0) return new Map();
  const sends = await prisma.bookingPaymentLinkSend.findMany({
    where: {
      bookingId: { in: ids },
      channel: 'EMAIL',
      // A failed provider send is still one of the two automatic attempts for
      // the episode. Counting only successes would retry forever on a bad
      // address and could queue a burst of duplicate messages.
      status: { in: ['QUEUED', 'SENT', 'FAILED'] },
      attempt: { source: 'AUTO_RECOVERY' },
    },
    select: { bookingId: true, status: true, createdAt: true },
  });
  const map = new Map();
  for (const send of sends) {
    const booking = bookings.find((b) => b.id === send.bookingId);
    if (!booking) continue;
    if (booking.recoveryEpisodeStartedAt && send.createdAt < booking.recoveryEpisodeStartedAt) continue;
    map.set(send.bookingId, (map.get(send.bookingId) || 0) + 1);
  }
  return map;
}

async function liveAttemptsFor(ids) {
  if (ids.length === 0) return new Map();
  const rows = await prisma.bookingPaymentAttempt.findMany({
    where: { bookingId: { in: ids }, status: { in: ACTIVE_ATTEMPT_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, bookingId: true, source: true, status: true, expiresAt: true, createdAt: true },
  });
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.bookingId)) map.set(row.bookingId, row);
  }
  return map;
}

/**
 * Run one recovery pass. Returns counters for the scheduler log.
 */
async function runPayLaterRecoverySweep() {
  if (!(await flagEnabled(FLAGS.recovery))) {
    return { enabled: false, checked: 0, sent: 0, closed: 0, failed: 0 };
  }

  await reapStalePaymentAttempts({ limit: 200 }).catch((err) => {
    logger.warn(`[PayLaterRecovery] attempt reaper failed: ${err.message}`);
  });
  await reapStalePaymentLinkSends({ limit: 200 }).catch((err) => {
    logger.warn(`[PayLaterRecovery] stale-send reaper failed: ${err.message}`);
  });

  const now = new Date();
  const candidates = await loadCandidates();
  const live = await liveAttemptsFor(candidates.map((b) => b.id));
  const automaticCounts = await automaticEmailCountsFor(candidates);

  // The send rows are the source of truth for the two-email cap. A crashed
  // process must not leave the counter stuck at 0 (which would send extra
  // emails) or at 2 (which would silently strand an episode).
  for (const booking of candidates) {
    const count = automaticCounts.get(booking.id) || 0;
    if (booking.recoveryEmailCount !== count) {
      await prisma.booking.updateMany({
        where: { id: booking.id },
        data: { recoveryEmailCount: count },
      }).catch(() => {});
      booking.recoveryEmailCount = count;
    }
  }

  let sent = 0;
  let closed = 0;
  let failed = 0;

  for (const booking of candidates) {
    try {
      const deadlineAt = paymentLinkDeadlineFor(booking);
      const active = live.get(booking.id) || null;

      // The session must still have Stripe's 30-minute floor. If not, no new
      // link can be issued; close the episode and tell the supplier.
      if (!deadlineAt || deadlineAt.getTime() - now.getTime() < MIN_SESSION_MS) {
        const wasOpen = await closeEpisode(booking, 'PAYMENT_WINDOW_CLOSED');
        if (wasOpen) {
          closed += 1;
          await supplierNotification(booking, {
            type: 'PAYMENT_ACTION_REQUIRED',
            title: 'Payment window closed',
            message: 'There is no longer enough time to send a secure payment link before the activity. Contact the customer or support now.',
            dedupeKey: `booking:${booking.id}:recovery:${booking.recoveryEpisodeKey || 'episode'}:window-closed`,
            data: { reasonCode: 'PAYMENT_LINK_WINDOW_CLOSED' },
          });
        }
        continue;
      }

      // An active link already covers this episode. The first email may still
      // need sending if the attempt was created by a customer Pay now action.
      if (active && booking.recoveryEmailCount >= 1) {
        continue;
      }

      // If no active link and the allowance is used, recovery is over. This is
      // a real supplier action, not a silent state.
      if (!active && booking.recoveryEmailCount >= MAX_AUTOMATIC_EMAILS) {
        const wasOpen = await closeEpisode(booking, 'RECOVERY_LIMIT_REACHED');
        if (wasOpen) {
          closed += 1;
          await notifyLimitReached(booking);
        }
        continue;
      }

      const result = await sendAutomaticRecoveryLink({
        bookingId: booking.id,
        reasonCode: booking.paymentFailureCode || 'PAYMENT_ACTION_REQUIRED',
        idempotencyKey: `recovery:${booking.recoveryEpisodeKey || booking.id}:${booking.recoveryEmailCount + 1}`,
      });

      if (result.emailStatus === 'FAILED') {
        failed += 1;
        await notifyEmailFailure(booking, result.emailSend);
        await logActivity({
          userId: null,
          action: 'booking.payment_link_recovery_failed',
          resource: 'Booking',
          resourceId: booking.id,
          metadata: { reason: 'EMAIL_FAILED', source: 'system' },
        }).catch(() => {});
      } else if (result.delivered) {
        sent += 1;
        await logActivity({
          userId: null,
          action: 'booking.payment_link_recovery_sent',
          resource: 'Booking',
          resourceId: booking.id,
          metadata: {
            emailCount: result.recovery?.recoveryEmailCount ?? null,
            source: 'system',
          },
        }).catch(() => {});
      }

      // If this was the second and final email and the link has already
      // expired by the next run, the next pass closes the episode. Do not close
      // now: the customer still has the full session lifetime to pay.
    } catch (err) {
      failed += 1;
      logger.warn(`[PayLaterRecovery] Booking ${booking.id} recovery failed: ${err.message}`);
      await logActivity({
        userId: null,
        action: 'booking.payment_link_recovery_failed',
        resource: 'Booking',
        resourceId: booking.id,
        metadata: { reason: err.errorCode || 'RECOVERY_ERROR', source: 'system' },
      }).catch(() => {});
    }
  }

  // Delivery records that the provider rejected are a real supplier action.
  // Notify with a per-send dedupe key so queue retries cannot spam the inbox.
  const failedSends = await prisma.bookingPaymentLinkSend.findMany({
    where: { channel: 'EMAIL', status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      booking: {
        select: {
          id: true,
          recoveryEpisodeKey: true,
          tour: { select: { id: true, title: true, supplierId: true } },
        },
      },
    },
  });
  for (const send of failedSends) {
    if (!send.booking) continue;
    await notifyEmailFailure(send.booking, send);
  }

  const summary = { enabled: true, checked: candidates.length, sent, closed, failed };
  console.log(
    `[PayLaterRecovery] ${candidates.length} candidate(s) → ${sent} email(s), ${closed} closed, ${failed} failed`,
  );
  return summary;
}

module.exports = {
  runPayLaterRecoverySweep,
  MAX_AUTOMATIC_EMAILS,
};
