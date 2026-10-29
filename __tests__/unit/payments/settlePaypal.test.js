/**
 * PayPal settlement.
 *
 * The money has already left the customer by the time this runs, so every
 * branch here is about accounting for it exactly once: settle, wait, or refund.
 * Nothing in this file is allowed to drop a capture silently.
 */

const prisma = require('../../../src/core/services/prismaClient');
const { readCapture, refundCapture } = require('../../../src/core/services/payments/paypalPayments');
const { materializeHold } = require('../../../src/core/services/checkoutHold');
const { notifyBookingsSettled } = require('../../../src/core/services/stripeHelpers');
const { settlePaypalOrder } = require('../../../src/core/services/payments/settlePaypal');

jest.mock('../../../src/core/services/prismaClient', () => ({
  checkoutDraft: { findUnique: jest.fn(), updateMany: jest.fn() },
  booking: { findUnique: jest.fn() },
  bookingPaymentReconciliation: { upsert: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../../src/core/services/payments/paypalPayments', () => ({
  readCapture: jest.fn(),
  refundCapture: jest.fn(),
}));

jest.mock('../../../src/core/services/checkoutHold', () => ({
  materializeHold: jest.fn(),
}));

jest.mock('../../../src/core/services/stripeHelpers', () => ({
  notifyBookingsSettled: jest.fn(),
}));

jest.mock('../../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../../src/core/services/channelEmbeds', () => ({
  salesRefundIssued: jest.fn(() => ({ content: 'refund', opts: {} })),
  salesUnmappedPayment: jest.fn(() => ({ content: 'unmapped', opts: {} })),
}));

const CAPTURE = {
  provider: 'PAYPAL',
  orderId: 'ORDER-1',
  captureId: 'CAP-1',
  status: 'SUCCEEDED',
  amountMinor: 12000,
  currency: 'USD',
  draftId: 'draft_1',
  payerEmail: 'buyer@example.com',
  channel: 'CARD:VISA',
};

const DRAFT = {
  id: 'draft_1',
  status: 'HOLDING',
  paymentProvider: 'PAYPAL',
  paypalOrderId: 'ORDER-1',
  bookingId: null,
  currency: 'USD',
  pricing: { total: '120.00', currency: 'USD' },
};

const BOOKING = {
  id: 'booking_1',
  bookingNumber: 'TRG-1-1',
  paymentTiming: 'now',
  source: 'GHANA',
  tour: { id: 'tour_1', supplier: { id: 'sup_1' } },
  customer: { id: 'cus_1' },
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  prisma.checkoutDraft.findUnique.mockReset();
  prisma.checkoutDraft.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookingPaymentReconciliation.upsert.mockResolvedValue({});
  prisma.booking.findUnique.mockResolvedValue(BOOKING);
  readCapture.mockResolvedValue({
    orderNormalized: { orderId: 'ORDER-1', status: 'SUCCEEDED' },
    capture: { ...CAPTURE },
  });
  refundCapture.mockResolvedValue({
    refund: { id: 'REF-1' },
    normalized: { refundId: 'REF-1', status: 'SUCCEEDED', amountMinor: 12000, currency: 'USD' },
  });
  materializeHold.mockResolvedValue({ ok: true, booking: BOOKING, oversold: false });
});

function capturesDraft(draft = DRAFT) {
  prisma.checkoutDraft.findUnique.mockImplementation(({ where }) => {
    if (where.id === draft.id) return Promise.resolve(draft);
    if (where.paypalOrderId === draft.paypalOrderId) return Promise.resolve(draft);
    return Promise.resolve(null);
  });
}

