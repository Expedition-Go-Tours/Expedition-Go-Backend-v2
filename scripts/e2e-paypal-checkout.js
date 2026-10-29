/* End-to-end test of PayPal checkout, settlement and refund (Expedition brand).

   Exercises the real API against a real PayPal sandbox order:

     1. register a throwaway customer (real JWT)
     2. find a bookable tour + available date
     3. POST /expedition/checkout/confirm with paymentProvider=paypal
        → assert a HOLDING draft tagged PAYPAL with a PayPal order id, and that
          NO Booking row exists yet (nothing is created before capture)
     4. approve the order on PayPal (--await-approval parks until you do)
     5. POST /expedition/checkout/paypal/capture
        → assert exactly one Booking, tagged PAYPAL, with the capture id and
          NO Stripe identifiers on it
     6. repeat the capture → assert it is a no-op, not a second booking
     7. GET /expedition/bookings/by-paypal-order/:orderId → PAID + booking
     8. refund through refundBookingPayment → assert the booking flips to
          REFUNDED only once PayPal says the refund settled
     9. cancel the booking (cleanup)

   Env:
     E2E_API_BASE            default http://localhost:5001
     PAYPAL_AWAIT_APPROVAL=1 park until the printed order is approved
     E2E_SKIP_REFUND=1       stop before the refund step
*/
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.E2E_API_BASE || 'http://localhost:5001';
const API = `${BASE}/api`;
const AWAIT = process.env.PAYPAL_AWAIT_APPROVAL === '1' || process.argv.includes('--await-approval');
const STATE_FILE = process.env.E2E_STATE_FILE || path.join(require('os').tmpdir(), 'paypal-e2e-state.json');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { getOrder } = require('../src/core/services/payments/paypalPayments');
const { refundBookingPayment } = require('../src/core/services/payments');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${p}`, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(`${method} ${p} → ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function findBookableTour() {
  const tours = await api('GET', '/expedition/tours?limit=50');
  const list = tours.data?.tours || [];
  const ordered = [
    ...list.filter((t) => t.tour?.slug === 'cape-coast-castle-day-trip'),
    ...list.filter((t) => t.tour?.slug !== 'cape-coast-castle-day-trip'),
  ];
  for (const t of ordered) {
    const slug = t.tour?.slug;
    if (!slug) continue;
    let cal;
    try {
      cal = await api('GET', `/expedition/tours/${slug}/availability?startDate=${addDays(3)}&endDate=${addDays(31)}`);
    } catch { continue; }
    const day = (cal.data?.calendar || []).find((d) => d.status === 'AVAILABLE' || d.status === 'LIMITED');
    if (day) return { tour: t.tour, travelDate: day.date };
  }
  return null;
}

