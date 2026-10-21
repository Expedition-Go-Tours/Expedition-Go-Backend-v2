/* End-to-end test of customer self-service booking edits (Expedition brand).

   Covers the two flows the storefront exposes on /dashboard/bookings:
     1. Pickup change      PATCH /expedition/bookings/:id/pickup
     2. Date/time/party    POST  /expedition/bookings/:id/modify/quote
                           PATCH /expedition/bookings/:id/modify
                           POST  /expedition/bookings/:id/modify/:changeId/discard

   1. Register a throwaway customer (real JWT).
   2. Pick an Expedition tour + a future AVAILABLE date; book it reserve-now-
      pay-later (card token captured, nothing charged).
   3. Exercise pickup edits: area by address, named area, "arrange later",
      out-of-zone handling, and a tour with no pickup config.
   4. Exercise party-size and date modifications: quote -> apply, assert the
      ledger row, re-priced totals and reserved PaymentIntent amount.
   5. Verify the booking detail API reflects every edit.
   6. Cleanup: cancel the booking (voids the PI).

   Env:
     E2E_API_BASE            default http://localhost:5001
     STRIPE_SECRET_KEY       falls back to Backendv2/.env (must be sk_test_*)
     E2E_KEEP_BOOKING=1      keep the booking + write credentials to
                             $TMPDIR/lite-booking-edit-fixture.json (UI tests)
*/
const path = require('path');
const fs = require('fs');

const BASE = process.env.E2E_API_BASE || 'http://localhost:5001';
const API = `${BASE}/api`;

