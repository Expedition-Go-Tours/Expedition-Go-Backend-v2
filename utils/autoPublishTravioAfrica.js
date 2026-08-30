/**
 * TravioAfrica Auto-Publish — pan-African tour publishing domain logic.
 *
 * publishTourToAfrica(tourId) is the idempotent core: if the tour's supplier
 * is NOT Ghana-based (Ghana suppliers go to TravioGhana), it upserts a
 * TravioAfricaTour record and assigns the 'travioafrica' role.
 *
 * reconcileTravioAfricaPublish() is the self-healing sweep.
 *
 * Mirrors autoPublishGhana.js exactly — same pattern, different platform.
 */

const prisma = require('./prismaClient');
const logger = require('./logger');

const AFRICA_ROLE = 'travioafrica';

/**
 * Publish a single tour to TravioAfrica if its supplier is a non-Ghana
 * African supplier. Idempotent — safe to retry or call repeatedly.
 */
async function publishTourToAfrica(tourId, actorId) {
  try {
    const tour = await prisma.tour.findUnique({
      where: { id: tourId },
      select: { id: true, title: true, supplierId: true, status: true },
    });

    if (!tour || !tour.supplierId) {
      logger.warn(`[Travio Africa] Tour ${tourId} not found or has no supplier, skipping`);
      return null;
    }

    if (tour.status !== 'ACTIVE') {
      logger.info(`[Travio Africa] Tour ${tourId} status is ${tour.status}, skipping`);
      return null;
    }

    const supplierProfile = await prisma.supplierProfile.findFirst({
      where: { userId: tour.supplierId },
      select: { businessInfo: true },
    });

    const country = supplierProfile?.businessInfo?.country;
    // Ghana suppliers go to TravioGhana, not TravioAfrica
    if (!country || country === 'Ghana') {
      return null;
    }

    // Manual unpublish must stick
    const existing = await prisma.travioAfricaTour.findUnique({ where: { tourId } });
    if (existing) {
      if (existing.isActive) return existing;
      if (existing.unpublishedById) {
        logger.info(`[Travio Africa] Tour ${tourId} was manually unpublished, skipping`);
        return existing;
      }
      // Re-activate sweep-deactivated listing
      return prisma.travioAfricaTour.update({
        where: { tourId },
        data: { isActive: true, lastSyncAt: new Date() },
      });
    }

    const africaTour = await prisma.travioAfricaTour.create({
      data: {
        tourId,
        isActive: true,
        bookingFlow: 'DIRECT',
        publishedById: actorId || null,
        publishedAt: new Date(),
        syncStatus: 'synced',
        lastSyncAt: new Date(),
      },
    });

    // Ensure the supplier carries the 'travioafrica' role
    const user = await prisma.user.findUnique({
      where: { id: tour.supplierId },
      select: { roles: true },
    });
    if (user && !user.roles.includes(AFRICA_ROLE)) {
      await prisma.user.update({
        where: { id: tour.supplierId },
        data: { roles: { set: [...new Set([...user.roles, AFRICA_ROLE])] } },
      });
      logger.info(`[Travio Africa] Assigned '${AFRICA_ROLE}' role to supplier ${tour.supplierId}`);
    }

    logger.info(`[Travio Africa] Tour "${tour.title}" (${tourId}) auto-published (id: ${africaTour.id})`);
    return africaTour;
  } catch (error) {
    logger.error(`[Travio Africa] Failed to auto-publish tour ${tourId}:`, error);
    return null;
  }
}

/**
 * Self-healing sweep — run periodically (every 30 min from server.js).
 * Re-enqueues every ACTIVE tour of every non-Ghana supplier.
 */
async function reconcileTravioAfricaPublish() {
  try {
    const suppliers = await prisma.supplierProfile.findMany({
      where: { status: 'ACTIVE' },
      select: { userId: true, businessInfo: true },
    });

    // Non-Ghana African suppliers
    const africaSuppliers = suppliers.filter((s) => {
      const c = s.businessInfo?.country;
      return c && c !== 'Ghana';
    });

    let enqueued = 0;
    for (const supplier of africaSuppliers) {
      const tours = await prisma.tour.findMany({
        where: { supplierId: supplier.userId, status: 'ACTIVE' },
        select: { id: true },
      });
      for (const t of tours) {
        const { enqueueTravioAfricaPublish } = require('./queue');
        await enqueueTravioAfricaPublish(t.id);
        enqueued++;
      }
    }

    // Deactivate listings whose source tour is gone/archived
    const activeListings = await prisma.travioAfricaTour.findMany({
      where: { isActive: true },
      select: { id: true, tour: { select: { status: true } } },
    });
    const toDeactivate = activeListings
      .filter((l) => l.tour.status !== 'ACTIVE')
      .map((l) => l.id);

    if (toDeactivate.length > 0) {
      await prisma.travioAfricaTour.updateMany({
        where: { id: { in: toDeactivate } },
        data: { isActive: false, unpublishedAt: new Date() },
      });
    }

    if (enqueued > 0 || toDeactivate.length > 0) {
      logger.info(
        `[Travio Africa] Reconcile: enqueued ${enqueued} publish job(s), deactivated ${toDeactivate.length} stale listing(s)`
      );
    }
    return { enqueued, deactivated: toDeactivate.length };
  } catch (error) {
    logger.error('[Travio Africa] Reconcile sweep failed:', error);
    return { enqueued: 0, deactivated: 0 };
  }
}

module.exports = { publishTourToAfrica, reconcileTravioAfricaPublish };