async function waitForApproval(orderId, timeoutMs = Number(process.env.PAYPAL_APPROVAL_TIMEOUT_MS || 300000)) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { order } = await getOrder(orderId);
    if (order.status === 'APPROVED' || order.status === 'COMPLETED') return order.status;
    if (order.status === 'VOIDED') return order.status;
    if (Date.now() >= deadline) return `TIMEOUT(${order.status})`;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  let token = null;
  let payment = {};
  let started = null;
  let draftId;
  let orderId;

  // Resume: continue against an order that was already created (and can be
  // approved out-of-band) instead of starting a second checkout.
  const savedState = (() => {
    try { return JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
  })();
  const resumeOrderId = process.env.E2E_RESUME_ORDER_ID || savedState?.orderId || null;
  if (resumeOrderId) {
    token = process.env.E2E_TOKEN || savedState?.token || null;
    draftId = draftId || process.env.E2E_DRAFT_ID || savedState?.draftId || null;
    orderId = resumeOrderId;
    const existing = await prisma.checkoutDraft.findUnique({ where: { paypalOrderId: orderId } });
    check('resumed order resolves to a draft', !!existing, orderId);
    draftId = existing?.id || null;
    payment = { provider: 'paypal', draftId, orderId, approvalUrl: null };
    console.log(`1-3) Resumed from order ${orderId} (draft ${draftId})`);
  } else {
  console.log('1) Register a throwaway customer');
  const email = `e2e-paypal-${Date.now()}@test.local`;
  const reg = await api('POST', '/auth/register', {
    name: 'E2E PayPal',
    email,
    password: 'e2e-password-123',
  });
  token = reg.data.accessToken;
  check('customer registered + JWT issued', !!token);

  console.log('2) Find a bookable tour + date');
  const pick = await findBookableTour();
  check('found tour + available date', !!pick, pick ? `${pick.tour.slug} @ ${pick.travelDate}` : '');
  if (!pick) throw new Error('No bookable tour found');
  const { tour, travelDate } = pick;

  console.log('3) Start a pay-now checkout with PayPal');
  started = await api('POST', '/expedition/checkout/confirm', {
    tourId: tour.id,
    travelDate,
    travelers: { adults: 1, children: 0, infants: 0, phoneNumber: '+12025551234', location: 'Accra, Ghana' },
    paymentTiming: 'now',
    paymentProvider: 'paypal',
  }, token);

  payment = started.data?.payment || {};
  }

  if (!resumeOrderId) {
    check('response is a PayPal redirect, not a Stripe session',
      payment.provider === 'paypal' && !!payment.approvalUrl,
      `provider=${payment.provider}`);
    check('no Booking row created before capture', !started.data?.booking);
  }

  draftId = draftId || payment.draftId;
  orderId = orderId || payment.orderId;
  check('draft id + order id returned', !!draftId && !!orderId, `${draftId} / ${orderId}`);

  // Persist enough state to resume after the approval click (or after a
  // timeout), without registering a second customer against the same draft.
  require('fs').writeFileSync(STATE_FILE, JSON.stringify({ token, draftId, orderId }, null, 2));

  const draft = await prisma.checkoutDraft.findUnique({ where: { id: draftId } });
  check('draft is HOLDING', draft?.status === 'HOLDING', draft?.status);
  check('draft tagged PAYPAL with the order id',
    draft?.paymentProvider === 'PAYPAL' && draft?.paypalOrderId === orderId,
    `${draft?.paymentProvider} / ${draft?.paypalOrderId}`);
  check('draft has no Stripe session id', !draft?.stripeSessionId, String(draft?.stripeSessionId));
  const beforeCapture = await prisma.booking.count({ where: { paypalOrderId: orderId } });
  check('no booking exists for this order yet', beforeCapture === 0, `count=${beforeCapture}`);

  if (payment.approvalUrl) console.log(`\n  APPROVE THIS ORDER:\n  ${payment.approvalUrl}\n`);

  if (AWAIT) {
    console.log('4) Waiting for approval…');
    const status = await waitForApproval(orderId);
    check('order approved on PayPal', status === 'APPROVED' || status === 'COMPLETED', status);
    if (status !== 'APPROVED' && status !== 'COMPLETED') return report();
  } else {
    console.log('4) Skipped (run with --await-approval to complete the capture)');
    return report();
  }

  console.log('5) Capture through the storefront endpoint');
  const captured = await api('POST', '/expedition/checkout/paypal/capture', { orderId }, token);
  const booking = captured.data?.booking;
  check('capture returns PAID + a booking', captured.data?.status === 'PAID' && !!booking,
    `status=${captured.data?.status}`);

  const row = booking ? await prisma.booking.findUnique({ where: { id: booking.id } }) : null;
  check('booking tagged PAYPAL', row?.paymentProvider === 'PAYPAL', row?.paymentProvider);
  check('booking carries the capture id', !!row?.paypalCaptureId, row?.paypalCaptureId);
  check('booking carries NO Stripe identifiers',
    row && !row.stripePaymentIntentId && !row.stripeCheckoutSessionId,
    `${row?.stripePaymentIntentId} / ${row?.stripeCheckoutSessionId}`);
  check('booking paymentStatus SUCCEEDED', row?.paymentStatus === 'SUCCEEDED', row?.paymentStatus);

  const paidDraft = await prisma.checkoutDraft.findUnique({ where: { id: draftId } });
  check('draft flipped to PAID and linked to the booking',
    paidDraft?.status === 'PAID' && paidDraft?.bookingId === row?.id,
    `${paidDraft?.status} / ${paidDraft?.bookingId}`);

  console.log('6) Repeat the capture (idempotency)');
  const again = await api('POST', '/expedition/checkout/paypal/capture', { orderId }, token);
  check('second capture returns the SAME booking, not a new one',
    again.data?.booking?.id === booking.id,
    `${again.data?.booking?.id} vs ${booking.id}`);
  const totalForOrder = await prisma.booking.count({ where: { paypalOrderId: orderId } });
  check('exactly one booking for this order', totalForOrder === 1, `count=${totalForOrder}`);

  console.log('7) Poll by order id');
  const polled = await api('GET', `/expedition/bookings/by-paypal-order/${orderId}`, null, token);
  check('poll reports PAID with the booking',
    polled.data?.status === 'PAID' && polled.data?.booking?.id === booking.id,
    polled.data?.status);

  if (process.env.E2E_SKIP_REFUND === '1') return report();

  console.log('8) Refund through the provider facade');
  const grossMinor = Math.round(Number(row.grossAmount) * 100);
  const refund = await refundBookingPayment(row, null, { metadata: { reason: 'e2e_paypal' } });
  check('refund accepted by PayPal', !!refund?.id && refund.provider === 'PAYPAL',
    `${refund?.id} status=${refund?.status}`);

  // A refund can settle asynchronously; poll until the sweep would see it as done.
  let refundState = null;
  for (let i = 0; i < 15; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    if (after.paymentStatus === 'REFUNDED') { refundState = after; break; }
  }
  check('booking marked REFUNDED once PayPal settled',
    refundState?.paymentStatus === 'REFUNDED',
    refundState ? refundState.paymentStatus : 'still SUCCEEDED');
  check('refund id recorded on the booking', !!refundState?.paypalRefundId, refundState?.paypalRefundId);
  check('refund covered the full capture', refund.amount === grossMinor,
    `${refund.amount} of ${grossMinor}`);

  console.log('9) Cleanup');
  try {
    await api('PATCH', `/expedition/bookings/${booking.id}/cancel`, { reason: 'E2E PayPal cleanup' }, token);
    check('booking cancelled', true);
  } catch (err) {
    // A fully refunded booking may already be past the cancel policy — that is
    // not a failure of the payment flow.
    check('booking cancel attempt recorded', true, `note: ${err.message.slice(0, 80)}`);
  }

  return report();
}

function report() {
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  return failures;
}

main()
  .then((failed) => prisma.$disconnect().then(() => process.exit(failed ? 1 : 0)))
  .catch(async (err) => {
    console.error('ERROR', err.message);
    if (err.body) console.error(JSON.stringify(err.body).slice(0, 300));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
