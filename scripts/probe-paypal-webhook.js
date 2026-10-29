/* PayPal webhook mount probe.
 *
 * Verifies the HTTP wiring that unit tests cannot see: that the raw body
 * survives to the verifier. If someone ever moves `express.json()` above this
 * path, or drops the `express.raw()` mount, the handler answers 500 with
 * "raw body required" and this probe fails.
 *
 * It makes one real call to PayPal's verification API per forged delivery.
 * PayPal answers FAILURE for a forged signature (the point of the test), and
 * an unreachable API answers 400 too — either way the assertion is about *routing*, never about the verdict.
 *
 * Run: npm run probe:paypal:webhook
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const request = require('supertest');

const app = require('../app');

const EVENT = {
  id: `WH-PROBE-${Date.now()}`,
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: {
    id: 'CAP-PROBE-1',
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: '1.00' },
    supplemental_data: { related_ids: { order_id: 'ORDER-PROBE-1' } },
  },
};

const HEADERS = {
  'paypal-transmission-id': `probe-${Date.now()}`,
  'paypal-transmission-time': new Date().toISOString(),
  'paypal-transmission-sig': 'forged-signature',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
  'paypal-auth-algo': 'SHA256withRSA',
  'content-type': 'application/json',
};

async function main() {
  const cases = [];

  const forged = await request(app).post('/api/webhooks/paypal').set(HEADERS).send(EVENT);
  cases.push([
    'forged delivery is refused with 400 (never 5xx, never 200)',
    forged.status === 400,
    `status=${forged.status}`,
  ]);
  cases.push([
    'refusal is the signature gate, not a parsing failure',
    /Invalid webhook signature/.test(forged.text || ''),
    forged.text || '',
  ]);

  const noHeaders = await request(app)
    .post('/api/webhooks/paypal')
    .set({ 'content-type': 'application/json' })
    .send(EVENT);
  cases.push([
    'delivery without transmission headers is refused',
    noHeaders.status === 400,
    `status=${noHeaders.status}`,
  ]);

  const badJson = await request(app)
    .post('/api/webhooks/paypal')
    .set(HEADERS)
    .send('{not json');
  cases.push([
    'unparseable body is 400, not a crash',
    badJson.status === 400,
    `status=${badJson.status}`,
  ]);

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
    if (!ok) failed += 1;
  }
  return failed;
}

main()
  .then((failed) => process.exit(failed ? 1 : 0))
  .catch((err) => {
    console.error('probe failed to run:', err.message);
    process.exit(1);
  });
