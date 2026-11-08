/**
 * Verified claim of guest bookings.
 *
 * A guest checked out with only an email. Once that address is verified, the
 * same person can attach those bookings to their account. The rules that make
 * this safe:
 *
 *   - only an account with `emailVerified` may claim;
 *   - only `MARKETPLACE` guest bookings (`customerId: null`) are candidates,
 *     so supplier-entered walk-ins never move without the supplier;
 *   - the match is the verified account email against the booking's guest
 *     contact or lead traveller email;
 *   - the update re-checks `customerId: null`, so two tabs (or two requests)
 *     cannot move the same booking twice;
 *   - the old GuestAccess tokens are revoked once the booking belongs to an
 *     account.
 */
const prisma = require('./prismaClient');
const AppError = require('./appError');
const cache = require('./cacheHelper');
const { revokeGuestAccess } = require('./guestAccess');
const { logActivity } = require('./auditLogger');
const { enqueueEvent } = require('./queue');

const PREVIEW_LIMIT = 20;
const CLAIM_LIMIT = 100;
// The prompt is mounted at the app root, so "shown" is not one event per
// login — without a brake it would be one per page load. One per account per
// day is enough to measure the funnel.
const PROMPT_EVENT_TTL = 24 * 60 * 60;

function accountEmail(user) {
  return String(user?.email || '').trim();
}

function claimableWhere(email) {
  return {
    customerId: null,
    origin: 'MARKETPLACE',
    OR: [
      { guest: { email: { equals: email, mode: 'insensitive' } } },
      { leadTravelerEmail: { equals: email, mode: 'insensitive' } },
    ],
  };
}

/**
 * Emit the "prompt shown" event at most once per account per day. Fire and
 * forget: a metrics failure must never delay or break the preview.
 */
function recordPromptShown(userId) {
  cache
    .getOrSet(`guest-claim:prompted:${userId}`, async () => {
      enqueueEvent({
        name: 'user.guest_claim_prompted',
        userId,
        resource: 'User',
        resourceId: userId,
        properties: { surface: 'app_prompt' },
      }).catch(() => {});
      return true;
    }, PROMPT_EVENT_TTL)
    .catch(() => {});
}

function slim(booking) {
  return {
    id: booking.id,
    bookingNumber: booking.bookingNumber,
    tourTitle: booking.tour?.title || '',
    travelDate: booking.travelDate,
    status: booking.status,
    amount: Number(booking.grossAmount),
    currency: booking.currency || 'USD',
    leadTravelerName: booking.leadTravelerName || booking.guest?.name || '',
  };
}

const SELECT = {
  id: true,
  bookingNumber: true,
  travelDate: true,
  status: true,
  grossAmount: true,
  currency: true,
  leadTravelerName: true,
  tour: { select: { title: true } },
  guest: { select: { name: true } },
};

/**
 * What the account could claim right now. Returns `needsVerification` rather
 * than an error so the UI can offer the verification step.
 *
 * @param {{ id: string, email: string, emailVerified?: boolean }} user
 */
async function listClaimableGuestBookings(user) {
  const email = accountEmail(user);
  if (!user?.emailVerified || !email) {
    return { canClaim: false, needsVerification: true, count: 0, bookings: [] };
  }

  const where = claimableWhere(email);
  const [count, rows] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      orderBy: { travelDate: 'desc' },
      take: PREVIEW_LIMIT,
      select: SELECT,
    }),
  ]);

  if (count > 0) recordPromptShown(user.id);

  return { canClaim: true, needsVerification: false, count, bookings: rows.map(slim) };
}

/**
 * Attach the matching guest bookings to the account.
 *
 * @param {{ id: string, email: string, emailVerified?: boolean }} user
 * @param {string[]} [bookingIds] optional subset; omit to claim every match
 */
async function claimGuestBookings(user, bookingIds = null) {
  if (!user?.emailVerified) {
    throw new AppError('Verify your email before adding past bookings to your account.', 403, {
      code: 'EMAIL_NOT_VERIFIED',
      reasonCode: 'EMAIL_NOT_VERIFIED',
    });
  }

  const email = accountEmail(user);
  if (!email) return { claimed: 0, bookings: [] };

  const where = claimableWhere(email);
  if (Array.isArray(bookingIds)) {
    const ids = [...new Set(bookingIds.filter((id) => typeof id === 'string' && id.trim()))]
      .slice(0, CLAIM_LIMIT);
    if (!ids.length) return { claimed: 0, bookings: [] };
    where.id = { in: ids };
  }

  const candidates = await prisma.booking.findMany({
    where,
    orderBy: { travelDate: 'desc' },
    take: CLAIM_LIMIT,
    select: SELECT,
  });
  if (!candidates.length) return { claimed: 0, bookings: [] };

  const ids = candidates.map((b) => b.id);
  const result = await prisma.booking.updateMany({
    where: { id: { in: ids }, customerId: null },
    data: { customerId: user.id },
  });

  // The account is now the way in. The old email link (and any checkout tab
  // still holding a token) must stop being a second credential.
  for (const id of ids) {
    await revokeGuestAccess({ bookingId: id }).catch(() => {});
  }

  if (result.count > 0) {
    for (const booking of candidates) {
      logActivity({
        userId: user.id,
        action: 'booking.guest_claimed',
        resource: 'Booking',
        resourceId: booking.id,
        metadata: { source: 'verified_email_claim' },
      }).catch(() => {});
    }

    // Two names on purpose: `user.guest_bookings_claimed` is the existing
    // activity feed name, `user.guest_claim_completed` is the funnel event the
    // guest-claim metric reads.
    enqueueEvent({
      name: 'user.guest_bookings_claimed',
      userId: user.id,
      resource: 'User',
      resourceId: user.id,
      properties: { count: result.count },
    }).catch(() => {});
    enqueueEvent({
      name: 'user.guest_claim_completed',
      userId: user.id,
      resource: 'User',
      resourceId: user.id,
      properties: { count: result.count },
    }).catch(() => {});
  }

  return { claimed: result.count, bookings: candidates.map(slim) };
}

/**
 * Record a "Not now". The dismissal itself lives in the client (30 days per
 * account); this only writes the funnel event.
 *
 * @param {{ id: string }} user
 */
function recordClaimDismissed(user) {
  if (!user?.id) return;
  enqueueEvent({
    name: 'user.guest_claim_dismissed',
    userId: user.id,
    resource: 'User',
    resourceId: user.id,
    properties: { surface: 'app_prompt' },
  }).catch(() => {});
}

module.exports = {
  listClaimableGuestBookings,
  claimGuestBookings,
  claimableWhere,
  recordClaimDismissed,
};