describe('settlePaypalOrder', () => {
  it('waits when the order has no capture yet', async () => {
    readCapture.mockResolvedValue({ orderNormalized: { orderId: 'ORDER-1' }, capture: null });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'not_captured' });
    expect(materializeHold).not.toHaveBeenCalled();
    expect(refundCapture).not.toHaveBeenCalled();
  });

  it('waits while the capture is still PENDING', async () => {
    readCapture.mockResolvedValue({
      orderNormalized: { orderId: 'ORDER-1' },
      capture: { ...CAPTURE, status: 'PROCESSING' },
    });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'processing' });
    expect(materializeHold).not.toHaveBeenCalled();
  });

  it('expires the hold when PayPal declines the capture', async () => {
    readCapture.mockResolvedValue({
      orderNormalized: { orderId: 'ORDER-1' },
      capture: { ...CAPTURE, status: 'FAILED' },
    });
    capturesDraft();

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'declined' });
    expect(prisma.checkoutDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft_1', status: 'HOLDING' },
      data: { status: 'EXPIRED' },
    });
  });

  it('records an unmapped capture instead of refunding a stranger', async () => {
    prisma.checkoutDraft.findUnique.mockResolvedValue(null);

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'unmapped' });
    expect(prisma.bookingPaymentReconciliation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paypalCaptureId: 'CAP-1' },
        create: expect.objectContaining({
          paymentProvider: 'PAYPAL',
          reason: 'UNMAPPED_PAYMENT',
          status: 'UNMATCHED',
          amount: '120.00',
        }),
      })
    );
    expect(refundCapture).not.toHaveBeenCalled();
    expect(materializeHold).not.toHaveBeenCalled();
  });

  it('refuses to settle a draft that belongs to Stripe', async () => {
    capturesDraft({ ...DRAFT, paymentProvider: 'STRIPE' });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'provider_mismatch' });
    expect(materializeHold).not.toHaveBeenCalled();
    expect(refundCapture).not.toHaveBeenCalled();
  });

  it('is a no-op when the draft is already paid', async () => {
    capturesDraft({ ...DRAFT, status: 'PAID', bookingId: 'booking_1' });
    prisma.booking.findUnique.mockResolvedValue(BOOKING);

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: true, alreadySettled: true });
    expect(materializeHold).not.toHaveBeenCalled();
    expect(refundCapture).not.toHaveBeenCalled();
  });

  it('refunds a capture that arrives after the hold ended', async () => {
    capturesDraft({ ...DRAFT, status: 'EXPIRED' });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'refunded' });
    expect(refundCapture).toHaveBeenCalledWith(expect.objectContaining({
      captureId: 'CAP-1',
      amountMinor: null,
      idempotencyKey: 'paypal-auto-refund-CAP-1',
    }));
    expect(materializeHold).not.toHaveBeenCalled();
  });

  it('refunds when the captured amount does not match the frozen price', async () => {
    capturesDraft();
    readCapture.mockResolvedValue({
      orderNormalized: { orderId: 'ORDER-1' },
      capture: { ...CAPTURE, amountMinor: 11999 },
    });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'amount_mismatch' });
    expect(refundCapture).toHaveBeenCalled();
    expect(materializeHold).not.toHaveBeenCalled();
    expect(prisma.bookingPaymentReconciliation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'AMOUNT_MISMATCH' }),
      })
    );
  });

  it('refunds when the captured currency is not the draft currency', async () => {
    capturesDraft();
    readCapture.mockResolvedValue({
      orderNormalized: { orderId: 'ORDER-1' },
      capture: { ...CAPTURE, currency: 'EUR' },
    });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'amount_mismatch' });
    expect(refundCapture).toHaveBeenCalled();
  });

  it('materialises the booking with the PayPal identifiers only', async () => {
    capturesDraft();

    const result = await settlePaypalOrder('ORDER-1', { source: 'return' });

    expect(result).toMatchObject({ ok: true, alreadySettled: false });
    expect(materializeHold).toHaveBeenCalledWith(
      'draft_1',
      { id: 'ORDER-1', amount_total: 12000, currency: 'USD' },
      null,
      { provider: 'PAYPAL', captureId: 'CAP-1' }
    );
    expect(notifyBookingsSettled).toHaveBeenCalledWith(
      [BOOKING],
      expect.objectContaining({ paymentIntentId: 'CAP-1', source: 'paypal' })
    );
  });

  it('refunds a capture that loses the race for the last seats', async () => {
    capturesDraft();
    materializeHold.mockResolvedValue({ ok: false, oversold: true });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: false, reason: 'oversold' });
    expect(refundCapture).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'paypal-auto-refund-CAP-1',
    }));
    expect(prisma.bookingPaymentReconciliation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'BOOKING_TERMINAL' }),
      })
    );
    expect(notifyBookingsSettled).not.toHaveBeenCalled();
  });

  it('treats a concurrent settlement as already paid, not as a failure', async () => {
    const paid = { ...DRAFT, status: 'PAID', bookingId: 'booking_1' };
    prisma.checkoutDraft.findUnique
      .mockResolvedValueOnce(DRAFT)
      .mockResolvedValueOnce(paid);
    materializeHold.mockResolvedValue({ ok: false, reason: 'already_settled' });

    const result = await settlePaypalOrder('ORDER-1');
    expect(result).toMatchObject({ ok: true, alreadySettled: true });
    expect(refundCapture).not.toHaveBeenCalled();
  });

  it('does not send settlement notifications twice for a replayed webhook', async () => {
    capturesDraft({ ...DRAFT, status: 'PAID', bookingId: 'booking_1' });

    await settlePaypalOrder('ORDER-1', { source: 'webhook' });
    await settlePaypalOrder('ORDER-1', { source: 'webhook' });

    expect(notifyBookingsSettled).not.toHaveBeenCalled();
    expect(materializeHold).not.toHaveBeenCalled();
  });
});
