/* Live email test: two real bookings to a real address.

   Booking 1 — PAY NOW:  confirm -> hosted Checkout session -> pay test card ->
                         deliver signed checkout.session.completed webhook.
                         Expect email: "booking-confirmed" (Booking Confirmed).

Booking 2 — PAY LATER: confirm with card token (uncharged).
                          Expect email: "reserve-later-confirmed" (Spot reserved,
                          payment collected later).
                          Then simulate the deferred charge (what payLaterSweep
                          does): confirm the PaymentIntent -> real
                          payment_intent.succeeded webhook.
                          Expect email: "pay-later-charged" (+ "supplier-pay-later-charged").

   Env: STRIPE_WEBHOOK_SECRET = whsec the running backend uses.
*/
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5000';
const API = `${BASE}/api`;
const EMAIL = 'kwarteon08@gmail.com';
const PASSWORD = 'e2e-live-pass-123';

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

function signWebhook(event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${sig}` };
}

async function postSignedWebhook(event) {
  const { payload, header } = signWebhook(event);
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
        body: payload,
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function waitForBooking(id, expectedStatus, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const b = await prisma.booking.findUnique({ where: { id } });
    if (b.status === expectedStatus) return b;
    await new Promise((r) => setTimeout(r, 700));
  }
  return prisma.booking.findUnique({ where: { id } });
}

const travelersPayload = (name) => ({
  adults: 1, children: 0, infants: 0,
  phoneNumber: '+12025551234',
  location: 'New York, USA',
  details: [{ name, age: 30, ageGroup: 'adult' }],
});

(async () => {
  console.log('0) Register ' + EMAIL);
  let token;
  try {
    const reg = await api('POST', '/auth/register', { name: 'Kwarteon', email: EMAIL, password: PASSWORD });
    token = reg.data.accessToken;
    check('registered new user', !!token);
  } catch (err) {
    // Already exists from a prior run — log in with the known password.
    if (err.status === 409) {
      const login = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
      token = login.data.accessToken;
      check('logged in existing user', !!token);
    } else {
      throw err;
    }
  }

  console.log('1) Find a tour with two available dates');
  const tours = await api('GET', '/expedition/tours?limit=20');
  const list = tours.data?.tours || [];
  let tour = null;
  let dates = [];
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
    dates = (cal.data?.calendar || []).filter((d) => d.status === 'AVAILABLE' || d.status === 'LIMITED').map((d) => d.date);
    if (dates.length >= 2) {
      tour = t.tour;
      break;
    }
  }
  check('tour with 2 available dates', !!tour && dates.length >= 2, tour ? `${tour.slug}: ${dates[0]}, ${dates[1]}` : '');
  if (!tour || dates.length < 2) throw new Error('Need a tour with >=2 available dates');

  console.log('2) PAY-NOW booking on ' + dates[0]);
  const confNow = await api('POST', '/expedition/checkout/confirm', {
    tourId: tour.id,
    travelDate: dates[0],
    travelers: travelersPayload('PayNow Tester'),
    paymentTiming: 'now',
  }, token);
  const b1 = confNow.data.booking;
  const c1 = confNow.data.checkout;
  check('booking created', !!b1.id, `#${b1.bookingNumber}`);
  check('checkout session returned', !!c1?.url, c1?.id);

  // Simulate the hosted Checkout page: charge the session's card.
  const pi1 = await stripe.paymentIntents.create({
    amount: Math.round(Number(b1.total) * 100),
    currency: b1.currency,
    confirm: false,
    metadata: { bookingIds: b1.id, source: 'expedition', checkout: c1.id },
  });
  const paid1 = await stripe.paymentIntents.confirm(pi1.id, {
    payment_method: 'pm_card_visa',
    return_url: `http://localhost:5173/booking/confirmation/${b1.id}`,
  });
  check('pay-now card charged', paid1.status === 'succeeded');

  const session1 = await stripe.checkout.sessions.retrieve(c1.id);
  const ev1 = {
    id: `evt_live_paynow_${Date.now()}`, object: 'event', api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000), livemode: false, pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'checkout.session.completed',
    data: { object: { ...session1, payment_intent: pi1.id } },
  };
  const wh1 = await postSignedWebhook(ev1);
  check('webhook accepted', wh1.status === 200, `HTTP ${wh1.status}`);

  const f1 = await waitForBooking(b1.id, 'CONFIRMED');
  check('pay-now booking CONFIRMED', f1.status === 'CONFIRMED', `${f1.status}/${f1.paymentStatus}`);

  console.log('3) PAY-LATER booking on ' + dates[1] + ' (card captured, NOT charged)');
  const confLater = await api('POST', '/expedition/checkout/confirm', {
    tourId: tour.id,
    travelDate: dates[1],
    travelers: travelersPayload('PayLater Tester'),
    paymentMethodId: 'pm_card_visa',
    paymentTiming: 'later',
  }, token);
  const b2 = confLater.data.booking;
  check('booking created', !!b2.id, `#${b2.bookingNumber}`);
  check('reserved PENDING (not charged)', b2.status === 'PENDING' && b2.paymentStatus === 'PENDING');
  const pi2Id = b2.stripePaymentIntentId;
  const pi2 = await stripe.paymentIntents.retrieve(pi2Id);
  check('PI attached + uncharged', !!pi2Id && pi2.amount_received === 0, `amount_received=${pi2.amount_received}`);

  console.log('4) Simulate the deferred charge (what payLaterSweep does)…');
  const charged2 = await stripe.paymentIntents.confirm(pi2Id, {
    return_url: `http://localhost:5173/booking/complete`,
  });
  check('pay-later card now charged', charged2.status === 'succeeded', charged2.status);

  const f2 = await waitForBooking(b2.id, 'CONFIRMED');
  check('pay-later booking CONFIRMED after charge', f2.status === 'CONFIRMED', `${f2.status}/${f2.paymentStatus}`);

  console.log('\nSUMMARY — expect emails at ' + EMAIL);
  console.log(`  Pay now     #${b1.bookingNumber} (${f1.total} ${f1.currency})  -> "Booking Confirmed" email`);
  console.log(`  Pay later   #${b2.bookingNumber} (${f2.total} ${f2.currency})  -> "Reserve now, pay later" email on reserve`);
  console.log(`                              -> then "Payment collected — booking confirmed" email once charged`);
  console.log(`  (booking numbers are searchable in your account; test card 4242 was used, charges were test-mode)`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED — check your inbox (allow ~30s for email delivery).');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nE2E FAILED:', err.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});