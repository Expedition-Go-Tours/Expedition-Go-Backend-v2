/**
 * Archived Tour Purge — permanent removal of soft-deleted tours.
 *
 * "Delete" is a soft-delete (status → ARCHIVED) so a mistaken delete stays
 * reversible. After a grace period, tours that never had real activity are
 * permanently destroyed — GetYourGuide-style: anything that ever produced a
 * real booking or review lives forever; only never-booked / simulation-only
 * tours are ever removed.
 *
 * Purge criteria:
 *  - status ARCHIVED for longer than the grace period (default 30 days)
 *  - no booking with isSimulated = false (real bookings block via app check;
 *    Booking/Review FKs are ON DELETE RESTRICT as a final DB-level guard)
 *  - the supplier account is not archived (archived suppliers are restorable
 *    via archiveSnapshot, so their tours must never be purged)
 *
 * Runs daily from the system-cleanup queue (see server.js).
 */

const { deleteCloudinaryImage } = require('./cloudinaryHelper');

const DEFAULT_GRACE_DAYS = 30;
const SWEEP_LIMIT = 200;

async function purgeArchivedTours({ days = DEFAULT_GRACE_DAYS, now = new Date() } = {}) {
  const prisma = require('./prismaClient');
  const cache = require('./cacheHelper');
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const candidates = await prisma.tour.findMany({
    where: {
      status: 'ARCHIVED',
      updatedAt: { lt: cutoff },
      supplier: { supplierProfile: { archiveSnapshot: null } },
    },
    select: {
      id: true,
      title: true,
      slug: true,
      photos: true,
      coverPhoto: true,
    },
    orderBy: { updatedAt: 'asc' },
    take: SWEEP_LIMIT,
  });

  const result = { scanned: candidates.length, purged: 0, skipped: 0, failed: 0 };

  for (const tour of candidates) {
    const realBooking = await prisma.booking.findFirst({
      where: { tourId: tour.id, isSimulated: false },
      select: { id: true },
    });
    if (realBooking) {
      result.skipped += 1;
      console.log(`[TourPurge] Skipped "${tour.title}" (${tour.id}): has real bookings`);
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.payout.deleteMany({ where: { booking: { tourId: tour.id } } });
        await tx.review.deleteMany({ where: { tourId: tour.id } });
        await tx.booking.deleteMany({ where: { tourId: tour.id } });
        await tx.tour.delete({ where: { id: tour.id } });
      });
      result.purged += 1;
    } catch (err) {
      if (err?.code === 'P2003') {
        result.skipped += 1;
        console.log(`[TourPurge] Skipped "${tour.title}" (${tour.id}): still referenced by ${err.meta?.field_name || 'a related record'}`);
        continue;
      }
      result.failed += 1;
      console.error(`[TourPurge] Failed "${tour.title}" (${tour.id}):`, err?.message || err);
      continue;
    }

    for (const photoUrl of [...(tour.photos || []), tour.coverPhoto].filter(Boolean)) {
      await deleteCloudinaryImage(photoUrl, 3, { tourId: tour.id }).catch((err) =>
        console.warn(`[TourPurge] Cloudinary delete failed for ${tour.id}:`, err?.message || err)
      );
    }

    cache.invalidateTourCaches(tour.id, tour.slug).catch((err) =>
      console.warn(`[TourPurge] Cache invalidation failed for ${tour.id}:`, err?.message || err)
    );
  }

  console.log(`[TourPurge] Sweep: ${result.scanned} archived tours → ${result.purged} purged, ${result.skipped} skipped, ${result.failed} failed`);
  return result;
}

module.exports = { purgeArchivedTours };