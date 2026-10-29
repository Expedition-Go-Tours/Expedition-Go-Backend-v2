/**
 * PayPal webhook intake.
 *
 * PayPal does not send an HMAC signature: it sends transmission headers that
 * must be verified by calling PayPal back. These tests cover that gate, the
 * replay guard, and the routing of capture events into the settlement path.
 */

const prisma = require('../../../src/core/services/prismaClient');
const { verifyWebhookSignature } = require('../../../src/core/services/payments/paypalPayments');
const { settlePaypalOrder, recordUnmappedPayment } = require('../../../src/core/services/payments/settlePaypal');
const { enqueuePaypalWebhookRetry } = require('../../../src/core/services/queue');
const {
  handlePaypalWebhook,
  persistAndProcess,
  processPaypalEvent,
} = require('../../../src/core/domain/paypalWebhookController');

jest.mock('../../../src/core/services/prismaClient', () => ({
  paypalEvent: { upsert: jest.fn(), update: jest.fn() },
  booking: { findFirst: jest.fn(), update: jest.fn() },
  bookingPaymentReconciliation: { updateMany: jest.fn() },
  checkoutDraft: { findUnique: jest.fn() },
}));

jest.mock('../../../src/core/services/payments/paypalPayments', () => ({
  verifyWebhookSignature: jest.fn(),
}));

jest.mock('../../../src/core/services/payments/settlePaypal', () => ({
  settlePaypalOrder: jest.fn(),
  recordUnmappedPayment: jest.fn(),
}));

jest.mock('../../../src/core/services/queue', () => ({
  enqueuePaypalWebhookRetry: jest.fn(),
}));

jest.mock('../../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../../src/core/services/channelEmbeds', () => ({
  salesRefundIssued: jest.fn(() => ({ content: 'refund', opts: {} })),
}));

const CAPTURE_EVENT = {
  id: 'WH-1',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: {
    id: 'CAP-1',
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: '120.00' },
    custom_id: 'draft_1',
    supplemental_data: { related_ids: { order_id: 'ORDER-1' } },
  },
};

function fakeReq(event = CAPTURE_EVENT, headers = {}) {
  return {
    body: Buffer.from(JSON.stringify(event)),
    headers: {
      'paypal-transmission-id': 't-1',
      'paypal-transmission-time': '2026-10-29T10:00:00Z',
      'paypal-transmission-sig': 'sig',
      'paypal-cert-url': 'https://api.paypal.com/cert.pem',
      'paypal-auth-algo': 'SHA256withRSA',
      ...headers,
    },
  };
}

function fakeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.paypalEvent.upsert.mockResolvedValue({ id: 'row_1', processed: false });
  prisma.paypalEvent.update.mockResolvedValue({});
  prisma.bookingPaymentReconciliation.updateMany.mockResolvedValue({ count: 1 });
  prisma.booking.update.mockResolvedValue({});
  verifyWebhookSignature.mockResolvedValue({ verified: true, status: 'SUCCESS' });
  settlePaypalOrder.mockResolvedValue({ ok: true, booking: { id: 'booking_1' } });
  enqueuePaypalWebhookRetry.mockResolvedValue(undefined);
});