function loadDotenvKey(name) {
  const p = path.join(__dirname, '..', '.env');
  const txt = fs.readFileSync(p, 'utf8');
  const m = txt.match(new RegExp(`^${name}=(.+)$`, 'm'));
  if (!m) throw new Error(`${name} missing in ${p}`);
  return m[1].trim();
}

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || loadDotenvKey('STRIPE_SECRET_KEY');
if (!SECRET_KEY.startsWith('sk_test_')) {
  console.error('REFUSING TO RUN: STRIPE_SECRET_KEY is not a test key');
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
  for (let attempt = 0; attempt < 6; attempt++) {
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
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

const addDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/**
 * The dev/CI seed ships tours without pricing or pickup configuration.
 * Provision both here so the edit flows run against a realistic tour:
 *  - cape-coast-castle-day-trip: priced + area pickup (radius + polygon)
 *  - kakum-canopy-walk-adventure: priced, deliberately NO pickup config
 */
async function ensureFixtures() {
  const fixturePickup = {
    pickupType: 'area',
    meetingMode: 'pickup',
    pickupAreas: [
      { name: 'Accra Central', time: '06:30', lat: 5.556, lng: -0.1969, radiusKm: 3 },
      {
        name: 'East Legon', time: '06:45', lat: 5.635, lng: -0.16, radiusKm: 8,
        polygon: [[5.61, -0.19], [5.66, -0.19], [5.66, -0.13], [5.61, -0.13]],
        // Draw a "no pickup" hole so the exclusion rule is exercised too.
        exclusions: [[[5.615, -0.175], [5.625, -0.175], [5.625, -0.165], [5.615, -0.165]]],
      },
    ],
  };
  const pricing = {
    currency: 'USD',
    schedules: [{
      name: 'Regular',
      startDate: '2026-01-01',
      hasEndDate: true,
      endDate: '2027-12-31',
      timeSlots: [],
      dateExceptions: [],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      prices: [
        { ageGroup: 'Adult', retailPrice: 89, ourPrice: 89 },
        { ageGroup: 'Child', retailPrice: 59, ourPrice: 59 },
        { ageGroup: 'Infant', retailPrice: 0, ourPrice: 0 },
      ],
    }],
  };
  const tours = await prisma.tour.findMany({
    where: { slug: { in: ['cape-coast-castle-day-trip', 'kakum-canopy-walk-adventure'] } },
    select: { id: true, slug: true, schedulesAndPricing: true, bookingAndTickets: true },
  });
  for (const t of tours) {
    const sp = (t.schedulesAndPricing && typeof t.schedulesAndPricing === 'object') ? t.schedulesAndPricing : {};
    const bt = (t.bookingAndTickets && typeof t.bookingAndTickets === 'object') ? t.bookingAndTickets : {};
    await prisma.tour.update({
      where: { id: t.id },
      data: {
        schedulesAndPricing: { ...sp, pricingSchedules: pricing },
        bookingAndTickets: t.slug === 'cape-coast-castle-day-trip' ? { ...bt, ...fixturePickup } : bt,
      },
    });
  }
  return tours.map((t) => t.slug);
}

async function findBookableTour(preferSlug) {
  const tours = await api('GET', '/expedition/tours?limit=50');
  const list = tours.data?.tours || [];
  const ordered = preferSlug
    ? [...list.filter((t) => t.tour?.slug === preferSlug), ...list.filter((t) => t.tour?.slug !== preferSlug)]
    : list;
  for (const t of ordered) {
    const slug = t.tour?.slug;
    const tourId = t.tour?.id;
    if (!slug || !tourId) continue;
    let cal;
    try {
      cal = await api('GET', `/expedition/tours/${slug}/availability?startDate=${addDays(3)}&endDate=${addDays(31)}`);
    } catch { continue; }
    const day = (cal.data?.calendar || []).find((d) => d.status === 'AVAILABLE' || d.status === 'LIMITED');
    if (day) return { tour: t.tour, travelDate: day.date };
  }
  return null;
}

(async () => {
  console.log('0) Provision tour fixtures (pricing + pickup config)');
  const slugs = await ensureFixtures();
  check('tour fixtures provisioned', slugs.length >= 1, slugs.join(', '));

  console.log('1) Register a throwaway customer');
  const email = `e2e-booking-edit-${Date.now()}@test.local`;
  const reg = await api('POST', '/auth/register', { name: 'E2E Booking Edit', email, password: 'e2e-password-123' });
  const token = reg.data.accessToken;
  check('customer registered + JWT issued', !!token);

  console.log('2) Find a bookable tour + date');
  const pick = await findBookableTour('cape-coast-castle-day-trip');
  check('found tour + available date', !!pick, pick ? `${pick.tour.slug} @ ${pick.travelDate}` : '');
  if (!pick) throw new Error('No bookable tour found');
  const { tour, travelDate } = pick;

  console.log('3) Create a reserve-now-pay-later booking (1 adult)');
  const conf = await api('POST', '/expedition/checkout/confirm', {
    tourId: tour.id,
    travelDate,
    travelers: { adults: 1, children: 0, infants: 0, phoneNumber: '+12025551234', location: 'Accra, Ghana' },
    paymentMethodId: 'pm_card_visa',
    paymentTiming: 'later',
  }, token);
  const booking = conf.data.booking;
  const bookingId = booking.id;
  check('booking created', !!bookingId, `#${booking.bookingNumber}`);
  check('booking PENDING / pay-later / uncharged',
    booking.status === 'PENDING' && booking.paymentTiming === 'later' && booking.paymentStatus === 'PENDING',
    `${booking.status}/${booking.paymentTiming}/${booking.paymentStatus}`);
  const piId = booking.stripePaymentIntentId;
  const piBefore = piId ? await stripe.paymentIntents.retrieve(piId) : null;
  check('reserved PaymentIntent exists', !!piId, piId || '');

  const dbBooking = () => prisma.booking.findUnique({ where: { id: bookingId } });

  console.log('4) Pickup edits');
  // 4a. Address inside the drawn "East Legon" polygon (no skipValidation)
  const r1 = await api('PATCH', `/expedition/bookings/${bookingId}/pickup`, {
    pickup: { mode: 'area', address: { name: 'East Legon', address: 'East Legon, Accra', lat: 5.635, lng: -0.16 } },
  }, token);
  let b = await dbBooking();
  check('4a inside-zone address accepted', !!r1?.data, JSON.stringify(r1?.data || {}).slice(0, 120));
  check('4a pickup persisted (polygon area + coords)',
    b.pickup && b.pickup.address && b.pickup.address.lat === 5.635 && b.pickup.areaName === 'East Legon',
    JSON.stringify(b.pickup || null).slice(0, 160));

  // 4a2. Address near a radius-only area (3 km around Accra Central)
  await api('PATCH', `/expedition/bookings/${bookingId}/pickup`, {
    pickup: { mode: 'area', address: { name: 'Accra', address: 'Accra, Ghana', lat: 5.56, lng: -0.19 } },
  }, token);
  b = await dbBooking();
  check('4a2 radius-only area matched', b.pickup?.areaName === 'Accra Central', JSON.stringify(b.pickup || null).slice(0, 120));

  // 4a3. Exclusion ring inside the polygon must be rejected even with skipValidation
  let exclStatus = 0;
  let exclBody = null;
  try {
    await api('PATCH', `/expedition/bookings/${bookingId}/pickup`, {
      pickup: { mode: 'area', skipValidation: true, address: { name: 'Hole', address: 'Hole', lat: 5.62, lng: -0.17 } },
    }, token);
    exclStatus = 200;
  } catch (e) { exclStatus = e.status; exclBody = e.body; }
  b = await dbBooking();
  check('4a3 exclusion zone rejected (skipValidation cannot override)',
    exclStatus === 400 && b.pickup?.areaName !== 'East Legon',
    `HTTP ${exclStatus} ${exclBody?.message || ''}`);

  // 4b. Named area, no coords
  await api('PATCH', `/expedition/bookings/${bookingId}/pickup`, {
    pickup: { mode: 'area', areaName: 'Accra Central' },
  }, token);
  b = await dbBooking();
  check('4b named area saved', b.pickup?.areaName === 'Accra Central', JSON.stringify(b.pickup || null).slice(0, 120));

  // 4c. "Arrange later" on a tour WITH pickup config
  await api('PATCH', `/expedition/bookings/${bookingId}/pickup`, { pickup: { skipValidation: true } }, token);
  b = await dbBooking();
  check('4c arrange-later saved as deferred',
    b.pickup?.pickupLater === true && b.pickup?.status === 'deferred',
    JSON.stringify(b.pickup || null).slice(0, 120));

  // 4d. Out-of-zone address WITH skipValidation (client's "outside" path)
  const r4d = await api('PATCH', `/expedition/bookings/${bookingId}/pickup`, {
    pickup: { mode: 'area', skipValidation: true, address: { name: 'New York', address: 'New York, USA', lat: 40.7128, lng: -74.006 } },
  }, token);
  console.log('  4d response:', JSON.stringify(r4d).slice(0, 300));
  b = await dbBooking();
  check('4d out-of-zone + skipValidation stored deferred with address',
    b.pickup?.pickupLater === true && b.pickup?.address?.lat === 40.7128,
    JSON.stringify(b.pickup || null).slice(0, 160));

  // 4e. Out-of-zone address WITHOUT skipValidation (raw API caller): the
  // documented behaviour is graceful degradation to a deferred snapshot, so a
  // booking is never blocked by a stale/unknown geofence.
  const res4e = await fetch(`${API}/expedition/bookings/${bookingId}/pickup`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pickup: { mode: 'area', address: { name: 'New York', address: 'New York, USA', lat: 40.7128, lng: -74.006 } } }),
  });
  b = await dbBooking();
  check('4e out-of-zone without skipValidation degrades to deferred',
    res4e.status === 200 && b.pickup?.status === 'deferred',
    `HTTP ${res4e.status} -> ${JSON.stringify(b.pickup || null).slice(0, 140)}`);

  // 4f. Tour with NO pickup config: arrange-later must still work
  const noCfg = await findBookableTour('kakum-canopy-walk-adventure');
  if (noCfg) {
    const conf2 = await api('POST', '/expedition/checkout/confirm', {
      tourId: noCfg.tour.id,
      travelDate: noCfg.travelDate,
      travelers: { adults: 1, children: 0, infants: 0, phoneNumber: '+12025551234', location: 'Accra, Ghana' },
      paymentMethodId: 'pm_card_visa',
      paymentTiming: 'later',
    }, token);
    const b2 = conf2.data.booking;
    let arrange = { status: 'skipped' };
    try {
      await api('PATCH', `/expedition/bookings/${b2.id}/pickup`, { pickup: { skipValidation: true } }, token);
      arrange = { status: 'ok' };
    } catch (e) { arrange = { status: 'error', code: e.status, message: e.body?.message }; }
    const row = await prisma.booking.findUnique({ where: { id: b2.id } });
    check('4f no-pickup-config tour: arrange-later accepted',
      arrange.status === 'ok' && row.pickup?.pickupLater === true,
      JSON.stringify({ http: arrange, pickup: row.pickup }).slice(0, 200));
    try { await api('PATCH', `/expedition/bookings/${b2.id}/cancel`, { reason: 'E2E cleanup' }, token); } catch {}
  } else {
    console.log('  (skipped 4f — no second bookable tour)');
  }

  console.log('5) Party-size modification (pay-later re-price)');
  const q1 = await api('POST', `/expedition/bookings/${bookingId}/modify/quote`, { travelers: { adults: 2 } }, token);
  const quote = q1.data?.quote || q1.data;
  check('quote returned for adults 1->2', !!quote, JSON.stringify(quote).slice(0, 200));

  const applied = await api('PATCH', `/expedition/bookings/${bookingId}/modify`, { travelers: { adults: 2 } }, token);
  const outcome = applied.data?.status || applied.data?.result || 'unknown';
  b = await dbBooking();
  check('party change applied', ['APPLIED', 'applied'].includes(String(outcome).toLowerCase()) || b.travelers?.adults === 2,
    `${outcome}`);
  check('travelers.adults now 2', b.travelers?.adults === 2, JSON.stringify(b.travelers));
  check('grossAmount re-priced upward', Number(b.grossAmount) > Number(booking.grossAmount),
    `${booking.grossAmount} -> ${b.grossAmount}`);
  const changes = await prisma.bookingChange.findMany({ where: { bookingId }, orderBy: { createdAt: 'desc' } });
  check('BookingChange ledger row written', changes.length >= 1, changes[0] ? `${changes[0].kind}/${changes[0].status}` : 'none');
  if (piId) {
    const piAfter = await stripe.paymentIntents.retrieve(piId);
    check('reserved PI re-priced to new total', piAfter.amount === Math.round(Number(b.grossAmount) * 100),
      `${piBefore?.amount} -> ${piAfter.amount} (booking ${b.grossAmount})`);
  }

  console.log('6) Date modification');
  const q2 = await api('POST', `/expedition/bookings/${bookingId}/modify/quote`, { travelDate: addDays(9) }, token);
  check('quote returned for date change', !!(q2.data?.quote || q2.data), JSON.stringify(q2.data).slice(0, 160));
  try {
    const applied2 = await api('PATCH', `/expedition/bookings/${bookingId}/modify`, { travelDate: addDays(9) }, token);
    b = await dbBooking();
    check('date change applied', new Date(b.travelDate).toISOString().slice(0, 10) === addDays(9),
      `${new Date(b.travelDate).toISOString().slice(0, 10)} (wanted ${addDays(9)})`);
  } catch (e) {
    check('date change applied', false, `HTTP ${e.status}: ${e.body?.message || e.message}`);
  }

  console.log('7) Validation guards');
  try {
    await api('PATCH', `/expedition/bookings/${bookingId}/modify`, {}, token);
    check('empty modify rejected', false, 'expected 400');
  } catch (e) {
    check('empty modify rejected', e.status === 400, `HTTP ${e.status}`);
  }
  try {
    await api('POST', `/expedition/bookings/${bookingId}/modify/quote`, { travelDate: '2020-01-01' }, token);
    check('past-date quote rejected', false, 'expected 4xx');
  } catch (e) {
    check('past-date quote rejected', e.status >= 400 && e.status < 500, `HTTP ${e.status}`);
  }

  console.log('8) Booking detail reflects the edits');
  const detail = await api('GET', `/expedition/bookings/${bookingId}`, null, token);
  const d = detail.data?.booking || detail.data;
  check('detail travellers = 2 adults', d?.travelers?.adults === 2, JSON.stringify(d?.travelers));
  check('detail pickup present', !!d?.pickup, JSON.stringify(d?.pickup || null).slice(0, 120));
  check('detail exposes modify policy', !!d?.modify && typeof d.modify.allowed === 'boolean',
    JSON.stringify(d?.modify || null).slice(0, 120));

  console.log('9) Cleanup');
  if (process.env.E2E_KEEP_BOOKING === '1') {
    const os = require('os');
    const fixturePath = path.join(os.tmpdir(), 'lite-booking-edit-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      email,
      password: 'e2e-password-123',
      bookingId,
      bookingNumber: booking.bookingNumber,
      tourSlug: tour.slug,
      status: 'PENDING',
      paymentTiming: 'later',
    }, null, 2));
    console.log(`  keeping booking ${bookingId} for UI tests -> ${fixturePath}`);
  } else {
    try {
      await api('PATCH', `/expedition/bookings/${bookingId}/cancel`, { reason: 'E2E booking-edit cleanup' }, token);
      const after = await dbBooking();
      console.log(`  cleanup: booking now ${after.status}/${after.paymentStatus}`);
    } catch (err) {
      console.log(`  cleanup skipped: ${err.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED — booking edits work end-to-end.');
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nE2E FAILED:', err.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
