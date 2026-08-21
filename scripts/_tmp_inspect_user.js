const fs = require('fs');
const dotenv = fs.readFileSync('.env', 'utf8');
const key = dotenv.match(/^STRIPE_SECRET_KEY=(.+)$/m)[1].trim();
const Stripe = require('stripe');
const stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findUnique({ where: { email: 'kwarteon08@gmail.com' } });
  const bs = await p.booking.findMany({
    where: { customerId: u.id },
    orderBy: { createdAt: 'desc' },
    select: { bookingNumber: true, status: true, paymentStatus: true, stripePaymentIntentId: true, createdAt: true, id: true },
  });
  for (const b of bs.slice(0, 5)) {
    console.log(b.bookingNumber, b.status + '/' + b.paymentStatus, 'pi=' + b.stripePaymentIntentId, 'created=' + b.createdAt.toISOString());
    if (b.stripePaymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(b.stripePaymentIntentId).catch((e) => ({ ERR: e.message }));
      console.log('   ', pi.status || pi.ERR, pi.amount_received != null ? 'amount_received=' + pi.amount_received : '');
    }
  }
  await p.$disconnect();
})().catch(async (e) => { console.error(e.message); await p.$disconnect(); process.exit(1); });