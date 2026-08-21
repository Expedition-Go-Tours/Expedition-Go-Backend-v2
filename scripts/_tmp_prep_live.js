const bcrypt = require('bcrypt');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();
const dotenv = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const key = dotenv.match(/^STRIPE_SECRET_KEY=(.+)$/m)[1].trim();
const stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' });

(async () => {
  const user = await p.user.findUnique({ where: { email: 'kwarteon08@gmail.com' } });
  if (user) {
    const hash = await bcrypt.hash('e2e-live-pass-123', 10);
    await p.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
    console.log('user password reset -> e2e-live-pass-123');
  } else {
    console.log('user NOT FOUND');
  }

  const leftovers = await p.booking.findMany({
    where: { customerId: user?.id, status: { in: ['PENDING', 'CONFIRMED'] } },
    orderBy: { createdAt: 'desc' },
  });
  for (const leftover of leftovers) {
    console.log('leftover booking:', leftover.bookingNumber, leftover.id, leftover.stripePaymentIntentId, leftover.status);
    if (leftover.stripePaymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(leftover.stripePaymentIntentId);
        if (pi.amount_received > 0 && pi.status === 'succeeded') {
          const refund = await stripe.refunds.create({ payment_intent: leftover.stripePaymentIntentId });
          console.log('  refunded:', refund.id, refund.status);
        } else if (pi.status !== 'canceled') {
          const c = await stripe.paymentIntents.cancel(leftover.stripePaymentIntentId);
          console.log('  PI cancelled:', c.id, c.status);
        } else {
          console.log('  PI already canceled');
        }
      } catch (e) {
        console.log('  PI note:', e.message);
      }
    }
    await p.booking.updateMany({
      where: { id: leftover.id, status: { in: ['PENDING', 'CONFIRMED'] } },
      data: { status: 'CANCELLED', paymentStatus: 'REFUNDED', cancellationReason: 'E2E re-run cleanup', cancelledAt: new Date() },
    });
    console.log('  booking cancelled/refunded');
  }
  if (leftovers.length === 0) console.log('no leftover active bookings');
  await p.$disconnect();
})().catch(async (e) => { console.error(e.message); await p.$disconnect(); process.exit(1); });