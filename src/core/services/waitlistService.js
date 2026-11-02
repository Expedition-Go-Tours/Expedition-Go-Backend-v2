/**
 * Sold-out waitlist.
 *
 * A traveller joins from the storefront for one specific date. A sweep then
 * checks whether that date has capacity again — using the same
 * `checkTourAvailability` the storefront uses, so "open" here means exactly
 * what "bookable" means on the tour page — and mails everyone waiting.
 *
 * Two rules the copy depends on:
 *   - joining requires the date to be full (or otherwise unbookable). If it is
 *     open, the traveller is told to book it instead of being added;
 *   - nobody's seat is ever held. The email says so, because availability is
 *     live and first come, first served.
 *
 * `notifiedAt` is the idempotency key: at-least-once delivery must never mail
 * the same person twice for the same date.
 */

const { isEnabled } = require('./featureFlags');

const BATCH_LIMIT = 50;

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Add a waitlist entry. Idempotent: joining twice with the same email returns
 * the existing row instead of a duplicate.
 */
async function joinWaitlist({ tourId, travelDate, email, userId = null }) {
  if (!isEnabled('waitlist')) return { ok: false, reason: 'Waitlist is not available right now' };

  const prisma = require('./prismaClient');
  const { checkTourAvailability } = require('./tourHelpers');
  const { toDateKey } = require('./availabilityCore');

  if (!tourId || !travelDate) return { ok: false, reason: 'A tour and a date are required' };
  if (!isValidEmail(email)) return { ok: false, reason: 'Enter a valid email address' };

  const date = new Date(`${String(travelDate).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return { ok: false, reason: 'That date is not valid' };

  const todayKey = new Date().toISOString().slice(0, 10);
  if (toDateKey(date) < todayKey) return { ok: false, reason: 'That date has already passed' };

  const tour = await prisma.tour.findUnique({
    where: { id: tourId },
    select: { id: true, status: true },
  });
  if (!tour || tour.status !== 'ACTIVE') return { ok: false, reason: 'That experience is not available' };

  // Only full dates can be waitlisted. An open date means "book it now", and
  // accepting a join here would quietly build a mailing list instead of a
  // waitlist.
  const verdict = await checkTourAvailability(tourId, date, null, { skipTimeRequirement: true });
  if (verdict?.available) {
    return { ok: false, reason: 'That date is still available — book it now to secure your spot' };
  }

  const normalized = email.trim().toLowerCase();
  const existing = await prisma.waitlistEntry.findUnique({
    where: { tourId_travelDate_email: { tourId, travelDate: date, email: normalized } },
  });
  if (existing) {
    if (existing.cancelledAt) {
      await prisma.waitlistEntry.update({
        where: { id: existing.id },
        data: { cancelledAt: null, notifiedAt: null },
      });
    }
    return { ok: true, alreadyJoined: true };
  }

  await prisma.waitlistEntry.create({
    data: { tourId, travelDate: date, email: normalized, userId },
  });

  return { ok: true, alreadyJoined: false };
}

/**
 * Leave the waitlist (the link in the email, or the form on the tour page).
 */
async function leaveWaitlist({ entryId, email }) {
  if (!isEnabled('waitlist')) return { ok: false, reason: 'Waitlist is not available right now' };

  const prisma = require('./prismaClient');
  if (!entryId && !email) return { ok: false, reason: 'Nothing to leave' };

  const where = entryId
    ? { id: entryId }
    : { email: String(email).trim().toLowerCase() };

  const updated = await prisma.waitlistEntry.updateMany({
    where: { ...where, cancelledAt: null },
    data: { cancelledAt: new Date() },
  });

  return { ok: true, left: updated.count > 0 };
}

/**
 * Sweep: for each distinct (tour, date) still waiting on someone, check
 * whether it reopened and notify every entry on it.
 */
async function notifyWaitlistOpenDates({ batchLimit = BATCH_LIMIT } = {}) {
  if (!isEnabled('waitlist')) return { groups: 0, notified: 0, disabled: true };

  const prisma = require('./prismaClient');
  const { checkTourAvailability } = require('./tourHelpers');
  const { sendWaitlistOpenEmail } = require('./emailService');
  const { sendNotification } = require('./notificationService');
  const fmt = require('./emailFormatting');

  const pending = await prisma.waitlistEntry.findMany({
    where: { notifiedAt: null, cancelledAt: null, travelDate: { gt: new Date() } },
    select: { tourId: true, travelDate: true },
    distinct: ['tourId', 'travelDate'],
    take: batchLimit,
  });

  let groups = 0;
  let notified = 0;

  for (const group of pending) {
    groups += 1;
    let open = false;
    try {
      const verdict = await checkTourAvailability(group.tourId, group.travelDate, null, { skipTimeRequirement: true });
      open = !!verdict?.available;
    } catch (err) {
      console.error(`[Waitlist] availability check failed for ${group.tourId}:`, err.message);
      continue;
    }
    if (!open) continue;

    const entries = await prisma.waitlistEntry.findMany({
      where: { tourId: group.tourId, travelDate: group.travelDate, notifiedAt: null, cancelledAt: null },
      include: { tour: { select: { id: true, slug: true, title: true, coverPhoto: true, photos: true, schedulesAndPricing: true } } },
    });
    if (entries.length === 0) continue;

    const tour = entries[0].tour;
    const dateLabel = fmt.formatShortDate(group.travelDate);

    for (const entry of entries) {
      // Claim first so a crashed run cannot mail the same person twice.
      const claimed = await prisma.waitlistEntry.updateMany({
        where: { id: entry.id, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
      if (claimed.count === 0) continue;

      try {
        await sendWaitlistOpenEmail({ entry, tour, dateLabel });
        if (entry.userId) {
          await sendNotification({
            userId: entry.userId,
            type: 'WAITLIST_OPEN',
            title: `Seats opened for ${tour.title}`,
            message: `${dateLabel} has availability again.`,
            data: { tourId: tour.id, slug: tour.slug, dateLabel },
            sendEmail: false,
            dedupeKey: `waitlist-open:${entry.id}`,
          });
        }
        notified += 1;
      } catch (err) {
        console.error(`[Waitlist] notify failed for entry ${entry.id}:`, err.message);
      }
    }
  }

  return { groups, notified };
}

module.exports = { joinWaitlist, leaveWaitlist, notifyWaitlistOpenDates, BATCH_LIMIT };
