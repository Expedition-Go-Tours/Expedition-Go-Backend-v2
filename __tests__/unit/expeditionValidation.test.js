const { confirmBookingSchema } = require('../../utils/expeditionValidation');

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
