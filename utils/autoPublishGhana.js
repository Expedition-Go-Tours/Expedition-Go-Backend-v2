const prisma = require('./prismaClient');
const logger = require('./logger');

async function autoPublishToGhana(tourId, userId) {
  try {
    const tour = await prisma.tour.findUnique({
      where: { id: tourId },
      select: {
        id: true,
        title: true,
        supplierId: true,
      },
    });

    if (!tour || !tour.supplierId) {
      logger.warn(`[Travio Ghana] Tour ${tourId} not found or has no supplier, skipping auto-publish`);
      return null;
    }

    const supplierProfile = await prisma.supplierProfile.findFirst({
      where: { userId: tour.supplierId },
      select: {
        country: true,
        operatingInfo: true,
      },
    });

    if (!supplierProfile) {
      logger.warn(`[Travio Ghana] No supplier profile found for tour ${tourId}, skipping auto-publish`);
      return null;
    }

    const isGhanaSupplier =
      supplierProfile.country === 'Ghana' ||
      (supplierProfile.operatingInfo &&
        supplierProfile.operatingInfo.destinations &&
        Array.isArray(supplierProfile.operatingInfo.destinations) &&
        supplierProfile.operatingInfo.destinations.includes('Ghana'));

    if (!isGhanaSupplier) {
      logger.info(`[Travio Ghana] Supplier for tour ${tourId} is not Ghana-based, skipping auto-publish`);
      return null;
    }

    const existing = await prisma.travioGhanaTour.findFirst({
      where: { tourId },
    });

    if (existing) {
      logger.info(`[Travio Ghana] Tour ${tourId} already published to Travio Ghana (id: ${existing.id})`);
      return existing;
    }

    const ghanaTour = await prisma.travioGhanaTour.create({
      data: {
        tourId,
        isActive: true,
        bookingFlow: 'DIRECT',
        addedById: userId,
      },
    });

    logger.info(`[Travio Ghana] Tour "${tour.title}" (${tourId}) auto-published to Travio Ghana (id: ${ghanaTour.id})`);
    return ghanaTour;
  } catch (error) {
    logger.error(`[Travio Ghana] Failed to auto-publish tour ${tourId} to Travio Ghana:`, error);
    return null;
  }
}

module.exports = { autoPublishToGhana };
