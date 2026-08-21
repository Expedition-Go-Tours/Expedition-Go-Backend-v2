/* Inspect the stuck expedition booking before cleanup. */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const b = await p.booking.findUnique({
    where: { id: 'cmt1aex1m0003wq8cmsxj4x7s' },
    include: { tour: { select: { id: true, title: true, supplierId: true } } },
  });
  if (!b) {
    console.log('NOT FOUND');
    process.exit(0);
  }
  console.log(JSON.stringify({
    id: b.id,
    bookingNumber: b.bookingNumber,
    status: b.status,
    paymentStatus: b.paymentStatus,
    paymentTiming: b.paymentTiming,
    stripePaymentIntentId: b.stripePaymentIntentId,
    stripeCheckoutSessionId: b.stripeCheckoutSessionId,
    paidAt: b.paidAt,
    grossAmount: b.grossAmount,
    currency: b.currency,
    createdAt: b.createdAt,
    cancellationReason: b.cancellationReason,
    tourId: b.tourId,
    tourTitle: b.tour?.title,
  }, null, 2));
  await p.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await p.$disconnect().catch(() => {});
  process.exit(1);
});