/**
 * Refund routing.
 *
 * Every existing refund call site now goes through `refundBookingPayment`, so
 * the decision "which processor holds this money" lives in exactly one place.
 * Stripe behaviour must be untouched, and PayPal refunds must stay inside what
 * was actually captured.
 */

const prisma = require('../../../src/core/services/prismaClient');
const { createRefund } = require('../../../src/core/services/stripeHelpers');
const paypalPayments = require('../../../src/core/services/payments/paypalPayments');
const { refundBookingPayment } = require('../../../src/core/services/payments');

jest.mock('../../../src/core/services/prismaClient', () => ({
  booking: { update: jest.fn() },
}));

jest.mock('../../../src/core/services/stripeHelpers', () => ({
  createRefund: jest.fn(),
}));

jest.mock('../../../src/core/services/payments/paypalPayments', () => ({
  refundCapture: jest.fn(),
}));

jest.mock('../../../src/core/services/payments/settlePaypal', () => ({
  settlePaypalOrder: jest.fn(),
}));

const stripeBooking = () => ({
  id: 'booking_stripe',
  paymentProvider: 'STRIPE',
  stripePaymentIntentId: 'pi_1',
  paymentStatus: 'SUCCEEDED',
  grossAmount: '120.00',
  currency: 'USD',
});

const paypalBooking = (over = {}) => ({
  id: 'booking_paypal',
  bookingNumber: 'TRG-1-1',
  paymentProvider: 'PAYPAL',
  paypalCaptureId: 'CAP-1',
  paymentStatus: 'SUCCEEDED',
  grossAmount: '120.00',
  currency: 'USD',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  createRefund.mockResolvedValue({ id: 're_1', status: 'succeeded', amount: 5000 });
  prisma.booking.update.mockResolvedValue({});
  paypalPayments.refundCapture.mockResolvedValue({
    refund: { id: 'REF-1' },
    normalized: { refundId: 'REF-1', status: 'SUCCEEDED', amountMinor: 5000, currency: 'USD' },
  });
});

describe('refundBookingPayment — Stripe', () => {
  it('delegates to Stripe unchanged', async () => {
    const result = await refundBookingPayment(stripeBooking(), 5000, { metadata: { reason: 'x' } });
    expect(createRefund).toHaveBeenCalledWith('pi_1', 5000, { metadata: { reason: 'x' } });
    expect(result).toMatchObject({ id: 're_1' });
    expect(paypalPayments.refundCapture).not.toHaveBeenCalled();
  });

  it('treats a missing provider as Stripe for legacy rows', async () => {
    await refundBookingPayment({ id: 'b', stripePaymentIntentId: 'pi_legacy' }, null);
    expect(createRefund).toHaveBeenCalledWith('pi_legacy', null);
  });

  it('passes options through when the caller supplies them', async () => {
    await refundBookingPayment({ id: 'b', stripePaymentIntentId: 'pi_legacy' }, null, { metadata: { reason: 'x' } });
    expect(createRefund).toHaveBeenCalledWith('pi_legacy', null, { metadata: { reason: 'x' } });
  });

  it('refuses a Stripe booking with no PaymentIntent', async () => {
    await expect(refundBookingPayment({ id: 'b', paymentProvider: 'STRIPE' }, 100))
      .rejects.toThrow(/no Stripe PaymentIntent/);
  });
});

describe('refundBookingPayment — PayPal', () => {
  it('refunds the capture and records the refund id', async () => {
    const result = await refundBookingPayment(paypalBooking(), 5000, {
      metadata: { reason: 'booking_modify' },
    });

    expect(paypalPayments.refundCapture).toHaveBeenCalledWith({
      captureId: 'CAP-1',
      amountMinor: 5000,
      currency: 'USD',
      note: 'Refund for booking TRG-1-1',
      invoiceId: 'TRG-1-1',
      idempotencyKey: 'paypal-refund-booking_paypal-5000-booking_modify',
    });
    expect(result).toMatchObject({
      id: 'REF-1',
      provider: 'PAYPAL',
      status: 'succeeded',
      amount: 5000,
      currency: 'usd',
    });
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking_paypal' },
      data: { paypalRefundId: 'REF-1', paypalRefundStatus: 'SUCCEEDED' },
    });
    expect(createRefund).not.toHaveBeenCalled();
  });

  it('omits the amount for a full refund', async () => {
    await refundBookingPayment(paypalBooking(), null, {});
    expect(paypalPayments.refundCapture).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: null, idempotencyKey: 'paypal-refund-booking_paypal-full-booking_refund' })
    );
  });

  it('keeps a pending refund tracked for the sweep', async () => {
    paypalPayments.refundCapture.mockResolvedValue({
      refund: { id: 'REF-PENDING' },
      normalized: { refundId: 'REF-PENDING', status: 'PENDING', amountMinor: 5000, currency: 'USD' },
    });

    const result = await refundBookingPayment(paypalBooking(), 5000, {});
    expect(result.status).toBe('pending');
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking_paypal' },
      data: { paypalRefundId: 'REF-PENDING', paypalRefundStatus: 'PENDING' },
    });
  });

  it('reports a failed refund without claiming success', async () => {
    paypalPayments.refundCapture.mockResolvedValue({
      refund: { id: 'REF-BAD' },
      normalized: { refundId: 'REF-BAD', status: 'FAILED', amountMinor: 5000, currency: 'USD' },
    });

    const result = await refundBookingPayment(paypalBooking(), 5000, {});
    expect(result.status).toBe('failed');
  });

  it('honours an explicit idempotency key', async () => {
    await refundBookingPayment(paypalBooking(), 100, { idempotencyKey: 'supplier-cancel-refund:booking_paypal' });
    expect(paypalPayments.refundCapture).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'supplier-cancel-refund:booking_paypal' })
    );
  });

  it('caps the refund at the captured amount', async () => {
    await expect(refundBookingPayment(paypalBooking(), 12001, {}))
      .rejects.toThrow(/between 1 and 12000/);
    expect(paypalPayments.refundCapture).not.toHaveBeenCalled();
  });

  it('rejects a non-positive or fractional amount', async () => {
    await expect(refundBookingPayment(paypalBooking(), 0, {})).rejects.toThrow(/between 1 and 12000/);
    await expect(refundBookingPayment(paypalBooking(), 10.5, {})).rejects.toThrow(/between 1 and 12000/);
  });

  it('refuses an already refunded booking', async () => {
    await expect(refundBookingPayment(paypalBooking({ paymentStatus: 'REFUNDED' }), null))
      .rejects.toThrow(/already refunded/);
    expect(paypalPayments.refundCapture).not.toHaveBeenCalled();
  });

  it('refuses a PayPal booking with no capture', async () => {
    await expect(refundBookingPayment(paypalBooking({ paypalCaptureId: null }), null))
      .rejects.toThrow(/no PayPal capture/);
  });

  it('requires a persisted booking', async () => {
    await expect(refundBookingPayment({}, 100)).rejects.toThrow(/persisted booking/);
  });
});
