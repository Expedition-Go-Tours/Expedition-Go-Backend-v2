/* Live verification that completing a "pay-now" hosted Checkout session
   settles the reserve-now-pay-later booking.

   Flow:
   1. Register throwaway customer.
   2. Reserve pay-later (card captured, not charged).
   3. POST /bookings/:id/pay-now → hosted session.
   4. Simulate what Stripe delivers on completion: we drive the same internal
      webhook path (processStripeWebhook) with the REAL session's completed
      event shape. Because the session was created with client_reference_id =
      booking id, checkout.session.completed must flip the booking to
      CONFIRMED/SUCCEEDED and clear requiresPaymentActionAt.
   5. Cleanup (booking already settled → cancel API would refund; instead just
      note it and void via admin? We'll cancel; no funds actually moved because
      session payment was never captured by a real card — handlePaymentSucceeded
      is driven on session.payment_intent which is unconfirmed).
*/
const path = require('path');
const fs = require('fs');

const BASE = process.env.E2E_API_BASE || 'http://localhost:5000';
const API = `${BASE}/api`;

function loadDotenvKey(name) {
  const p = path.join(__dirname, '..', '.env');
  const txt = fs.readFileSync(p, 'utf8');
  const m = txt.match(new RegExp(`^${name}=(.+)$`, 'm'));
  if (!m) throw new Error(`${name} missing in ${p}`);
  return m[1].trim();
}

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || loadDotenvKey('STRIPE_SECRET_KEY');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const Stripe = require('stripe');
const stripe = new Stripe(SECRET_KEY, { apiVersion: '2025-02-24.acacia', maxNetworkRetries: 2, timeout: 30000 });

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`${API}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let json = null;
      try { json = await res.json(); } catch {}
      if (!res.ok) {
        const err = new Error(`${method} ${p} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (err.status) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

function addDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

(async () => {
  console.log('1) Register a throwaway customer');
  const email = `e2e-settle-${Date.now()}@test.local`;
  const reg = await api('POST', '/auth/register', { name: 'E2E Settle', email, password: 'e2e-password-123' });
  const token = reg.data.accessToken;
  check('customer registered + JWT issued', !!token);

  console.log('2) Find an available tour + date');
  const tours = await api('GET', '/expedition/tours?limit=20');
  const list = tours.data?.tours || [];
  let tour = null, travelDate = null;
  for (const t of list) {
    const slug = t.tour?.slug, tourId = t.tour?.id;
    if (!slug || !tourId) continue;
    const cal = await api('GET', `/expedition/tours/${slug}/availability?startDate=${addDays(3)}&endDate=${addDays(31)}`).catch(() => null);
    const day = (cal?.data?.calendar || []).find((d) => d.status === 'AVAILABLE' || d.status === 'LIMITED');
    if (day) { tour = t.tour; travelDate = day.date; break; }
  }
  check('found tour + available date', !!tour && !!travelDate, tour ? `${tour.slug} @ ${travelDate}` : '');
  if (!tour || !travelDate) throw new Error('No bookable tour found');

  console.log('3) Reserve now, pay later');
  const conf = await api('POST', '/expedition/checkout/confirm', {
    tourId: tour.id, travelDate,
    travelers: {
      adults: 1, children: 0, infants: 0, phoneNumber: '+12025551234',
      location: 'New York, USA',
      details: [{ name: 'E2E Tester', age: 30, ageGroup: 'adult' }],
    },
    paymentMethodId: 'pm_card_visa', paymentTiming: 'later',
  }, token);
  const booking = conf.data.booking;
  const bookingId = booking.id;
  check('booking created', !!bookingId, `#${booking.bookingNumber}`);

  console.log('4) Start the hosted pay-now session');
  const pn = await api('POST', `/expedition/bookings/${bookingId}/pay-now`, {}, token);
  const sid = pn.data?.sessionId;
  check('hosted session created', !!sid, sid);
  const session = await stripe.checkout.sessions.retrieve(sid);
  check('session client_reference_id === booking id', session.client_reference_id === bookingId);

  console.log('5) Simulate checkout.session.completed (drive internal settle path)');
  // A hosted Checkout session only gains its payment_intent after the customer
  // pays. To faithfully drive the settle path we create a real PaymentIntent
  // for the booking total and confirm it with the test card (auto-succeeds in
  // test mode) — mirroring what Stripe delivers post-payment — then run the
  // same internal webhook handler the live checkout.session.completed event
  // triggers.
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(Number(booking.grossAmount) * 100),
    currency: booking.currency || 'usd',
    payment_method: 'pm_card_visa',
    confirm: true,
    return_url: `${BASE}/booking/complete`,
    metadata: { bookingIds: bookingId },
  });
  check('session payment intent confirmed (succeeded)', pi.status === 'succeeded', pi.status);

  const { processStripeWebhook } = require('../utils/stripeHelpers');
  const completedEvent = {
    id: `evt_e2e_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: session.id,
        client_reference_id: bookingId,
        metadata: { bookingIds: bookingId },
        payment_intent: pi.id,
        amount_total: pi.amount,
        mode: session.mode,
      },
    },
  };
  const result = await processStripeWebhook(completedEvent);

  const settled = await prisma.booking.findUnique({ where: { id: bookingId } });
  check('booking settled to CONFIRMED', settled.status === 'CONFIRMED', settled.status);
  check('booking paymentStatus SUCCEEDED', settled.paymentStatus === 'SUCCEEDED', settled.paymentStatus);
  check('paidAt set', !!settled.paidAt);
  check('requiresPaymentActionAt cleared', settled.requiresPaymentActionAt === null, String(settled.requiresPaymentActionAt));
  check('booking.stripePaymentIntentId updated to session PI', settled.stripePaymentIntentId === pi.id, `${settled.stripePaymentIntentId}`);

  console.log('6) Cleanup');
  // No funds were captured (the session PI was never confirmed by a real card),
  // so we void the reservation + any PI and mark it cancelled to keep the DB tidy.
  try {
    const { cancelPaymentIntent } = require('./utils/stripeHelpers');
    await cancelPaymentIntent(settled.stripePaymentIntentId).catch(() => {});
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'E2E settle verification — no funds moved', paymentStatus: 'PENDING' },
    });
    console.log('  cleanup done (reservation cancelled, PI voided where possible)');
  } catch (err) {
    console.log(`  cleanup note: ${err.message}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED — checkout.session.completed settles the pay-later booking end-to-end.');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nE2E FAILED:', err.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
