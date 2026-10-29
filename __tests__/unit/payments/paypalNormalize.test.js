/**
 * PayPal payload normalisation.
 *
 * Money crosses a string boundary here: PayPal sends decimal strings and the
 * rest of the platform speaks integer minor units. These tests pin the exact
 * conversions that decide how much is charged and refunded.
 */

const {
  toMinorUnits,
  fromMinorUnits,
  normalizeOrder,
  normalizeCapture,
  normalizeRefund,
  captureFromOrder,
  toSettlementSession,
} = require('../../../src/core/services/payments/normalize');

describe('toMinorUnits', () => {
  it('converts decimal strings without floating point drift', () => {
    expect(toMinorUnits('900.00')).toBe(90000);
    expect(toMinorUnits('0.29')).toBe(29);
    expect(toMinorUnits('19.99')).toBe(1999);
    expect(toMinorUnits('1234.5')).toBe(123450);
    expect(toMinorUnits('7')).toBe(700);
  });

  it('handles values that break naive multiplication', () => {
    // Number('1.15') * 100 === 114.99999999999999
    expect(toMinorUnits('1.15')).toBe(115);
    expect(toMinorUnits('4.35')).toBe(435);
    expect(toMinorUnits('8.13')).toBe(813);
  });

  it('rejects malformed money instead of guessing', () => {
    expect(() => toMinorUnits('')).toThrow(/Invalid money value/);
    expect(() => toMinorUnits('12.345')).toThrow(/Invalid money value/);
    expect(() => toMinorUnits('abc')).toThrow(/Invalid money value/);
    expect(() => toMinorUnits(undefined)).toThrow(/Invalid money value/);
  });
});

describe('fromMinorUnits', () => {
  it('formats minor units as a two-decimal string', () => {
    expect(fromMinorUnits(90000)).toBe('900.00');
    expect(fromMinorUnits(29)).toBe('0.29');
    expect(fromMinorUnits(5)).toBe('0.05');
    expect(fromMinorUnits(0)).toBe('0.00');
  });

  it('refuses fractional minor units', () => {
    expect(() => fromMinorUnits(10.5)).toThrow(/integer/);
  });

  it('round-trips every value PayPal can send', () => {
    for (const value of ['0.01', '9.99', '100.00', '123456.78']) {
      expect(fromMinorUnits(toMinorUnits(value))).toBe(value);
    }
  });
});

const order = (over = {}) => ({
  id: 'ORDER-1',
  status: 'COMPLETED',
  purchase_units: [
    {
      reference_id: 'draft_1',
      custom_id: 'draft_1',
      invoice_id: 'draft_1',
      amount: { currency_code: 'USD', value: '120.00' },
      payments: {
        captures: [
          {
            id: 'CAP-1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '120.00' },
            create_time: '2026-10-29T10:00:00Z',
          },
        ],
      },
    },
  ],
  payer: { email_address: 'buyer@example.com', name: { given_name: 'Ama', surname: 'Mensah' } },
  payment_source: { card: { brand: 'VISA' } },
  ...over,
});

describe('normalizeOrder', () => {
  it('maps the order onto the internal payment shape', () => {
    const result = normalizeOrder(order());
    expect(result).toMatchObject({
      provider: 'PAYPAL',
      orderId: 'ORDER-1',
      status: 'SUCCEEDED',
      amountMinor: 12000,
      currency: 'USD',
      draftId: 'draft_1',
      payerEmail: 'buyer@example.com',
      payerName: 'Ama Mensah',
      channel: 'CARD:VISA',
    });
  });

  it('maps non-terminal order statuses to PENDING', () => {
    expect(normalizeOrder(order({ status: 'CREATED' })).status).toBe('PENDING');
    expect(normalizeOrder(order({ status: 'APPROVED' })).status).toBe('PROCESSING');
    expect(normalizeOrder(order({ status: 'VOIDED' })).status).toBe('CANCELLED');
  });

  it('does not hide a payload without an amount', () => {
    expect(() => normalizeOrder(order({ purchase_units: [{ custom_id: 'draft_1' }] })))
      .toThrow(/missing an amount/);
  });
});

