/**
 * Settlement lookup: the receipt claims "settled to <account>", so the mapping
 * from PaymentIntent → charge → account has to be right, and a Stripe failure
 * has to degrade instead of throwing.
 */

jest.mock('../../src/core/services/stripeHelpers', () => ({
  getStripe: jest.fn(),
}));

const { getStripe } = require('../../src/core/services/stripeHelpers');
const { getStripeSettlement, clearSettlementCache } = require('../../src/core/services/paymentSettlement');

const PLATFORM_ACCOUNT = {
  id: 'acct_platform',
  business_profile: { name: 'EXPEDITION-GO TOURS LTD' },
  country: 'GB',
  default_currency: 'gbp',
  email: 'ops@example.com',
};

const CONNECTED_ACCOUNT = {
  id: 'acct_supplier',
  business_profile: { name: 'Kakum Guides Ltd' },
  country: 'GH',
  default_currency: 'ghs',
};

function makeStripe({ intent, platform = PLATFORM_ACCOUNT, connected = {} } = {}) {
  return {
    paymentIntents: { retrieve: jest.fn().mockResolvedValue(intent) },
    accounts: {
      retrieve: jest.fn((id) => Promise.resolve(id ? connected[id] : platform)),
    },
  };
}

function intentWith(overrides = {}) {
  return {
    id: 'pi_1',
    status: 'succeeded',
    amount: 54000,
    amount_received: 54000,
    currency: 'usd',
    livemode: true,
    receipt_email: 'customer@example.com',
    transfer_data: null,
    latest_charge: {
      id: 'ch_1',
      paid: true,
      captured: true,
      receipt_url: 'https://pay.stripe.com/receipts/payment/abc',
      balance_transaction: 'txn_1',
      destination: null,
      payment_method_details: { card: { brand: 'visa', last4: '1552' } },
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearSettlementCache();
  getStripe.mockReset();
});

describe('getStripeSettlement', () => {
  it('does nothing without a PaymentIntent id', async () => {
    await expect(getStripeSettlement({ paymentIntentId: null })).resolves.toBeNull();
    expect(getStripe).not.toHaveBeenCalled();
  });

  it('reports the platform account for a direct charge', async () => {
    const stripe = makeStripe({ intent: intentWith() });
    getStripe.mockReturnValue(stripe);

    const result = await getStripeSettlement({ paymentIntentId: 'pi_1' });

    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_1', { expand: ['latest_charge'] });
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith();
    expect(result.account).toEqual({
      id: 'acct_platform',
      name: 'EXPEDITION-GO TOURS LTD',
      country: 'GB',
      defaultCurrency: 'GBP',
      connected: false,
    });
    expect(result.charge).toEqual({
      id: 'ch_1',
      receiptUrl: 'https://pay.stripe.com/receipts/payment/abc',
      balanceTransactionId: 'txn_1',
      brand: 'visa',
      last4: '1552',
      paid: true,
      captured: true,
    });
    expect(result.amount).toBe(540);
    expect(result.currency).toBe('USD');
    expect(result.livemode).toBe(true);
  });

  it('follows a destination charge to the connected account', async () => {
    const stripe = makeStripe({
      intent: intentWith({
        latest_charge: {
          ...intentWith().latest_charge,
          destination: 'acct_supplier',
        },
      }),
      connected: { acct_supplier: CONNECTED_ACCOUNT },
    });
    getStripe.mockReturnValue(stripe);

    const result = await getStripeSettlement({ paymentIntentId: 'pi_1' });

    expect(stripe.accounts.retrieve).toHaveBeenCalledWith('acct_supplier');
    expect(result.account).toMatchObject({
      id: 'acct_supplier',
      name: 'Kakum Guides Ltd',
      connected: true,
      defaultCurrency: 'GHS',
    });
    expect(result.connectedAccountId).toBe('acct_supplier');
  });

  it('reads the destination from transfer_data when the charge has none', async () => {
    const stripe = makeStripe({
      intent: intentWith({ transfer_data: { destination: 'acct_supplier' } }),
      connected: { acct_supplier: CONNECTED_ACCOUNT },
    });
    getStripe.mockReturnValue(stripe);

    const result = await getStripeSettlement({ paymentIntentId: 'pi_1' });
    expect(result.connectedAccountId).toBe('acct_supplier');
  });

  it('handles an unexpanded charge (string id) without inventing details', async () => {
    const stripe = makeStripe({ intent: intentWith({ latest_charge: 'ch_1' }) });
    getStripe.mockReturnValue(stripe);

    const result = await getStripeSettlement({ paymentIntentId: 'pi_1' });
    expect(result.charge).toBeNull();
    expect(result.account.id).toBe('acct_platform');
  });

  it('degrades to { error } when Stripe fails', async () => {
    getStripe.mockReturnValue({
      paymentIntents: { retrieve: jest.fn().mockRejectedValue(new Error('Stripe timeout')) },
      accounts: { retrieve: jest.fn() },
    });

    const result = await getStripeSettlement({ paymentIntentId: 'pi_1' });
    expect(result).toEqual({ error: 'Stripe timeout' });
  });

  it('degrades when the Stripe key is missing', async () => {
    getStripe.mockImplementation(() => {
      throw new Error('STRIPE_SECRET_KEY is required to use Stripe.');
    });

    const result = await getStripeSettlement({ paymentIntentId: 'pi_1' });
    expect(result.error).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('caches account metadata between downloads', async () => {
    const stripe = makeStripe({ intent: intentWith() });
    getStripe.mockReturnValue(stripe);

    await getStripeSettlement({ paymentIntentId: 'pi_1' });
    await getStripeSettlement({ paymentIntentId: 'pi_2' });

    expect(stripe.accounts.retrieve).toHaveBeenCalledTimes(1);
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledTimes(2);
  });
});
