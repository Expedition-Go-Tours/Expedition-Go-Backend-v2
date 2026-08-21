const fs = require('fs');
const dotenv = fs.readFileSync('.env', 'utf8');
const key = dotenv.match(/^STRIPE_SECRET_KEY=(.+)$/m)[1].trim();
const Stripe = require('stripe');
const stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findUnique({ where: { email: 'kwarteon08@gmail.com' } });
  const b = await p.booking.findFirst({
    where: { customerId: u.id, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  if (!b) { console.log('no pending booking'); return; }
  console.log('booking:', b.bookingNumber, 'pi=' + b.stripePaymentIntentId);
  const pi = await stripe.paymentIntents.retrieve(b.stripePaymentIntentId);
  console.log('PI status:', pi.status, 'amount_received=' + pi.amount_received, 'created=' + new Date(pi.created * 1000).toISOString());
  console.log('PI metadata:', JSON.stringify(pi.metadata));
  await p.$disconnect();
})().catch(async (e) => { console.error(e.message); await p.$disconnect(); process.exit(1); });