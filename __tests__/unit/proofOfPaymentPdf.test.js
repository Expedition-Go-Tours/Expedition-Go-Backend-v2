/**
 * Proof-of-payment PDF — layout is hard to assert, but the facts that end up on
 * it are not: money formatting, the payment state the document claims, and the
 * party it addresses. Those are the parts that would silently lie to a
 * customer if they regressed.
 */

const {
  renderProofOfPaymentPdf,
  formatMoney,
  formatDate,
  formatDateTime,
  travelerSummary,
  contactOf,
  statusOf,
  collectedTotals,
  paymentTimingNote,
  chargeLeadTime,
} = require('../../src/core/services/proofOfPaymentPdf');

const BASE_BOOKING = {
  bookingNumber: 'TRG-86414786-2026-46',
  status: 'CONFIRMED',
  paymentStatus: 'SUCCEEDED',
  paymentProvider: 'STRIPE',
  paymentTiming: 'later',
  currency: 'USD',
  subtotal: '540.00',
  taxes: '0.00',
  fees: '0.00',
  discounts: '0.00',
  grossAmount: '540.00',
  createdAt: new Date('2026-10-22T16:26:54.776Z'),
  paidAt: new Date('2026-11-03T00:19:28.604Z'),
  travelDate: new Date('2026-11-04T00:00:00.000Z'),
  travelers: { adults: 6, children: 0, infants: 0, location: 'The Pelican Hotel, Accra' },
  leadTravelerName: 'Priscilla Hankins',
  leadTravelerEmail: 'hankins460@gmail.com',
  leadTravelerPhone: '+17574071603',
  paymentMethodBrand: 'visa',
  paymentMethodLast4: '1552',
  stripePaymentIntentId: 'pi_3UTOpOCgYMgEuT2o1Dm6PhVa',
  paypalOrderId: null,
  paypalCaptureId: null,
  refundAmount: null,
  collections: [],
  customer: { id: 'cus_1', name: 'Wayne Gibson', email: 'drwgibson@gmail.com', phone: null },
  guest: null,
  tour: {
    id: 'tour_1',
    title: 'Cape Coast Castle, Elmina Castle & Kakum National Park Tour',
    city: 'Cape Coast',
    country: 'Ghana',
    durationMinutes: 660,
    supplier: { id: 'sup_1', name: 'Expedition-Go Tours LTD' },
  },
};

const SETTLEMENT = {
  account: {
    id: 'acct_1MCqHBCgYMgEuT2o',
    name: 'EXPEDITION-GO TOURS LTD',
    country: 'GB',
    defaultCurrency: 'GBP',
    connected: false,
  },
  connectedAccountId: null,
  charge: {
    id: 'ch_3UTOpOCgYMgEuT2o1vOA6HXM',
    receiptUrl: 'https://pay.stripe.com/receipts/payment/test',
    balanceTransactionId: 'txn_3UTOpOCgYMgEuT2o1bYgNJuK',
    brand: 'visa',
    last4: '1552',
    paid: true,
    captured: true,
  },
  amount: 540,
  currency: 'USD',
  status: 'succeeded',
  livemode: true,
  receiptEmail: 'drwgibson@gmail.com',
};

function booking(overrides = {}) {
  return { ...BASE_BOOKING, ...overrides };
}

function pageCount(buffer) {
  return (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
}

describe('formatMoney', () => {
  it('prefixes the currency code instead of a symbol', () => {
    expect(formatMoney(540, 'USD')).toBe('USD 540.00');
    expect(formatMoney('540.5', 'GHS')).toBe('GHS 540.50');
  });

  it('groups thousands and keeps the sign in front of the amount', () => {
    expect(formatMoney(1234567.5, 'USD')).toBe('USD 1,234,567.50');
    expect(formatMoney(-250, 'USD')).toBe('USD -250.00');
  });

  it('treats null and undefined as zero', () => {
    expect(formatMoney(null, 'USD')).toBe('USD 0.00');
    expect(formatMoney(undefined, 'USD')).toBe('USD 0.00');
  });
});

describe('formatDate / formatDateTime', () => {
  it('formats in UTC so the document never shifts by server timezone', () => {
    expect(formatDate('2026-11-04T00:00:00.000Z')).toBe('4 Nov 2026');
    expect(formatDateTime('2026-11-03T00:19:28.604Z')).toBe('3 Nov 2026 · 00:19 UTC');
  });

  it('returns null for missing or invalid values', () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate('not-a-date')).toBeNull();
    expect(formatDateTime(undefined)).toBeNull();
  });
});

