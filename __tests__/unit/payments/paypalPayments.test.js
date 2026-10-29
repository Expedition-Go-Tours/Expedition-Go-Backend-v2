/**
 * PayPal API calls.
 *
 * The transport is mocked; what matters here is the request shape (idempotency
 * keys, amounts, return URLs) and the verification gate, because those are the
 * parts that decide whether money moves and whether a webhook is trustworthy.
 */

const { request } = require('../../../src/core/services/payments/paypalClient');
const {
  createOrder,
  captureOrder,
  readCapture,
  refundCapture,
  verifyWebhookSignature,
} = require('../../../src/core/services/payments/paypalPayments');

jest.mock('../../../src/core/services/payments/paypalClient', () => {
  const actual = jest.requireActual('../../../src/core/services/payments/paypalClient');
  return { ...actual, request: jest.fn() };
});

const CAPTURED_ORDER = {
  id: 'ORDER-1',
  status: 'COMPLETED',
  purchase_units: [
    {
      reference_id: 'draft_1',
      custom_id: 'draft_1',
      amount: { currency_code: 'USD', value: '120.00' },
      payments: {
        captures: [
          {
            id: 'CAP-1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '120.00' },
          },
        ],
      },
    },
  ],
};

const ORDER = {
  id: 'ORDER-1',
  status: 'CREATED',
  purchase_units: [
    {
      reference_id: 'draft_1',
      custom_id: 'draft_1',
      amount: { currency_code: 'USD', value: '120.00' },
    },
  ],
  links: [
    { rel: 'self', href: 'https://api-m.paypal.com/v2/checkout/orders/ORDER-1' },
    { rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=ORDER-1' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PAYPAL_CLIENT_ID = 'client-id';
  process.env.PAYPAL_CLIENT_SECRET = 'client-secret';
  process.env.PAYPAL_WEBHOOK_ID = 'WH-ID';
  process.env.PAYPAL_MODE = 'sandbox';
});

afterAll(() => {
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_WEBHOOK_ID;
  delete process.env.PAYPAL_MODE;
});

describe('createOrder', () => {
  it('creates a CAPTURE order with return URLs and an idempotency key', async () => {
    request.mockResolvedValue(ORDER);

    const result = await createOrder({
      draftId: 'draft_1',
      amountMinor: 12000,
      currency: 'USD',
      description: 'Cape Coast Castle tour',
      brandName: 'Travio Ghana',
      returnUrl: 'https://travioghana.com/booking/paypal/return',
      cancelUrl: 'https://travioghana.com/booking',
    });

    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/v2/checkout/orders');
    expect(options.method).toBe('POST');
    expect(options.idempotencyKey).toBe('paypal-order-draft_1');
    expect(options.body.intent).toBe('CAPTURE');
    expect(options.body.purchase_units[0]).toMatchObject({
      custom_id: 'draft_1',
      invoice_id: 'draft_1',
      amount: { currency_code: 'USD', value: '120.00' },
    });
    expect(options.body.application_context).toMatchObject({
      return_url: 'https://travioghana.com/booking/paypal/return',
      cancel_url: 'https://travioghana.com/booking',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
    });

    expect(result).toMatchObject({
      provider: 'PAYPAL',
      orderId: 'ORDER-1',
      approvalUrl: 'https://www.paypal.com/checkoutnow?token=ORDER-1',
    });
  });

  it('rejects a non-positive or fractional amount before calling PayPal', async () => {
    await expect(createOrder({
      draftId: 'draft_1', amountMinor: 0, currency: 'USD', returnUrl: 'r', cancelUrl: 'c',
    })).rejects.toThrow(/positive integer amount/);
    await expect(createOrder({
      draftId: 'draft_1', amountMinor: 100.5, currency: 'USD', returnUrl: 'r', cancelUrl: 'c',
    })).rejects.toThrow(/positive integer amount/);
    expect(request).not.toHaveBeenCalled();
  });

  it('fails loudly when PayPal returns no approval link', async () => {
    request.mockResolvedValue({ ...ORDER, links: [{ rel: 'self', href: 'x' }] });
    await expect(createOrder({
      draftId: 'draft_1', amountMinor: 12000, currency: 'USD', returnUrl: 'r', cancelUrl: 'c',
    })).rejects.toThrow(/approval link/);
  });
});

describe('captureOrder', () => {
  it('captures with a deterministic idempotency key', async () => {
    request.mockResolvedValue(CAPTURED_ORDER);

    await captureOrder('ORDER-1', { idempotencyKey: 'paypal-capture-draft_1' });

    expect(request).toHaveBeenCalledWith(
      '/v2/checkout/orders/ORDER-1/capture',
      expect.objectContaining({ method: 'POST', idempotencyKey: 'paypal-capture-draft_1' })
    );
    // The POST is the action; the order is then read back for its full shape.
    expect(request).toHaveBeenLastCalledWith('/v2/checkout/orders/ORDER-1', expect.anything());
  });

  it('normalises the order it reads back, not the thin capture response', async () => {
    // Exactly what PayPal returned live: a COMPLETED capture with no `amount`.
    const THIN = {
      id: 'ORDER-1',
      status: 'COMPLETED',
      purchase_units: [
        {
          custom_id: 'draft_1',
          amount: { currency_code: 'USD', value: '120.00' },
          payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] },
        },
      ],
    };
    request.mockResolvedValueOnce(THIN).mockResolvedValueOnce(CAPTURED_ORDER);

    const result = await captureOrder('ORDER-1', { idempotencyKey: 'k' });

    expect(result.capture).toMatchObject({ captureId: 'CAP-1', status: 'SUCCEEDED', amountMinor: 12000 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('still returns the capture when the read-back fails (money already moved)', async () => {
    const THIN = {
      id: 'ORDER-1',
      status: 'COMPLETED',
      purchase_units: [
        {
          custom_id: 'draft_1',
          amount: { currency_code: 'USD', value: '120.00' },
          payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] },
        },
      ],
    };
    request
      .mockResolvedValueOnce(THIN)
      .mockRejectedValueOnce(new Error('network down'));

    const result = await captureOrder('ORDER-1', { idempotencyKey: 'k' });

    expect(result.capture.captureId).toBe('CAP-1');
    expect(result.capture.amountMinor).toBe(12000); // from the order amount
  });

  it('surfaces a real capture failure instead of reading the order back', async () => {
    const { PayPalApiError } = jest.requireActual('../../../src/core/services/payments/paypalClient');
    request.mockRejectedValueOnce(new PayPalApiError('declined', { code: 'INSTRUMENT_DECLINED' }));

    await expect(captureOrder('ORDER-1', { idempotencyKey: 'k' }))
      .rejects.toThrow(/declined/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reads the order back when it was already captured', async () => {
    const { PayPalApiError } = jest.requireActual('../../../src/core/services/payments/paypalClient');
    request
      .mockRejectedValueOnce(new PayPalApiError('already captured', { code: 'ORDER_ALREADY_CAPTURED' }))
      .mockResolvedValueOnce(CAPTURED_ORDER);

    const result = await captureOrder('ORDER-1', { idempotencyKey: 'k' });

    expect(request).toHaveBeenLastCalledWith('/v2/checkout/orders/ORDER-1', expect.anything());
    expect(result.order.id).toBe('ORDER-1');
    expect(result.capture.captureId).toBe('CAP-1');
  });

  it('requires an idempotency key', async () => {
    await expect(captureOrder('ORDER-1', {})).rejects.toThrow(/idempotency key/);
  });
});

describe('readCapture', () => {
  it('returns null when nothing has been captured yet', async () => {
    request.mockResolvedValue(ORDER);
    const result = await readCapture('ORDER-1');
    expect(result.capture).toBeNull();
    expect(result.orderNormalized.orderId).toBe('ORDER-1');
  });
});

describe('refundCapture', () => {
  it('sends the amount for a partial refund and omits it for a full one', async () => {
    request.mockResolvedValue({
      id: 'REF-1',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '20.00' },
    });

    await refundCapture({
      captureId: 'CAP-1',
      amountMinor: 2000,
      currency: 'USD',
      idempotencyKey: 'paypal-refund-1',
    });
    expect(request.mock.calls[0][1].body).toMatchObject({
      amount: { value: '20.00', currency_code: 'USD' },
    });

    request.mockClear();
    await refundCapture({
      captureId: 'CAP-1',
      amountMinor: null,
      currency: 'USD',
      idempotencyKey: 'paypal-refund-2',
    });
    expect(request.mock.calls[0][1].body.amount).toBeUndefined();
  });
});

describe('refundCapture — thin responses', () => {
  it('re-reads the refund when the response omits the amount', async () => {
    request
      .mockResolvedValueOnce({ id: 'REF-1', status: 'COMPLETED' })          // POST refund
      .mockResolvedValueOnce({ id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '20.00' } }); // GET refund

    const { normalized } = await refundCapture({
      captureId: 'CAP-1', amountMinor: 2000, currency: 'USD', idempotencyKey: 'k',
    });

    expect(normalized).toMatchObject({ refundId: 'REF-1', status: 'SUCCEEDED', amountMinor: 2000 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('/v2/payments/refunds/REF-1', expect.anything());
  });

  it('falls back to the capture\'s refunded amount for a full refund', async () => {
    request
      .mockResolvedValueOnce({ id: 'REF-1', status: 'COMPLETED' })   // POST refund (no amount)
      .mockRejectedValueOnce(new Error('read failed'))               // GET refund fails
      .mockResolvedValueOnce({                                       // GET capture
        id: 'CAP-1',
        seller_receivable_breakdown: { refunded_amount: { currency_code: 'USD', value: '120.00' } },
      });

    const { normalized } = await refundCapture({
      captureId: 'CAP-1', amountMinor: null, currency: 'USD', idempotencyKey: 'k',
    });

    expect(normalized).toMatchObject({ refundId: 'REF-1', amountMinor: 12000 });
  });
});

describe('verifyWebhookSignature', () => {
  const headers = {
    'paypal-transmission-id': 't-1',
    'paypal-transmission-time': '2026-10-29T10:00:00Z',
    'paypal-transmission-sig': 'sig',
    'paypal-cert-url': 'https://api.paypal.com/cert.pem',
    'paypal-auth-algo': 'SHA256withRSA',
  };

  it('accepts a PayPal-confirmed delivery', async () => {
    request.mockResolvedValue({ verification_status: 'SUCCESS' });

    const result = await verifyWebhookSignature(headers, { id: 'WH-1' });

    expect(result.verified).toBe(true);
    expect(request).toHaveBeenCalledWith(
      '/v1/notifications/verify-webhook-signature',
      expect.objectContaining({
        body: expect.objectContaining({ webhook_id: 'WH-ID', webhook_event: { id: 'WH-1' } }),
      })
    );
  });

  it('rejects anything PayPal does not confirm', async () => {
    request.mockResolvedValue({ verification_status: 'FAILURE' });
    expect((await verifyWebhookSignature(headers, { id: 'WH-1' })).verified).toBe(false);
  });

  it('rejects a forged certificate URL without calling PayPal', async () => {
    const result = await verifyWebhookSignature(
      { ...headers, 'paypal-cert-url': 'https://attacker.example.com/cert.pem' },
      { id: 'WH-1' }
    );

    expect(result).toEqual({ verified: false, reason: 'untrusted_cert_url' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a delivery missing transmission headers', async () => {
    const result = await verifyWebhookSignature({}, { id: 'WH-1' });
    expect(result).toEqual({ verified: false, reason: 'missing_transmission_headers' });
  });

  it('requires a webhook id to be configured', async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    await expect(verifyWebhookSignature(headers, { id: 'WH-1' }))
      .rejects.toThrow(/PAYPAL_WEBHOOK_ID/);
  });
});
