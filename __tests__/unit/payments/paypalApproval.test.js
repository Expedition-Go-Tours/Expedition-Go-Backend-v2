/**
 * Recovering the approval link for an open PayPal hold.
 *
 * A customer who refreshes the checkout page must be able to return to PayPal
 * without a second order for the same hold — and without being able to read
 * someone else's draft by guessing an order id.
 */

const prisma = require('../../../src/core/services/prismaClient');
const { getOrder } = require('../../../src/core/services/payments/paypalPayments');
const { getPaypalApproval } = require('../../../src/core/services/payments');

jest.mock('../../../src/core/services/prismaClient', () => ({
  checkoutDraft: { findUnique: jest.fn() },
}));

jest.mock('../../../src/core/services/payments/paypalPayments', () => ({
  getOrder: jest.fn(),
}));

jest.mock('../../../src/core/services/stripeHelpers', () => ({ createRefund: jest.fn() }));

const DRAFT = {
  id: 'draft_1',
  customerId: 'cus_1',
  status: 'HOLDING',
  paymentProvider: 'PAYPAL',
  paypalOrderId: 'ORDER-1',
  bookingId: null,
  currency: 'USD',
  travelDate: new Date('2026-11-10T00:00:00Z'),
  expiresAt: new Date('2026-11-10T12:00:00Z'),
  pricing: { total: '120.00', currency: 'USD' },
  tour: { id: 'tour_1', title: 'Cape Coast Castle', slug: 'cape-coast' },
};

const SUMMARY = {
  tourTitle: 'Cape Coast Castle',
  tourId: 'tour_1',
  tourSlug: 'cape-coast',
  amount: 120,
  currency: 'USD',
  travelDate: DRAFT.travelDate,
  expiresAt: DRAFT.expiresAt,
};

const APPROVE_LINKS = [
  { rel: 'self', href: 'https://api-m.paypal.com/v2/checkout/orders/ORDER-1' },
  { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' },
];

beforeEach(() => {
  jest.clearAllMocks();
  prisma.checkoutDraft.findUnique.mockResolvedValue(DRAFT);
  getOrder.mockResolvedValue({ order: { id: 'ORDER-1', status: 'CREATED', links: APPROVE_LINKS } });
});

describe('getPaypalApproval', () => {
  it('requires an order id', async () => {
    expect(await getPaypalApproval('')).toEqual({ ok: false, reason: 'missing_order' });
    expect(prisma.checkoutDraft.findUnique).not.toHaveBeenCalled();
  });

  it('404s an order it does not know', async () => {
    prisma.checkoutDraft.findUnique.mockResolvedValue(null);
    expect(await getPaypalApproval('ORDER-1', { customerId: 'cus_1' }))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses to hand back another customer\'s approval link', async () => {
    expect(await getPaypalApproval('ORDER-1', { customerId: 'someone_else' }))
      .toEqual({ ok: false, reason: 'not_owner' });
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('refuses a draft that belongs to Stripe', async () => {
    prisma.checkoutDraft.findUnique.mockResolvedValue({ ...DRAFT, paymentProvider: 'STRIPE' });
    expect(await getPaypalApproval('ORDER-1', { customerId: 'cus_1' }))
      .toEqual({ ok: false, reason: 'provider_mismatch' });
  });

  it('returns the booking instead of a link once the hold is paid', async () => {
    prisma.checkoutDraft.findUnique.mockResolvedValue({ ...DRAFT, status: 'PAID', bookingId: 'booking_1' });

    expect(await getPaypalApproval('ORDER-1', { customerId: 'cus_1' })).toMatchObject({
      ok: true,
      status: 'PAID',
      orderStatus: 'COMPLETED',
      approvalUrl: null,
      bookingId: 'booking_1',
      summary: SUMMARY,
    });
    // No PayPal round trip needed — the draft already knows the outcome.
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('reports an expired hold without offering a dead link', async () => {
    prisma.checkoutDraft.findUnique.mockResolvedValue({ ...DRAFT, status: 'EXPIRED' });

    const result = await getPaypalApproval('ORDER-1', { customerId: 'cus_1' });

    expect(result).toMatchObject({
      ok: true,
      status: 'EXPIRED',
      orderStatus: null,
      approvalUrl: null,
      bookingId: null,
      summary: SUMMARY,
    });
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('re-issues the approval link for a still-open hold', async () => {
    const result = await getPaypalApproval('ORDER-1', { customerId: 'cus_1' });

    expect(result).toMatchObject({
      ok: true,
      status: 'HOLDING',
      orderStatus: 'CREATED',
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
      bookingId: null,
      summary: SUMMARY,
    });
    expect(getOrder).toHaveBeenCalledWith('ORDER-1');
  });

  it('accepts the payer-action rel name as well as approve', async () => {
    getOrder.mockResolvedValue({
      order: { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://x/approve' }] },
    });

    expect(await getPaypalApproval('ORDER-1', { customerId: 'cus_1' }))
      .toMatchObject({ approvalUrl: 'https://x/approve', orderStatus: 'PAYER_ACTION_REQUIRED' });
  });

  it('returns no link (but the true status) when the order can no longer be approved', async () => {
    getOrder.mockResolvedValue({
      order: { id: 'ORDER-1', status: 'VOIDED', links: [{ rel: 'self', href: 'x' }] },
    });

    const result = await getPaypalApproval('ORDER-1', { customerId: 'cus_1' });

    expect(result).toMatchObject({ ok: true, status: 'HOLDING', orderStatus: 'VOIDED', approvalUrl: null });
  });
});

describe('startPaypalCheckout', () => {
  it('sends a cancelled checkout back to the tour, not a bare /booking', async () => {
    const paypalPayments = require('../../../src/core/services/payments/paypalPayments');
    paypalPayments.createOrder = jest.fn().mockResolvedValue({
      orderId: 'ORDER-1', approvalUrl: 'https://www.paypal.com/checkoutnow?token=ORDER-1',
    });
    const { startPaypalCheckout } = require('../../../src/core/services/payments');

    await startPaypalCheckout({
      draftId: 'draft_1',
      amountMinor: 12000,
      currency: 'USD',
      description: 'Cape Coast Castle',
      brand: { storefrontUrl: 'https://travioghana.com', brandName: 'Travio Ghana' },
      cancelPath: '/tour_1/cape-coast/booking',
    });

    const args = paypalPayments.createOrder.mock.calls[0][0];
    expect(args.returnUrl).toBe('https://travioghana.com/booking/paypal/return');
    // A bare /booking has no tour context and rendered an empty checkout with
    // "$0.00" — the cancel link must carry the tour.
    expect(args.cancelUrl).toBe('https://travioghana.com/tour_1/cape-coast/booking');
  });

  it('falls back to /booking when no cancel path is supplied', async () => {
    const paypalPayments = require('../../../src/core/services/payments/paypalPayments');
    paypalPayments.createOrder = jest.fn().mockResolvedValue({ orderId: 'O', approvalUrl: 'u' });
    const { startPaypalCheckout } = require('../../../src/core/services/payments');

    await startPaypalCheckout({
      draftId: 'd', amountMinor: 100, currency: 'USD', brand: { storefrontUrl: 'https://expeditiongotours.com/' },
    });

    expect(paypalPayments.createOrder.mock.calls[0][0].cancelUrl).toBe('https://expeditiongotours.com/booking');
  });
});
