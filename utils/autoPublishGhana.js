/**
 * TravioGhana Auto-Publish — Ghana-scoped tour publishing domain logic.
 *
 * publishTourToGhana(tourId) is the idempotent core: if the tour's supplier is
 * Ghana-based (businessInfo.country === 'Ghana'), it upserts a TravioGhanaTour
 * record (which makes the tour visible on the Ghana storefront + Ghana supplier
 * dashboard) and ensures the supplier carries the 'ghana' role.
 *
 * reconcileGhanaPublish() is the self-healing sweep: it re-enqueues every ACTIVE
 * tour of every Ghana supplier (so anything missed by the queue gets published)
 * and deactivates TravioGhanaTour records whose source tour is no longer ACTIVE.
 * The first run doubles as the backfill for existing Ghana suppliers.
 */

const prisma = require('./prismaClient');
const logger = require('./logger');

const GHANA_ROLE = 'ghana';

/**
 * Publish a single tour to TravioGhana if its supplier is Ghana-based.
 * Idempotent — safe to retry or call repeatedly.
 * @param {string} tourId
 * @param {string} [actorId] - user performing the action (stored on publishedById)
 */
async function publishTourToGhana(tourId, actorId) {
  try {
    const tour = await prisma.tour.findUnique({
      where: { id: tourId },
      select: { id: true, title: true, supplierId: true, status: true },
    });

    if (!tour || !tour.supplierId) {
      logger.warn(`[Travio Ghana] Tour ${tourId} not found or has no supplier, skipping auto-publish`);
      return null;
    }

    if (tour.status !== 'ACTIVE') {
      logger.info(`[Travio Ghana] Tour ${tourId} status is ${tour.status}, skipping auto-publish`);
      return null;
    }

    const supplierProfile = await prisma.supplierProfile.findFirst({
      where: { userId: tour.supplierId },
      select: { businessInfo: true },
    });

    const isGhanaSupplier = supplierProfile?.businessInfo?.country === 'Ghana';
    if (!isGhanaSupplier) {
      logger.info(`[Travio Ghana] Supplier for tour ${tourId} is not Ghana-based, skipping auto-publish`);
      return null;
    }

    const ghanaTour = await prisma.travioGhanaTour.upsert({
      where: { tourId },
      update: { isActive: true },
      create: {
        tourId,
        isActive: true,
        bookingFlow: 'DIRECT',
        publishedById: actorId || null,
        publishedAt: new Date(),
        syncStatus: 'synced',
        lastSyncAt: new Date(),
      },
    });

    // Ensure the supplier carries the 'ghana' role (SET semantics — idempotent).
    const user = await prisma.user.findUnique({
      where: { id: tour.supplierId },
      select: { roles: true },
    });
    if (user && !user.roles.includes(GHANA_ROLE)) {
      await prisma.user.update({
        where: { id: tour.supplierId },
        data: { roles: { set: [...new Set([...user.roles, GHANA_ROLE])] } },
      });
      logger.info(`[Travio Ghana] Assigned '${GHANA_ROLE}' role to supplier ${tour.supplierId}`);
    }

    logger.info(`[Travio Ghana] Tour "${tour.title}" (${tourId}) auto-published to Travio Ghana (id: ${ghanaTour.id})`);
    return ghanaTour;
  } catch (error) {
    logger.error(`[Travio Ghana] Failed to auto-publish tour ${tourId} to Travio Ghana:`, error);
    return null;
  }
}

/**
 * Self-healing sweep — run periodically (e.g. every 30 min from server.js).
 * - Re-enqueues every ACTIVE tour of every Ghana-based supplier (backfill + healing).
 * - Deactivates TravioGhanaTour records whose source tour is not ACTIVE anymore.
 */
async function reconcileGhanaPublish() {
  try {
    const suppliers = await prisma.supplierProfile.findMany({
      where: { status: 'ACTIVE' },
      select: { userId: true, businessInfo: true },
    });

    const ghanaSuppliers = suppliers.filter((s) => s.businessInfo?.country === 'Ghana');
    let enqueued = 0;

    for (const supplier of ghanaSuppliers) {
      const tours = await prisma.tour.findMany({
        where: { supplierId: supplier.userId, status: 'ACTIVE' },
        select: { id: true },
      });
      for (const t of tours) {
        const { enqueueGhanaPublish } = require('./queue');
        await enqueueGhanaPublish(t.id);
        enqueued++;
      }
    }

    // Deactivate Ghana listings whose source tour is gone/archived.
    const activeListings = await prisma.travioGhanaTour.findMany({
      where: { isActive: true },
      select: { id: true, tour: { select: { status: true } } },
    });
    const toDeactivate = activeListings
      .filter((l) => l.tour.status !== 'ACTIVE')
      .map((l) => l.id);

    if (toDeactivate.length > 0) {
      await prisma.travioGhanaTour.updateMany({
        where: { id: { in: toDeactivate } },
        data: { isActive: false, unpublishedAt: new Date() },
      });
    }

    if (enqueued > 0 || toDeactivate.length > 0) {
      logger.info(
        `[Travio Ghana] Reconcile: enqueued ${enqueued} publish job(s), deactivated ${toDeactivate.length} stale listing(s)`
      );
    }
    return { enqueued, deactivated: toDeactivate.length };
  } catch (error) {
    logger.error('[Travio Ghana] Reconcile sweep failed:', error);
    return { enqueued: 0, deactivated: 0 };
  }
}

module.exports = { publishTourToGhana, reconcileGhanaPublish };