describe('travelerSummary', () => {
  it('pluralises and skips empty buckets', () => {
    expect(travelerSummary({ adults: 6, children: 0, infants: 0 })).toBe('6 adults');
    expect(travelerSummary({ adults: 1, children: 2, infants: 1 })).toBe('1 adult · 2 children · 1 infant');
  });

  it('survives a null travelers blob', () => {
    expect(travelerSummary(null)).toBe('');
  });
});

describe('contactOf', () => {
  it('addresses the customer account when there is one', () => {
    expect(contactOf(booking())).toEqual({
      name: 'Wayne Gibson',
      email: 'drwgibson@gmail.com',
      phone: null,
    });
  });

  it('falls back to the walk-in guest', () => {
    const guest = booking({
      customer: null,
      guest: { name: 'Ama Mensah', email: 'ama@example.com', phone: '+233200000000' },
    });
    expect(contactOf(guest)).toEqual({
      name: 'Ama Mensah',
      email: 'ama@example.com',
      phone: '+233200000000',
    });
  });

  it('falls back to the lead traveller when neither row exists', () => {
    const lead = booking({ customer: null, guest: null });
    expect(contactOf(lead).name).toBe('Priscilla Hankins');
    expect(contactOf(lead).email).toBe('hankins460@gmail.com');
  });
});

describe('collectedTotals', () => {
  it('only counts collections in the booking currency', () => {
    const b = booking({
      collections: [
        { amount: '300.00', currency: 'USD', status: 'RECORDED' },
        { amount: '200.00', currency: 'GHS', status: 'RECORDED' },
      ],
    });
    expect(collectedTotals(b).total).toBe(300);
    expect(collectedTotals(b).count).toBe(1);
  });

  it('ignores reversed corrections', () => {
    const b = booking({
      collections: [
        { amount: '300.00', currency: 'USD', status: 'RECORDED' },
        { amount: '300.00', currency: 'USD', status: 'REVERSED' },
      ],
    });
    expect(collectedTotals(b).total).toBe(300);
  });
});

describe('statusOf', () => {
  it('reports a settled card payment as paid', () => {
    expect(statusOf(booking()).key).toBe('paid');
  });

  it('does not claim payment is pending when the supplier collected the full amount', () => {
    const offline = booking({
      paymentStatus: 'PENDING',
      paidAt: null,
      stripePaymentIntentId: null,
      collections: [{ amount: '540.00', currency: 'USD', status: 'RECORDED', method: 'CASH' }],
    });
    const status = statusOf(offline);
    expect(status.key).toBe('collected');
    expect(status.hero).toBe('PAYMENT RECEIVED IN FULL');
  });

  it('flags a deposit as a part payment', () => {
    const deposit = booking({
      paymentStatus: 'PENDING',
      stripePaymentIntentId: null,
      collections: [{ amount: '200.00', currency: 'USD', status: 'RECORDED', method: 'CASH' }],
    });
    expect(statusOf(deposit).key).toBe('partial');
    expect(statusOf(deposit).label).toBe('PART PAYMENT');
  });

  it('reports pending when nothing was collected', () => {
    const pending = booking({ paymentStatus: 'PENDING', stripePaymentIntentId: null, paidAt: null });
    expect(statusOf(pending).key).toBe('pending');
  });

  it('reports refunds ahead of the processor status', () => {
    expect(statusOf(booking({ refundAmount: '540.00' })).key).toBe('refunded');
    expect(statusOf(booking({ paymentStatus: 'REFUNDED' })).key).toBe('refunded');
  });

  it('reports a failed charge as failed, not pending', () => {
    expect(statusOf(booking({ paymentStatus: 'FAILED' })).key).toBe('failed');
  });
});


