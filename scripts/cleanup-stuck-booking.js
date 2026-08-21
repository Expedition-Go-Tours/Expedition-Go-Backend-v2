/* One-off cleanup for the stuck expedition booking:
   booking cmt1aex1m0003wq8cmsxj4x7s / PI pi_3U6Rn2CgYMgEuT2o0Utebr84.

   Verified (remote Neon): status PENDING, paymentStatus PENDING, pay-now,
   stripeCheckoutSessionId null, paidAt null, amount never received on Stripe.
   The PaymentIntent sits at requires_confirmation — a charge can never land.

   This script:
     1. Re-reads the booking and refuses to run if it's no longer stale.
     2. Asks Stripe for the authoritative PaymentIntent state and aborts if the
        charge actually succeeded (money taken → do NOT cancel).
     3. Cancels the abandoned PaymentIntent (best-effort) and expires the
        booking through the app's own expireBooking() path, which fires the
        standard cancellation notification / event / audit and releases
        capacity atomically.

   Run against the remote DB:
     $env:DATABASE_URL='postgresql://<remote-connection-url>?sslmode=require'
     node scripts/cleanup-stuck-booking.js
*/
const { getStripe } = require('../utils/stripeHelpers');
const { expireBooking } = require('../utils/bookingCleanup');
const prisma = require('../utils/prismaClient');

const BOOKING_ID = 'cmt1aex1m0003wq8cmsxj4x7s';
const REASON = 'Payment was never completed (one-off cleanup of abandoned Checkout)';

(async () => {
  const booking = await prisma.booking.findUnique({
    where: { id: BOOKING_ID },
    include: { tour: { select: { title: true } } },
  });

  if (!booking) {
    console.log(`Booking ${BOOKING_ID} not found. Nothing to do.`);
    process.exit(0);
  }

  console.log(`Booking ${BOOKING_ID}: ${booking.status}/${booking.paymentStatus} (PI ${booking.stripePaymentIntentId || 'none'})`);

  if (booking.status !== 'PENDING' || !['PENDING', 'PROCESSING'].includes(booking.paymentStatus)) {
    console.log('Booking is no longer stale — skipping. Nothing was changed.');
    process.exit(0);
  }

  let intentState = 'none';
  if (booking.stripePaymentIntentId) {
    try {
      const intent = await getStripe().paymentIntents.retrieve(booking.stripePaymentIntentId);
      intentState = intent.status;
      console.log(`Stripe PI state: ${intent.status} (amount_received ${intent.amount_received})`);
      if (intent.status === 'succeeded' || intent.amount_received > 0) {
        console.log('MONEY WAS TAKEN — aborting without cancelling the booking.');
        process.exit(1);
      }
      if (intent.status === 'requires_confirmation') {
        try {
          await getStripe().paymentIntents.cancel(booking.stripePaymentIntentId);
          console.log('PaymentIntent cancelled so no charge can ever land.');
        } catch (e) {
          console.log(`PI cancel not possible (non-fatal): ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`PI retrieve failed (continuing with DB state): ${e.message}`);
    }
  }

  const cancelled = await expireBooking(booking, REASON);
  console.log(`Booking ${BOOKING_ID} → cancelled: ${cancelled} (PI state: ${intentState})`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('Cleanup failed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});