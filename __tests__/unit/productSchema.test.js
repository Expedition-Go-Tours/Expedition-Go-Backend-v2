const { productSchema, productSchemaPartial } = require('../../utils/productSchema');

describe('productSchema — meeting/pickup description limits', () => {
  it('rejects pickupDescription over 200 characters (partial)', () => {
    const result = productSchemaPartial.safeParse({ pickupDescription: 'x'.repeat(201) });
    expect(result.success).toBe(false);
  });

  it('accepts pickupDescription at exactly 200 characters (partial)', () => {
    const result = productSchemaPartial.safeParse({ pickupDescription: 'x'.repeat(200) });
    expect(result.success).toBe(true);
  });

  it('accepts meetingPointDescription at exactly 200 characters (partial)', () => {
    const result = productSchemaPartial.safeParse({ meetingPointDescription: 'x'.repeat(200) });
    expect(result.success).toBe(true);
  });

  it('rejects meetingPointDescription over 200 characters (partial)', () => {
    const result = productSchemaPartial.safeParse({ meetingPointDescription: 'x'.repeat(201) });
    expect(result.success).toBe(false);
  });

  it('keeps both description fields optional', () => {
    const result = productSchemaPartial.safeParse({ pickupDescription: '', meetingPointDescription: '' });
    expect(result.success).toBe(true);
  });
});

describe('productSchema — arrivalTimeType enum', () => {
  it('accepts 20min and 25min (partial)', () => {
    expect(productSchemaPartial.safeParse({ arrivalTimeType: '20min' }).success).toBe(true);
    expect(productSchemaPartial.safeParse({ arrivalTimeType: '25min' }).success).toBe(true);
  });

  it('accepts 20min and 25min (full)', () => {
    const minimalValid = {
      language: 'en',
      category: 'tour',
      title: 'Test Tour',
      shortDescription: 'x'.repeat(10),
      fullDescription: 'x'.repeat(500),
      highlights: ['a', 'b', 'c'],
      photos: ['p1', 'p2', 'p3', 'p4', 'p5'],
      meetingMode: 'meeting_point',
      wifiIncluded: true,
      guideMaterials: { audioGuide: true, infoBooklet: false },
    };
    expect(productSchema.safeParse({ ...minimalValid, arrivalTimeType: '20min' }).success).toBe(true);
    expect(productSchema.safeParse({ ...minimalValid, arrivalTimeType: '25min' }).success).toBe(true);
  });
});

describe('productSchema — pickupArea time optional', () => {
  it('accepts a pickup area without a time key (partial)', () => {
    const result = productSchemaPartial.safeParse({
      pickupAreas: [{ name: 'Downtown' }],
    });
    expect(result.success).toBe(true);
  });

  it('still requires a pickup area name', () => {
    const result = productSchemaPartial.safeParse({
      pickupAreas: [{ name: '' }],
    });
    expect(result.success).toBe(false);
  });
});
