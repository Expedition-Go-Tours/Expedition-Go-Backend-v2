/**
 * Document expiry sweep — expires approved documents past their expiry date,
 * cascades the owning supplier into an EXPIRED state (hiding their tours),
 * and sends 60/30/7-day reminders. Idempotent: reminder sends are recorded as
 * VerificationEvents so repeated runs never double-email.
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const { sendEmail } = require('./emailService');
const { notifyAdmin } = require('./adminNotificationService');
const { enqueueNotification } = require('./queue');
const logger = require('./logger');

const REMINDER_WINDOWS = [60, 30, 7];
const ACTIVE_LIKE = ['ACTIVE', 'APPROVED'];

async function expireExpiredDocuments() {
  const now = new Date();

  const expiredDocs = await prisma.supplierDocument.findMany({
    where: { status: 'APPROVED', expiryDate: { lte: now } },
    include: { supplier: { select: { id: true, userId: true, status: true } } },
  });

  if (expiredDocs.length === 0) return { expiredDocuments: 0, expiringSuppliers: 0 };

  await prisma.supplierDocument.updateMany({
    where: { id: { in: expiredDocs.map((d) => d.id) } },
    data: { status: 'EXPIRED' },
  });

  // Record a history event per expired document.
  await prisma.verificationEvent.createMany({
    data: expiredDocs.map((d) => ({
      supplierId: d.supplierId,
      entityType: 'SUPPLIER',
      entityId: d.id,
      action: 'EXPIRED',
      actorId: 'SYSTEM',
    })),
  });

  // Cascade to suppliers: mark EXPIRED, hide their tours, notify.
  const bySupplier = new Map();
  for (const d of expiredDocs) {
    if (!bySupplier.has(d.supplier.id)) bySupplier.set(d.supplier.id, d.supplier);
  }

  let expiringSuppliers = 0;
  for (const [profileId, supplier] of bySupplier.entries()) {
    if (!ACTIVE_LIKE.includes(supplier.status)) continue;

    await prisma.supplierProfile.update({
      where: { id: profileId },
      data: { status: 'EXPIRED' },
    });
    expiringSuppliers += 1;

    // Invalidate public tour caches so listing disappears immediately
    // (listings filter on supplier status).
    try {
      const tours = await prisma.tour.findMany({
        where: { supplierId: supplier.userId },
        select: { id: true, slug: true },
      });
      await Promise.all(tours.map((t) => cache.invalidateTourCaches(t.id, t.slug)));
      await cache.invalidateKeys(['expedition:sitemap']);
    } catch (err) {
      logger.warn('[documentExpiry] cache invalidation failed:', err?.message);
    }

    await prisma.verificationEvent.create({
      data: {
        supplierId: profileId,
        entityType: 'SUPPLIER',
        entityId: profileId,
        action: 'STATUS_CHANGE',
        actorId: 'SYSTEM',
        note: 'Auto-suspended (EXPIRED) because an approved document expired',
      },
    });

    const user = await prisma.user.findUnique({ where: { id: supplier.userId } });
    if (user) {
      await sendEmail({
        to: user.email,
        subject: 'A required document has expired',
        template: 'generic-notification',
        data: {
          header: 'Document expired — account on hold',
          message: 'A required licence or certificate on your supplier account has expired. Your listings are temporarily hidden. Upload a renewed copy to restore your account.',
          userName: user.name,
        },
      }).catch((err) => logger.warn('[documentExpiry] expiry email failed:', err?.message));

      await enqueueNotification({
        userId: user.id,
        type: 'DOCUMENT_EXPIRED',
        title: 'Document expired',
        message: 'A required document has expired. Your listings are hidden until it is renewed and approved.',
        data: { supplierId: profileId },
      }).catch(() => {});
    }
  }

  await notifyAdmin({
    type: 'DOCUMENT_EXPIRED',
    title: 'Supplier documents expired',
    message: `${expiredDocs.length} document(s) expired; ${expiringSuppliers} supplier(s) placed on hold.`,
    data: {
      expiredDocuments: expiredDocs.length,
      expiringSuppliers,
      documentTypes: [...new Set(expiredDocs.map((d) => d.type))].join(', '),
    },
  }).catch(() => {});

  return { expiredDocuments: expiredDocs.length, expiringSuppliers };
}

async function planDocumentExpiryReminders() {
  const now = new Date();
  let remindersSent = 0;

  for (const days of REMINDER_WINDOWS) {
    const start = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const due = await prisma.supplierDocument.findMany({
      where: { status: 'APPROVED', expiryDate: { gte: start, lt: end } },
      include: { supplier: { select: { id: true, userId: true } } },
    });

    for (const doc of due) {
      const action = `EXPIRY_REMINDER_${days}`;
      const alreadySent = await prisma.verificationEvent.findFirst({
        where: { supplierId: doc.supplierId, entityId: doc.id, action },
      });
      if (alreadySent) continue;

      const user = await prisma.user.findUnique({ where: { id: doc.supplier.userId } });
      if (user) {
        await sendEmail({
          to: user.email,
          subject: `Reminder: document expires in ${days} days`,
          template: 'generic-notification',
          data: {
            header: `A document expires in ${days} days`,
            message: `One of your verified documents (${doc.type.replace(/_/g, ' ')}) expires soon. Renew it before the expiry date to avoid your listings being hidden.`,
            userName: user.name,
          },
        }).catch((err) => logger.warn('[documentExpiry] reminder email failed:', err?.message));

        await enqueueNotification({
          userId: user.id,
          type: 'DOCUMENT_EXPIRY_REMINDER',
          title: 'Document expiring soon',
          message: `A document expires in ${days} day(s).`,
          data: { supplierId: doc.supplierId, documentId: doc.id },
        }).catch(() => {});
      }

      await prisma.verificationEvent.create({
        data: {
          supplierId: doc.supplierId,
          entityType: 'SUPPLIER',
          entityId: doc.id,
          action,
          actorId: 'SYSTEM',
        },
      });
      remindersSent += 1;
    }
  }

  return { remindersSent };
}

module.exports = {
  expireExpiredDocuments,
  planDocumentExpiryReminders,
};