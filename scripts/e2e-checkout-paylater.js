/* End-to-end test of the Reserve-now-pay-later flow.

   1. Register a throwaway customer (gets a real JWT).
   2. Pick an Expedition tour + a future date that is AVAILABLE.
   3. POST /checkout/confirm with paymentTiming='later' + a card token.
      → Expect { booking (PENDING), checkout: null } — card captured, NOT charged.
   4. Assert the PaymentIntent is uncharged (amount_received 0) and the booking
      carries its id.
   5. Best-effort cleanup via the cancel API (voids the PI, no refund needed).

   Env: STRIPE_SECRET_KEY falls back to Backendv2/.env.
*/
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:5000';
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
  const email = `e2e-paylater-${Date.now()}@test.local`;
  const reg = await api('POST', '/auth/register', { name: 'E2E PayLater', email, password: 'e2e-password-123' });
  const token = reg.data.accessToken;
  check('customer registered + JWT issued', !!token);

  console.log('2) Find an available tour + date');
  const tours = await api('GET', '/expedition/tours?limit=20');
  const list = tours.data?.tours || [];
  let tour = null;
  let selectedDate = null;
  for (const t of list) {
    const slug = t.tour?.slug;
    const tourId = t.tour?.id;
    if (!slug || !tourId) continue;
    const start = addDays(3);
    const end = addDays(31);
    let cal;
    try {
      cal = await api('GET', `/expedition/tours/${slug}/availability?startDate=${start}&endDate=${end}`);
    } catch {
      continue;
    }
    const day = (cal.data?.calendar || []).find((d) => d.status === 'AVAILABLE' || d.status === 'LIMITED');
    if (day) {
      tour = t.tour;
      selectedDate = day.date;
      break;
    }
  }
  check('found tour + available date', !!tour && !!selectedDate, tour ? `${tour.slug} @ ${selectedDate}` : '');
  if (!tour || !selectedDate) throw new Error('No bookable tour found');

  console.log('3) Confirm booking (reserve now, pay later — card token sent)');
  const conf = await api('POST', '/expedition/checkout/confirm', {
    tourId: tour.id,
    selectedDate,
    travelers: {
      adults: 1,
      children: 0,
      infants: 0,
      phoneNumber: '+12025551234',
      location: 'New York, USA',
      details: [{ name: 'E2E Tester', age: 30, ageGroup: 'adult' }],
    },
    paymentMethodId: 'pm_card_visa',
    paymentTiming: 'later',
  }, token);

  const booking = conf.data.booking;
  const checkout = conf.data.checkout;
  const bookingId = booking.id;
  const piId = booking.stripePaymentIntentId;
  check('booking created', !!bookingId, `#${booking.bookingNumber}`);
  check('booking starts PENDING', booking.status === 'PENDING', booking.status);
  check('paymentTiming = later', booking.paymentTiming === 'later', booking.paymentTiming);
  check('paymentStatus PENDING (not charged yet)', booking.paymentStatus === 'PENDING', booking.paymentStatus);
  check('no checkout redirect (checkout null)', checkout === null);
  check('PaymentIntent attached to booking', !!piId, piId);

  console.log('4) Assert the card is captured but NOT charged');
  const pi = await stripe.paymentIntents.retrieve(piId);
  const uncharged = pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation';
  check('PI uncharged (requires_payment_method/requires_confirmation)', uncharged, pi.status);
  check('amount_received === 0 (nothing billed)', pi.amount_received === 0, String(pi.amount_received));
  check('PI amount matches booking total', pi.amount === Math.round(Number(booking.total) * 100), `${pi.amount} vs ${booking.total}`);
  check('PI metadata carries bookingIds', pi.metadata?.bookingIds === bookingId);

  console.log('5) Best-effort cleanup: cancel (voids PI, no charge to refund)');
  try {
    await api('PATCH', `/expedition/bookings/${bookingId}/cancel`, { reason: 'E2E test cleanup' }, token);
    const after = await prisma.booking.findUnique({ where: { id: bookingId } });
    console.log(`  cleanup: booking now ${after.status}/${after.paymentStatus}`);
  } catch (err) {
    console.log(`  cleanup skipped: ${err.message}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED — Reserve-now-pay-later works end-to-end.');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nE2E FAILED:', err.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});