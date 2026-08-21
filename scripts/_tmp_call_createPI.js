const fs = require('fs');
const dotenv = fs.readFileSync('.env', 'utf8');
const key = dotenv.match(/^STRIPE_SECRET_KEY=(.+)$/m)[1].trim();
process.env.STRIPE_SECRET_KEY = key;
process.env.CLIENT_URL = 'http://localhost:5173';
const { createPaymentIntent } = require('../utils/stripeHelpers');

(async () => {
  const result = await createPaymentIntent({
    amount: 7400,
    currency: 'USD',
    customerId: 'cus_V6gj1KphwzIaeh',
    paymentMethodId: 'pm_card_visa',
    confirm: false,
    metadata: {
      customerId: 'cmt1e0b3s0000n59rhwx1wrpd',
      tourId: 'cmsolbd7d000fbojck801hkwh',
      source: 'expedition',
      paymentTiming: 'later',
      travelDate: '2026-08-24',
    },
  });
  console.log('createPaymentIntent returned status:', result.status, 'id:', result.id);
  const live = await result._request ? null : (require('stripe'))(key, { apiVersion: '2025-02-24.acacia' }).paymentIntents.retrieve(result.id);
  console.log('live status:', live.status);
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });