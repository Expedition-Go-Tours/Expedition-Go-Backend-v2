const fs = require('fs');
const crypto = require('crypto');
const dotenv = fs.readFileSync('.env', 'utf8');
const key = dotenv.match(/^STRIPE_SECRET_KEY=(.+)$/m)[1].trim();
const Stripe = require('stripe');
const stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' });

const canonicalStringify = (obj) => JSON.stringify(Object.keys(obj).sort().reduce((acc, k) => {
  const v = obj[k];
  acc[k] = (v && typeof v === 'object') ? canonicalStringify(v) : v;
  return acc;
}, {}));

(async () => {
  const amount = 7400;
  const currency = 'usd';
  const customer = 'cus_V6gj1KphwzIaeh';
  const paymentMethodId = 'pm_card_visa';
  const metadata = {
    customerId: 'cmt1e0b3s0000n59rhwx1wrpd',
    tourId: 'cmsolbd7d000fbojck801hkwh',
    source: 'expedition',
    paymentTiming: 'later',
    travelDate: '2026-08-24',
  };
  const data1 = {
    amount, currency, payment_method: paymentMethodId,
    confirmation_method: 'manual', confirm: false, customer, metadata,
  };
  const ik1 = 'pi-create:' + crypto.createHash('sha256').update(canonicalStringify(data1)).digest('hex');

  const pi1 = await stripe.paymentIntents.create(data1, { idempotencyKey: ik1 });
  console.log('first call status:', pi1.status, 'id:', pi1.id, 'created:', new Date(pi1.created * 1000).toISOString());

  if (pi1.status !== 'requires_confirmation') {
    const pi2 = await stripe.paymentIntents.create({ ...data1 }, { idempotencyKey: 'paylater:' + crypto.randomUUID() });
    console.log('recreate status:', pi2.status, 'id:', pi2.id, 'created:', new Date(pi2.created * 1000).toISOString());
    if (pi2.status === 'requires_confirmation') await stripe.paymentIntents.cancel(pi2.id).then((c) => console.log('cancelled test PI', c.id));
  } else {
    console.log('fresh PI, no recreate needed');
    await stripe.paymentIntents.cancel(pi1.id).then((c) => console.log('cancelled fresh test PI', c.id));
  }
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });