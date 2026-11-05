/**
 * A rejected Stripe delivery is a money event we could not read.
 *
 * The log line is the only record of what arrived, so it has to name the
 * envelope (event id/type/mode, signature timestamp, byte count) — and it must
 * never leak the signature itself or the customer data inside the unverified
 * payload.
 */
jest.mock('../../src/core/services/stripeHelpers', () => ({
  verifyWebhookSignature: jest.fn(),
  processStripeWebhook: jest.fn(),
}));
jest.mock('../../src/core/services/queue', () => ({ enqueueWebhookRetry: jest.fn() }));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../src/core/services/prismaClient', () => ({}));

const { verifyWebhookSignature } = require('../../src/core/services/stripeHelpers');
const { handleStripeWebhook } = require('../../src/core/domain/webhookController');

describe('handleStripeWebhook — rejected delivery log', () => {
  let req;
  let res;
  let next;
  let errorLog;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    req = {
      headers: {
        'stripe-signature': 't=1791265000,v1=aaaa1111,v1=bbbb2222',
        'content-type': 'application/json',
        'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
      },
      body: Buffer.from(JSON.stringify({
        id: 'evt_1QXYZ',
        type: 'charge.succeeded',
        livemode: true,
        data: { object: { customer_email: 'guest@example.com', amount: 5000 } },
      })),
    };
    res = {};
    next = jest.fn();
    errorLog = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => {
      errorLog.push(args.map(String).join(' '));
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    verifyWebhookSignature.mockImplementation(() => {
      throw new Error('Invalid webhook signature');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers 400 and names what arrived', async () => {
    await handleStripeWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));

    const line = errorLog.join('\n');
    expect(line).toContain('evt_1QXYZ');
    expect(line).toContain('charge.succeeded');
    expect(line).toContain('"signedAt":"1791265000"');
    expect(line).toContain('"signaturesOffered":2');
    expect(line).toContain('"livemode":true');
    expect(line).toContain('"bytes":');
  });

  it('keeps the signature and the customer data out of the log', async () => {
    await handleStripeWebhook(req, res, next);

    const line = errorLog.join('\n');
    // The signature value would let anyone with log access forge a delivery.
    expect(line).not.toContain('aaaa1111');
    expect(line).not.toContain('whsec_test_secret');
    // The payload is unverified; logging it wholesale would pour customer data
    // into logs that monitoring reads.
    expect(line).not.toContain('guest@example.com');
  });

  it('reports an unparseable body instead of failing to log', async () => {
    req.body = Buffer.from('<html>not an event</html>');

    await handleStripeWebhook(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(errorLog.join('\n')).toContain('"parse":"not-json"');
  });

  it('records a compressed body, which would break verification', async () => {
    req.headers['content-encoding'] = 'gzip';

    await handleStripeWebhook(req, res, next);

    expect(errorLog.join('\n')).toContain('"contentEncoding":"gzip"');
  });
});
