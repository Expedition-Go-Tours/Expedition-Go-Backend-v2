/* Verify the Pay-Now step end-to-end without a browser:
   creates a real Stripe Checkout Session via the app's own helper with the
   configured (valid) test key, then confirms the redirect URL is correct.

   Requires CLIENT_URL to be set to the local frontend for a useful check:
     $env:CLIENT_URL='http://localhost:5173'
     node scripts/verify-checkout-e2e.js
*/
const { getStripe, createCheckoutSession } = require('../utils/stripeHelpers');

(async () => {
  const bookingId = 'verify-checkout-e2e';
  const session = await createCheckoutSession({
    amount: 19200,
    currency: 'USD',
    bookingId,
    tourTitle: 'E2E Verify Tour',
    customerEmail: 'e2e@verify.test',
  });

  console.log('Created Checkout Session:');
  console.log('  id      :', session.id);
  console.log('  mode    :', session.mode);
  console.log('  status  :', session.status);
  console.log('  metadata:', JSON.stringify(session.metadata));

  const okUrl = session.url || '';
  const hasLocalhost = okUrl.startsWith('https://checkout.stripe.com/');
  console.log('  url     :', okUrl ? `${okUrl.slice(0, 60)}...` : '(none)');

  // Verify the redirect target the customer returns to after payment.
  const clientUrl = process.env.CLIENT_URL || '(unset)';
  console.log('  CLIENT_URL :', clientUrl);
  console.log('  success_url:', session.success_url);

  const checks = {
    'session created': !!session.id,
    'mode=payment': session.mode === 'payment',
    'stripe hosted URL present': hasLocalhost,
    'metadata carries bookingIds': session.metadata?.bookingIds === bookingId,
    'success_url points at local frontend': clientUrl.includes('localhost') && session.success_url.includes(clientUrl) && session.success_url.includes('/booking/confirmation/' + bookingId),
  };

  let pass = true;
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) pass = false;
  }

  // Clean up: expire the throwaway session so it can't hang around.
  try {
    const expired = await getStripe().checkout.sessions.expire(session.id);
    console.log('  cleaned up test session →', expired.status);
  } catch (e) {
    console.log('  cleanup note:', e.message);
  }

  if (!pass) process.exit(1);
  console.log('ALL CHECKS PASSED — Pay-now redirect is ready for the browser test.');
})().catch((err) => {
  console.error('VERIFICATION FAILED:', err.message);
  process.exit(1);
});