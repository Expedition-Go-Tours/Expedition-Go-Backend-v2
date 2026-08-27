const { confirmBookingSchema, calculateCheckoutSchema } = require('../../utils/expeditionValidation');

const basePayload = {
  body: {
    tourId: 'tour-1',
    travelDate: '2026-08-15',
    travelers: { adults: 1, phoneNumber: '+12025551234', location: 'New York, USA' },
    paymentMethodId: 'pm_123',
  },
  query: {},
  params: {},
};

describe('confirmBookingSchema phone validation', () => {
  it('accepts a valid international phone number', () => {
    const result = confirmBookingSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
  });

  it('normalizes a leading-zero national prefix with the country code', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: {
        ...basePayload.body,
        travelers: { adults: 1, phoneNumber: '+2330241234567', location: 'Accra, Ghana' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts formatting such as spaces, hyphens and parentheses', () => {
    const variants = [
      '+233 24 123 4567',
      '+233-241-234-567',
      '+1 (202) 555-1234',
      '+44 (0) 20 7946 0958',
    ];
    for (const phoneNumber of variants) {
      const result = confirmBookingSchema.safeParse({
        ...basePayload,
        body: { ...basePayload.body, travelers: { adults: 1, phoneNumber, location: 'Test' } },
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects a national number without the country code', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: {
        ...basePayload.body,
        travelers: { adults: 1, phoneNumber: '241234567', location: 'Accra, Ghana' },
      },
    });
    expect(result.success).toBe(false);
    const issue = result.error.issues[0];
    expect(issue.path).toEqual(['body', 'travelers', 'phoneNumber']);
    expect(issue.message).toContain('Invalid phone number');
    expect(issue.message).toContain('international format');
  });

  it('rejects an invalid international number and echoes the received value', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: {
        ...basePayload.body,
        travelers: { adults: 1, phoneNumber: '+15551234', location: 'Test' },
      },
    });
    expect(result.success).toBe(false);
    const issue = result.error.issues[0];
    expect(issue.message).toContain('+15551234');
  });

  it('rejects an empty phone number', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: {
        ...basePayload.body,
        travelers: { adults: 1, phoneNumber: '', location: 'Test' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a pay-now payload without a payment method', () => {
    const body = { ...basePayload.body };
    delete body.paymentMethodId;
    const result = confirmBookingSchema.safeParse({ ...basePayload, body });
    expect(result.success).toBe(true);
  });
});

describe('confirmBookingSchema selectedDate → travelDate alias', () => {
  it('accepts selectedDate and maps it to travelDate', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: { ...basePayload.body, selectedDate: '2026-09-01', travelDate: undefined },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.travelDate).toBe('2026-09-01');
  });

  it('prefers travelDate over selectedDate when both present', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: { ...basePayload.body, travelDate: '2026-09-01', selectedDate: '2026-10-01' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.travelDate).toBe('2026-09-01');
  });

  it('rejects when neither travelDate nor selectedDate is present', () => {
    const body = { ...basePayload.body };
    delete body.travelDate;
    const result = confirmBookingSchema.safeParse({ ...basePayload, body });
    expect(result.success).toBe(false);
  });
});

describe('confirmBookingSchema optional travelers.location', () => {
  it('accepts travelers without location', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: {
        ...basePayload.body,
        travelers: { adults: 1, phoneNumber: '+12025551234' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('still accepts travelers with location', () => {
    const result = confirmBookingSchema.safeParse(basePayload);
    expect(result.success).toBe(true);
  });
});

describe('confirmBookingSchema passthrough fields', () => {
  it('passes through pickup', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: { ...basePayload.body, pickup: { skipValidation: true } },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.pickup).toEqual({ skipValidation: true });
  });

  it('passes through leadTraveler', () => {
    const lt = { name: 'John Doe', email: 'john@example.com', phone: '+12025551234' };
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: { ...basePayload.body, leadTraveler: lt },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.leadTraveler).toEqual(lt);
  });

  it('passes through promoCode', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: { ...basePayload.body, promoCode: 'SUMMER20' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.promoCode).toBe('SUMMER20');
  });

  it('passes through selectedTime', () => {
    const result = confirmBookingSchema.safeParse({
      ...basePayload,
      body: { ...basePayload.body, selectedTime: '10:00' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.selectedTime).toBe('10:00');
  });
});

describe('calculateCheckoutSchema', () => {
  const baseCalc = {
    body: {
      tourId: 'tour-1',
      travelDate: '2026-08-15',
      travelers: { adults: 2, children: 1 },
    },
    query: {},
    params: {},
  };

  it('accepts a valid payload', () => {
    const result = calculateCheckoutSchema.safeParse(baseCalc);
    expect(result.success).toBe(true);
  });

  it('accepts selectedDate as alias for travelDate', () => {
    const result = calculateCheckoutSchema.safeParse({
      ...baseCalc,
      body: { ...baseCalc.body, selectedDate: '2026-09-01', travelDate: undefined },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.travelDate).toBe('2026-09-01');
  });

  it('prefers travelDate over selectedDate', () => {
    const result = calculateCheckoutSchema.safeParse({
      ...baseCalc,
      body: { ...baseCalc.body, travelDate: '2026-09-01', selectedDate: '2026-10-01' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.travelDate).toBe('2026-09-01');
  });

  it('rejects when neither travelDate nor selectedDate is present', () => {
    const body = { ...baseCalc.body };
    delete body.travelDate;
    const result = calculateCheckoutSchema.safeParse({ ...baseCalc, body });
    expect(result.success).toBe(false);
  });

  it('passes through promoCode and selectedTime', () => {
    const result = calculateCheckoutSchema.safeParse({
      ...baseCalc,
      body: { ...baseCalc.body, promoCode: 'FALL10', selectedTime: '14:00' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.promoCode).toBe('FALL10');
    expect(result.data.body.selectedTime).toBe('14:00');
  });

  it('rejects travelDate with wrong format', () => {
    const result = calculateCheckoutSchema.safeParse({
      ...baseCalc,
      body: { ...baseCalc.body, travelDate: '15-08-2026' },
    });
    expect(result.success).toBe(false);
  });
});
