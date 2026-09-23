/**
 * One-off backfill: insert the missing TOUR_APPROVED notification for a tour
 * that was approved BEFORE the brand-scoped reviewTour handler notified the
 * supplier (fix: enqueueNotification added to src/core/admin.js).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/backfill-tour-approved-notification.js <tourId>
 *
 * Safe to re-run: skips if a TOUR_APPROVED/TOUR_FLAGGED notification already
 * exists for that tour.
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const tourId = process.argv[2];
  if (!tourId) {
    console.error('Usage: node scripts/backfill-tour-approved-notification.js <tourId>');
    process.exit(1);
  }

  const tour = await prisma.tour.findUnique({
    where: { id: tourId },
    select: { id: true, title: true, slug: true, status: true, supplierId: true },
  });
  if (!tour) {
    console.error(`Tour ${tourId} not found.`);
    process.exit(1);
  }
  if (tour.status !== 'ACTIVE') {
    console.error(`Tour ${tourId} status is ${tour.status}, not ACTIVE — refusing to send a TOUR_APPROVED notification.`);
    process.exit(1);
  }

  // Skip if an approval/flag notification already carries this tourId.
  const dupe = await prisma.notification.findFirst({
    where: {
      userId: tour.supplierId,
      type: 'TOUR_APPROVED',
      // data is Json; match on tourId via filtered JSON path
      data: { path: ['tourId'], equals: tour.id },
    },
  });
  if (dupe) {
    console.log(`Notification already exists (id ${dupe.id}) — nothing to do.`);
    return;
  }

  const created = await prisma.notification.create({
    data: {
      userId: tour.supplierId,
      type: 'TOUR_APPROVED',
      title: 'Tour Approved',
      message: `"${tour.title}" has been approved and is now live on the platform.`,
      data: { tourId: tour.id, status: 'ACTIVE', reason: null },
      read: false,
    },
  });

  console.log(`Created notification ${created.id} for supplier ${tour.supplierId} (tour "${tour.title}").`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
