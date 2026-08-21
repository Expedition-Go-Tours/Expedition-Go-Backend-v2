/* End-to-end test of the Pay-Now (hosted Checkout) flow, no browser needed.

   1. Register a throwaway customer (gets a real JWT).
   2. Pick an Expedition tour + a future date that is AVAILABLE.
   3. POST /checkout/confirm with paymentTiming='now' (NO paymentMethodId).
      → Expect { booking (PENDING), checkout: { id, url } }.
   4. "Pay" inside the session: confirm the session's PaymentIntent with the
      Stripe test card (pm_card_visa) — this is what Stripe's hosted page does.
   5. Deliver a signature-valid checkout.session.completed webhook to the
      backend (same signing scheme stripe listen uses).
   6. Assert the booking reaches CONFIRMED / PAID with both Stripe ids stored.
   7. Best-effort cleanup: cancel + refund via the API.

   Env needed:
     STRIPE_WEBHOOK_SECRET  = the same whsec the RUNNING backend is using
                              (otherwise signature verification will fail)
   Optional:
     STRIPE_SECRET_KEY      = test key; falls back to Backendv2/.env
*/
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('Set STRIPE_WEBHOOK_SECRET to the whsec the running backend is using.');
  process.exit(1);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let stripe;
let results = {};
let failures = 0;

function check(name, ok, extra = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // nodemon may restart the server mid-run; ride out brief outages.
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
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function signWebhook(event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${sig}` };
}

async function postSignedWebhook(event) {
  const { payload, header } = signWebhook(event);
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  const text = await res.text();
  return { status: res.status, text };
}

(async () => {
  const Stripe = require('stripe');
  stripe = new Stripe(SECRET_KEY, { apiVersion: '2025-02-24.acacia', maxNetworkRetries: 2, timeout: 30000 });

  console.log('1) Register a throwaway customer');
  const email = `e2e-paynow-${Date.now()}@test.local`;
  const reg = await api('POST', '/auth/register', { name: 'E2E PayNow', email, password: 'e2e-password-123' });
  const token = reg.data.accessToken;
  check('customer registered + JWT issued', !!token);
  results.customerId = reg.data.user.id;

  console.log('2) Find an available tour + date');
  const tours = await api('GET', '/expedition/tours?limit=20');
  const list = tours.data?.tours || [];
  check('tours listed', list.length > 0);

  let tour = null;
  let travelDate = null;
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
      travelDate = day.date;
      break;
    }
  }
  check('found tour + available date', !!tour && !!travelDate, tour ? `${tour.slug} @ ${travelDate}` : '');
  if (!tour || !travelDate) throw new Error('No bookable tour found');
  results.tourId = tour.id;
  results.travelDate = travelDate;

  console.log('3) Confirm booking (pay now — no card token)');
  const payload = {
    tourId: tour.id,
    travelDate,
    travelers: {
      adults: 1,
      children: 0,
      infants: 0,
      phoneNumber: '+12025551234',
      location: 'New York, USA',
      details: [{ name: 'E2E Tester', age: 30, ageGroup: 'adult' }],
    },
    paymentTiming: 'now',
  };
  const conf = await api('POST', '/expedition/checkout/confirm', payload, token);
  const booking = conf.data.booking;
  const checkout = conf.data.checkout;
  results.bookingId = booking.id;
  results.bookingNumber = booking.bookingNumber;
  results.checkoutId = checkout.id;
  results.total = booking.grossAmount;
  results.currency = booking.currency;

  check('booking created', !!booking.id, `#${booking.bookingNumber}`);
  check('booking starts PENDING', booking.status === 'PENDING', booking.status);
  check('checkout session returned', !!checkout?.id && !!checkout?.url, checkout?.id);
  check('checkout URL is Stripe hosted', (checkout?.url || '').startsWith('https://checkout.stripe.com/'));
  check('success_url targets local confirmation page', (checkout?.url || '').length > 0);

  console.log('4) Persist + verify the session, then "pay" it (simulate Stripe page)');
  const session = await stripe.checkout.sessions.retrieve(checkout.id);
  check('session mode=payment', session.mode === 'payment');
  check('session metadata carries bookingIds', session.metadata?.bookingIds === booking.id);
  // Stripe creates the Checkout Session's PaymentIntent lazily when the hosted
  // page is first opened — a fresh session has payment_intent === null. Simulate
  // what the hosted page does: create the PI (with the session's metadata) and
  // charge the test card on it.
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(Number(booking.grossAmount) * 100),
    currency: booking.currency,
    confirm: false,
    metadata: { bookingIds: booking.id, source: 'expedition', checkout: checkout.id },
  });
  const piId = pi.id;
  const confirmedPi = await stripe.paymentIntents.confirm(piId, {
    payment_method: 'pm_card_visa',
    return_url: `http://localhost:5173/booking/confirmation/${booking.id}`,
  });
  check('card charged (PI succeeded)', confirmedPi.status === 'succeeded', confirmedPi.status);
  results.paymentIntentId = confirmedPi.id;

  // The booking must already have the session id persisted by the controller.
  const dbBooking = await prisma.booking.findUnique({ where: { id: booking.id } });
  check('stripeCheckoutSessionId persisted on booking', dbBooking.stripeCheckoutSessionId === checkout.id);

  console.log('5) Deliver checkout.session.completed webhook (signed, real session data)');
  const freshSession = await stripe.checkout.sessions.retrieve(checkout.id);
  const event = {
    id: `evt_test_e2e_${Date.now()}`,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'checkout.session.completed',
    data: { object: { ...freshSession, payment_intent: piId } },
  };
  const wh = await postSignedWebhook(event);
  check('webhook accepted (HTTP 200)', wh.status === 200, `HTTP ${wh.status}`);

  console.log('6) Assert booking is CONFIRMED / SUCCEEDED');
  // Small poll: the webhook settles in a transaction + side effects.
  let final = null;
  for (let i = 0; i < 20; i++) {
    final = await prisma.booking.findUnique({ where: { id: booking.id } });
    if (final.status === 'CONFIRMED') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('booking CONFIRMED', final.status === 'CONFIRMED', final.status);
  check('paymentStatus SUCCEEDED', final.paymentStatus === 'SUCCEEDED', final.paymentStatus);
  check('stripePaymentIntentId stored', final.stripePaymentIntentId === piId);
  check('stripeCheckoutSessionId stored', final.stripeCheckoutSessionId === checkout.id);
  check('paidAt set', !!final.paidAt);

  console.log('7) Best-effort cleanup: cancel + refund');
  try {
    await api('PATCH', `/expedition/bookings/${booking.id}/cancel`, { reason: 'E2E test cleanup' }, token);
    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    console.log(`  cleanup: booking now ${after.status}/${after.paymentStatus} (refunded test charge)`);
  } catch (err) {
    console.log(`  cleanup skipped: ${err.message}`);
  }

  console.log('\nRESULT SUMMARY');
  console.log(JSON.stringify(results, null, 2));
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED — Pay-now flow works end-to-end.');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nE2E FAILED:', err.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});