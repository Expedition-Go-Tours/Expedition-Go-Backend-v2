/**
 * Where PayPal sends the customer when they press "Cancel and return".
 *
 * It must be the tour's own booking page, and it must carry enough for that
 * page to (a) tell the customer nothing was charged and (b) release the seat
 * hold immediately instead of letting it sit for 30 minutes.
 */

const { createOrder } = require('../../../src/core/services/payments/paypalPayments');
const { startPaypalCheckout } = require('../../../src/core/services/payments');

jest.mock('../../../src/core/services/prismaClient', () => ({}));
jest.mock('../../../src/core/services/stripeHelpers', () => ({ createRefund: jest.fn() }));
jest.mock('../../../src/core/services/payments/settlePaypal', () => ({ settlePaypalOrder: jest.fn() }));
jest.mock('../../../src/core/services/payments/paypalPayments', () => ({
  createOrder: jest.fn(async () => ({ orderId: 'ORDER-1', approvalUrl: 'https://paypal.test/approve' })),
}));

const GHANA = {
  key: 'ghana',
  brandName: 'Travio Ghana',
  storefrontUrl: 'https://www.travioghana.com',
};

beforeEach(() => jest.clearAllMocks());

describe('startPaypalCheckout cancel URL', () => {
  it('returns to the tour booking page with a cancelled marker and the draft id', async () => {
    await startPaypalCheckout({
      draftId: 'draft_1',
      amountMinor: 12000,
      currency: 'USD',
      description: 'Cape Coast Castle',
      brand: GHANA,
      cancelPath: '/tour-1/cape-coast/booking',
    });

    const { cancelUrl } = createOrder.mock.calls[0][0];
    expect(cancelUrl).toBe(
      'https://www.travioghana.com/tour-1/cape-coast/booking?paypal=cancelled&draft=draft_1'
    );
  });

  it('normalises a trailing slash on the brand URL and a missing leading slash', async () => {
    await startPaypalCheckout({
      draftId: 'draft_2',
      amountMinor: 12000,
      currency: 'USD',
      description: 'Cape Coast Castle',
      brand: { ...GHANA, storefrontUrl: 'https://www.travioghana.com/' },
      cancelPath: 'tour-1/cape-coast/booking',
    });

    const { cancelUrl } = createOrder.mock.calls[0][0];
    expect(cancelUrl).toBe(
      'https://www.travioghana.com/tour-1/cape-coast/booking?paypal=cancelled&draft=draft_2'
    );
  });

  it('merges into a cancel path that already has a query string', async () => {
    await startPaypalCheckout({
      draftId: 'draft_3',
      amountMinor: 12000,
      currency: 'USD',
      description: 'Cape Coast Castle',
      brand: GHANA,
      cancelPath: '/tour-1/booking?ref=email',
    });

    const { cancelUrl } = createOrder.mock.calls[0][0];
    const parsed = new URL(cancelUrl);
    expect(parsed.pathname).toBe('/tour-1/booking');
    expect(parsed.searchParams.get('ref')).toBe('email');
    expect(parsed.searchParams.get('paypal')).toBe('cancelled');
    expect(parsed.searchParams.get('draft')).toBe('draft_3');
  });
});