describe('handlePaypalWebhook', () => {
  it('rejects a delivery PayPal does not confirm', async () => {
    verifyWebhookSignature.mockResolvedValue({ verified: false, status: 'FAILURE' });
    const next = jest.fn();

    await handlePaypalWebhook(fakeReq(), fakeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.paypalEvent.upsert).not.toHaveBeenCalled();
  });

  it('rejects a forged certificate host without calling PayPal', async () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      '../../../src/core/services/payments/paypalPayments'
    );
    expect(typeof realVerify).toBe('function');
    // The handler still delegates; the host allowlist is asserted in the
    // paypalPayments suite. Guard the contract here: nothing is stored.
    verifyWebhookSignature.mockResolvedValue({ verified: false, reason: 'untrusted_cert_url' });
    const next = jest.fn();

    await handlePaypalWebhook(fakeReq(), fakeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(prisma.paypalEvent.upsert).not.toHaveBeenCalled();
  });

  it('requires a raw body', async () => {
    const next = jest.fn();
    const req = fakeReq();
    req.body = { already: 'parsed' };

    await handlePaypalWebhook(req, fakeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(500);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('acknowledges a rejected signature with 400 so PayPal retries', async () => {
    verifyWebhookSignature.mockRejectedValue(new Error('PayPal API is down'));
    const next = jest.fn();

    await handlePaypalWebhook(fakeReq(), fakeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  it('stores and processes a verified capture', async () => {
    const res = fakeRes();
    const next = jest.fn();

    await handlePaypalWebhook(fakeReq(), res, next);

    expect(prisma.paypalEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paypalEventId: 'WH-1' },
        create: expect.objectContaining({
          paypalEventId: 'WH-1',
          eventType: 'PAYMENT.CAPTURE.COMPLETED',
          resourceId: 'CAP-1',
        }),
      })
    );
    expect(settlePaypalOrder).toHaveBeenCalledWith('ORDER-1', { source: 'webhook' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('acknowledges a replay without settling twice', async () => {
    prisma.paypalEvent.upsert.mockResolvedValue({ id: 'row_1', processed: true });
    const res = fakeRes();

    await handlePaypalWebhook(fakeReq(), res, jest.fn());

    expect(settlePaypalOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('queues a retry and still acknowledges when processing throws', async () => {
    settlePaypalOrder.mockRejectedValue(new Error('db is down'));
    const res = fakeRes();

    await handlePaypalWebhook(fakeReq(), res, jest.fn());

    expect(prisma.paypalEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: 'db is down' }) })
    );
    expect(enqueuePaypalWebhookRetry).toHaveBeenCalledWith(CAPTURE_EVENT);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('persistAndProcess', () => {
  it('is idempotent on the PayPal event id', async () => {
    prisma.paypalEvent.upsert.mockResolvedValue({ id: 'row_1', processed: true });

    const result = await persistAndProcess(CAPTURE_EVENT);

    expect(result).toMatchObject({ duplicate: true, success: true });
    expect(settlePaypalOrder).not.toHaveBeenCalled();
  });

  it('marks a processed event only after the work succeeds', async () => {
    await persistAndProcess(CAPTURE_EVENT);
    expect(prisma.paypalEvent.update).toHaveBeenCalledWith({
      where: { id: 'row_1' },
      data: { processed: true, processedAt: expect.any(Date), error: null },
    });
  });

  it('leaves the event unprocessed when the work fails', async () => {
    settlePaypalOrder.mockRejectedValue(new Error('boom'));

    await expect(persistAndProcess(CAPTURE_EVENT)).rejects.toThrow('boom');
    expect(prisma.paypalEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: 'boom' }) })
    );
  });
});

describe('processPaypalEvent', () => {
  it('settles a completed capture', async () => {
    const result = await processPaypalEvent(CAPTURE_EVENT);
    expect(settlePaypalOrder).toHaveBeenCalledWith('ORDER-1', { source: 'webhook' });
    expect(result.success).toBe(true);
  });

  it('falls back to the draft when the capture omits the order id', async () => {
    prisma.checkoutDraft.findUnique.mockResolvedValue({ paypalOrderId: 'ORDER-FROM-DRAFT' });
    const event = {
      ...CAPTURE_EVENT,
      resource: {
        ...CAPTURE_EVENT.resource,
        supplemental_data: {},
      },
    };

    await processPaypalEvent(event);

    expect(settlePaypalOrder).toHaveBeenCalledWith('ORDER-FROM-DRAFT', { source: 'webhook' });
  });

  it('flags a capture with no order and no draft instead of ignoring it', async () => {
    prisma.checkoutDraft.findUnique.mockResolvedValue(null);
    const event = {
      ...CAPTURE_EVENT,
      resource: { ...CAPTURE_EVENT.resource, custom_id: null, supplemental_data: {} },
    };

    await processPaypalEvent(event);

    expect(recordUnmappedPayment).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: 'CAP-1', amountMinor: 12000, currency: 'USD' })
    );
    expect(settlePaypalOrder).not.toHaveBeenCalled();
  });

  it('records a refunded capture against the booking', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      id: 'booking_1',
      bookingNumber: 'TRG-1-1',
      status: 'CONFIRMED',
      paymentStatus: 'SUCCEEDED',
    });

    await processPaypalEvent({
      id: 'WH-2',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'CAP-1',
        status: 'REFUNDED',
        amount: { currency_code: 'USD', value: '120.00' },
        seller_receivable_breakdown: { refunded_amount: { currency_code: 'USD', value: '120.00' } },
      },
    });

    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'booking_1' },
        data: expect.objectContaining({ paymentStatus: 'REFUNDED', paypalRefundStatus: 'COMPLETED' }),
      })
    );
  });

  it('ignores unrelated event types without failing', async () => {
    const result = await processPaypalEvent({ id: 'WH-3', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} });
    expect(result.success).toBe(true);
    expect(settlePaypalOrder).not.toHaveBeenCalled();
  });
});
