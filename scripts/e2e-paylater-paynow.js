/* Live E2E for the new pay-later "complete payment" endpoints.
   1. Register a throwaway customer (real JWT).
   2. Pick an available Expedition tour + future date.
   3. Reserve now-pay-later (card captured, not charged).
   4. GET /expedition/bookings/:id/payment-state  → canPayNow true.
   5. POST /expedition/bookings/:id/pay-now        → hosted Stripe url returned.
   6. Cleanup: cancel booking (voids the PI).
   Env: E2E_API_BASE (default localhost:5000), STRIPE_SECRET_KEY from Backendv2/.env.
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
  const email = `e2e-paynow-${Date.now()}@test.local`;
  const reg = await api('POST', '/auth/register', { name: 'E2E PayNow', email, password: 'e2e-password-123' });
  const token = reg.data.accessToken;
  check('customer registered + JWT issued', !!token);

  console.log('2) Find an available tour + date');
  const tours = await api('GET', '/expedition/tours?limit=20');
  const list = tours.data?.tours || [];
  let tour = null;
  let travelDate = null;
  for (const t of list) {
    const slug = t.tour?.slug;
    const tourId = t.tour?.id;
    if (!slug || !tourId) continue;
    const cal = await api('GET', `/expedition/tours/${slug}/availability?startDate=${addDays(3)}&endDate=${addDays(31)}`).catch(() => null);
    const day = (cal?.data?.calendar || []).find((d) => d.status === 'AVAILABLE' || d.status === 'LIMITED');
    if (day) { tour = t.tour; travelDate = day.date; break; }
  }
  check('found tour + available date', !!tour && !!travelDate, tour ? `${tour.slug} @ ${travelDate}` : '');
  if (!tour || !travelDate) throw new Error('No bookable tour found');

  console.log('3) Reserve now, pay later');
  const conf = await api('POST', '/expedition/checkout/confirm', {
    tourId: tour.id,
    travelDate,
    travelers: {
      adults: 1, children: 0, infants: 0,
      phoneNumber: '+12025551234',
      location: 'New York, USA',
      details: [{ name: 'E2E Tester', age: 30, ageGroup: 'adult' }],
    },
    paymentMethodId: 'pm_card_visa',
    paymentTiming: 'later',
  }, token);
  const booking = conf.data.booking;
  const bookingId = booking.id;
  check('booking created', !!bookingId, `#${booking.bookingNumber}`);

  console.log('4) GET payment-state');
  const st = await api('GET', `/expedition/bookings/${bookingId}/payment-state`, null, token);
  const ps = st.data?.paymentState;
  check('payment-state returned', !!ps);
  check('canPayNow === true (unpaid pay-later, future date)', ps?.canPayNow === true, JSON.stringify(ps));
  check('requiresAction === false initially', ps?.requiresAction === false);
  check('autoChargeScheduled === true', ps?.autoChargeScheduled === true);

  console.log('5) POST pay-now (hosted checkout)');
  const pn = await api('POST', `/expedition/bookings/${bookingId}/pay-now`, {}, token);
  const url = pn.data?.url;
  check('pay-now returns hosted Stripe url', typeof url === 'string' && /^https:\/\/checkout\.stripe\.com\//.test(url), url ? url.slice(0, 60) + '…' : String(url));

  // The hosted session should carry the booking as client_reference_id.
  const sid = pn.data?.sessionId;
  if (sid) {
    const sess = await stripe.checkout.sessions.retrieve(sid);
    check('session client_reference_id === booking id', sess.client_reference_id === bookingId, `${sess.client_reference_id} vs ${bookingId}`);
    check('session amount matches booking total', sess.amount_total === Math.round(Number(booking.grossAmount) * 100), `${sess.amount_total}`);
    check('session mode payment', sess.mode === 'payment');
  } else {
    check('sessionId returned (session detail check skipped)', false);
  }

  // After creating the hosted session the sweep pause flag must be set.
  const after = await prisma.booking.findUnique({ where: { id: bookingId }, select: { requiresPaymentActionAt: true, stripeCheckoutSessionId: true, paymentStatus: true } });
  check('booking flagged requiresPaymentActionAt (sweep paused)', !!after?.requiresPaymentActionAt);
  check('booking carries the hosted session id', after?.stripeCheckoutSessionId === sid);
  check('paymentStatus still PENDING (not charged yet)', after?.paymentStatus === 'PENDING');

  console.log('6) Cleanup: cancel booking (voids any PI)');
  try {
    await api('PATCH', `/expedition/bookings/${bookingId}/cancel`, { reason: 'E2E test cleanup' }, token);
    const fin = await prisma.booking.findUnique({ where: { id: bookingId } });
    console.log(`  cleanup: booking now ${fin.status}/${fin.paymentStatus}`);
  } catch (err) {
    console.log(`  cleanup skipped: ${err.message}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED — payment-state + pay-now hosted checkout work end-to-end.');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nE2E FAILED:', err.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