describe('captureFromOrder', () => {
  it('prefers the completed capture over an earlier non-completed one', () => {
    const captures = [
      { id: 'CAP-DECLINED', status: 'DECLINED' },
      { id: 'CAP-DONE', status: 'COMPLETED' },
    ];
    const found = captureFromOrder(order({ purchase_units: [{ payments: { captures } }] }));
    expect(found.id).toBe('CAP-DONE');
  });

  it('returns null when the order has no captures', () => {
    expect(captureFromOrder(order({ purchase_units: [{ amount: {} }] }))).toBeNull();
  });
});

describe('normalizeCapture', () => {
  it('uses the capture amount as authoritative', () => {
    const result = normalizeCapture(order());
    expect(result).toMatchObject({
      captureId: 'CAP-1',
      captureStatus: 'COMPLETED',
      status: 'SUCCEEDED',
      amountMinor: 12000,
      currency: 'USD',
    });
  });

  it('maps pending and failed capture statuses', () => {
    const pending = normalizeCapture(order({
      purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' }, payments: { captures: [{ id: 'C', status: 'PENDING', amount: { currency_code: 'USD', value: '1.00' } }] } }],
    }));
    expect(pending.status).toBe('PROCESSING');

    const declined = normalizeCapture(order({
      purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' }, payments: { captures: [{ id: 'C', status: 'DECLINED', amount: { currency_code: 'USD', value: '1.00' } }] } }],
    }));
    expect(declined.status).toBe('FAILED');
  });

  it('throws when there is nothing captured', () => {
    expect(() => normalizeCapture(order({ purchase_units: [{ amount: {} }] })))
      .toThrow(/has no capture/);
  });

  it('falls back to the order amount when the capture omits one', () => {
    // Live PayPal: the capture RESPONSE carries a COMPLETED capture with no
    // `amount`. The order always has it, and we only capture in full.
    const thin = order({
      purchase_units: [
        {
          custom_id: 'draft_1',
          amount: { currency_code: 'USD', value: '120.00' },
          payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] },
        },
      ],
    });

    const result = normalizeCapture(thin);
    expect(result).toMatchObject({ captureId: 'CAP-1', status: 'SUCCEEDED', amountMinor: 12000, currency: 'USD' });
  });

  it('never invents an amount when neither side has one', () => {
    const thin = order({
      purchase_units: [{ custom_id: 'draft_1', payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] } }],
    });
    expect(() => normalizeCapture(thin)).toThrow(/missing an amount/);
  });
});

describe('normalizeRefund', () => {
  it('reads amount, status and the capture link', () => {
    const result = normalizeRefund({
      id: 'REF-1',
      status: 'PENDING',
      amount: { currency_code: 'USD', value: '20.00' },
      links: [{ href: 'https://api-m.paypal.com/v2/payments/captures/CAP-1', rel: 'up' }],
    });
    expect(result).toMatchObject({
      refundId: 'REF-1',
      status: 'PENDING',
      amountMinor: 2000,
      currency: 'USD',
      captureId: 'CAP-1',
    });
  });
});

describe('normalizeRefund — thin responses', () => {
  it('uses the known amount when PayPal omits it', () => {
    const result = normalizeRefund(
      { id: 'REF-1', status: 'COMPLETED' },
      { amountMinor: 12000, currency: 'USD' }
    );
    expect(result).toMatchObject({ refundId: 'REF-1', status: 'SUCCEEDED', amountMinor: 12000, currency: 'USD' });
  });

  it('still refuses to guess when nothing knows the amount', () => {
    expect(() => normalizeRefund({ id: 'REF-1', status: 'COMPLETED' })).toThrow(/missing an amount/);
  });
});

describe('toSettlementSession', () => {
  it('adapts a capture to the Stripe-shaped session materializeHold expects', () => {
    const session = toSettlementSession(normalizeCapture(order()));
    expect(session).toEqual({ id: 'ORDER-1', amount_total: 12000, currency: 'USD' });
  });
});