describe('paymentTimingNote', () => {
  it('records the two stages of a reserve-now-pay-later booking', () => {
    const note = paymentTimingNote(booking());
    expect(note.label).toBe('Reserve now, pay later');
    expect(note.detail).toContain('Charged 3 Nov 2026 · 00:19 UTC');
    expect(note.detail).toContain('1 day before the activity');
  });

  it('says the card is on file when the sweep has not charged yet', () => {
    const note = paymentTimingNote(
      booking({ paymentTiming: 'later', paymentStatus: 'PENDING', paidAt: null }),
    );
    expect(note.label).toBe('Reserve now, pay later');
    expect(note.detail).toMatch(/Card on file/);
  });

  it('describes a booking paid at checkout plainly', () => {
    const note = paymentTimingNote(booking({ paymentTiming: 'now' }));
    expect(note.label).toBe('Charged at booking');
    expect(note.detail).toContain('3 Nov 2026');
  });
});

describe('chargeLeadTime', () => {
  it('counts whole days between the charge and the activity', () => {
    expect(chargeLeadTime(booking())).toBe('1 day before the activity');
  });

  it('handles a same-day charge', () => {
    expect(
      chargeLeadTime(booking({ paidAt: new Date('2026-11-04T08:00:00Z') })),
    ).toBe('on the day of the activity');
  });

  it('returns null when either timestamp is missing or the charge is after travel', () => {
    expect(chargeLeadTime(booking({ paidAt: null }))).toBeNull();
    expect(chargeLeadTime(booking({ paidAt: new Date('2026-11-09T00:00:00Z') }))).toBeNull();
  });
});

describe('renderProofOfPaymentPdf', () => {
  it('renders a single-page PDF for a settled card booking', async () => {
    const buffer = await renderProofOfPaymentPdf({
      booking: booking(),
      settlement: SETTLEMENT,
      brandKey: 'ghana',
      issuedAt: new Date('2026-11-20T12:00:00Z'),
      compress: false,
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buffer)).toBe(1);
    expect(buffer.length).toBeGreaterThan(3000);
  });

  it('renders without settlement facts (Stripe unreachable) instead of throwing', async () => {
    const buffer = await renderProofOfPaymentPdf({
      booking: booking(),
      settlement: { error: 'Stripe timeout' },
      brandKey: 'ghana',
      compress: false,
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buffer)).toBe(1);
  });

  it('renders a PayPal receipt', async () => {
    const buffer = await renderProofOfPaymentPdf({
      booking: booking({
        paymentProvider: 'PAYPAL',
        stripePaymentIntentId: null,
        paypalOrderId: '5O190127TN364715T',
        paypalCaptureId: '3C679366HH908993F',
      }),
      brandKey: 'ghana',
      compress: false,
    });
    expect(pageCount(buffer)).toBe(1);
  });

  it('renders an offline booking with several collections', async () => {
    const buffer = await renderProofOfPaymentPdf({
      booking: booking({
        paymentStatus: 'PENDING',
        stripePaymentIntentId: null,
        collections: [
          { amount: '300.00', currency: 'USD', method: 'CASH', status: 'RECORDED', collectedAt: new Date('2026-11-01T10:00:00Z') },
          { amount: '240.00', currency: 'USD', method: 'MOBILE_MONEY', status: 'RECORDED', collectedAt: new Date('2026-11-02T10:00:00Z') },
        ],
      }),
      brandKey: 'ghana',
      compress: false,
    });
    expect(pageCount(buffer)).toBe(1);
  });

  it('survives a corrupt logo buffer instead of losing the document', async () => {
    const buffer = await renderProofOfPaymentPdf({
      booking: booking(),
      settlement: SETTLEMENT,
      logo: Buffer.from('not-a-png'),
      brandKey: 'ghana',
      compress: false,
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects without a booking number', async () => {
    await expect(renderProofOfPaymentPdf({ booking: {} })).rejects.toThrow(/bookingNumber/);
    await expect(renderProofOfPaymentPdf({})).rejects.toThrow(/bookingNumber/);
  });
});
