/* Probe: the expiry sweep's PayPal branch.
 *
 * A PayPal hold that is never approved must be released (seats freed), and a
 * PayPal hold that IS captured but expired must be settled instead — the
 * capture is the customer's money. This exercises the first of those two
 * against the real PayPal API, using a draft whose expiry has been pulled into
 * the past.
 *
 * Run: npm run probe:paypal-hold-sweep
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { expireCheckoutHolds } = require('../src/core/services/bookingCleanup');
const { getOrder } = require('../src/core/services/payments/paypalPayments');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://localhost:5001/api${p}`, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 200)}`);
  return json;
}

async function main() {
  const state = JSON.parse(require('fs').readFileSync(
    require('path').join(require('os').tmpdir(), 'paypal-e2e-state.json'), 'utf8'
  ));

  // A fresh hold, so the probe never disturbs the order that is waiting to be
  // approved for the capture test.
  const tours = await api('GET', '/expedition/tours?limit=50', null, state.token);
  const slug = (tours.data?.tours || []).find((t) => t.tour?.slug === 'cape-coast-castle-day-trip')?.tour?.slug
    || tours.data?.tours?.[0]?.tour?.slug;
  const cal = await api('GET', `/expedition/tours/${slug}/availability?startDate=2026-11-05&endDate=2026-11-30`, null, state.token);
  const day = (cal.data?.calendar || []).find((d) => d.status === 'AVAILABLE' || d.status === 'LIMITED');
  check('found an available date for the probe hold', !!day, day?.date);

  const started = await api('POST', '/expedition/checkout/confirm', {
    tourId: tours.data.tours.find((t) => t.tour.slug === slug).tour.id,
    travelDate: day.date,
    travelers: { adults: 1, children: 0, infants: 0, phoneNumber: '+12025551234', location: 'Accra, Ghana' },
    paymentTiming: 'now',
    paymentProvider: 'paypal',
  }, state.token);
  const { draftId, orderId } = started.data.payment;
  check('probe hold created', !!draftId && !!orderId, `${draftId} / ${orderId}`);

  // Keep the pending order alive as a control: the sweep must leave it alone.
  const control = await prisma.checkoutDraft.findUnique({ where: { id: state.draftId } });

  // Age the probe hold past the sweep's grace window (30 + 10 minutes).
  await prisma.checkoutDraft.update({
    where: { id: draftId },
    data: { expiresAt: new Date(Date.now() - 45 * 60 * 1000) },
  });

  const result = await expireCheckoutHolds();

  const probe = await prisma.checkoutDraft.findUnique({ where: { id: draftId } });
  check('sweep released the unapproved PayPal hold', probe?.status === 'EXPIRED', probe?.status);
  check('sweep reported it as released', (result.released || 0) >= 1, JSON.stringify(result));

  const bookings = await prisma.booking.count({ where: { paypalOrderId: orderId } });
  check('no booking was created for an unapproved order', bookings === 0, `count=${bookings}`);

  const after = await prisma.checkoutDraft.findUnique({ where: { id: state.draftId } });
  check('a fresh PayPal hold is left untouched',
    !control || after?.status === control?.status,
    `${control?.status} → ${after?.status}`);

  const stillOrder = await getOrder(orderId).catch((e) => ({ error: e.message }));
  check('the order itself is still readable (nothing cancelled on PayPal)',
    !!stillOrder.order, stillOrder.order?.status || stillOrder.error);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  return failures;
}

main()
  .then((f) => prisma.$disconnect().then(() => process.exit(f ? 1 : 0)))
  .catch(async (err) => {
    console.error('ERROR', err.message);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
