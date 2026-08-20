const { normalizeCommissionRate, DEFAULT_COMMISSION_RATE } = require('../../utils/commission');

describe('normalizeCommissionRate', () => {
  it('returns a decimal-fraction input unchanged', () => {
    expect(normalizeCommissionRate('0.15')).toBe(0.15);
    expect(normalizeCommissionRate(0.15)).toBe(0.15);
  });

  it('converts percentage-style input to a fraction', () => {
    expect(normalizeCommissionRate('15')).toBeCloseTo(0.15, 5);
    expect(normalizeCommissionRate(10)).toBeCloseTo(0.1, 5);
    expect(normalizeCommissionRate('15%')).toBeCloseTo(0.15, 5);
  });

  it('clamps rates above 100% down to 1', () => {
    expect(normalizeCommissionRate('150')).toBe(1);
    expect(normalizeCommissionRate(500)).toBe(1);
  });

  it('falls back to the default for invalid input', () => {
    expect(normalizeCommissionRate('abc')).toBe(DEFAULT_COMMISSION_RATE);
    expect(normalizeCommissionRate(null)).toBe(DEFAULT_COMMISSION_RATE);
    expect(normalizeCommissionRate(undefined)).toBe(DEFAULT_COMMISSION_RATE);
    expect(normalizeCommissionRate('0')).toBe(DEFAULT_COMMISSION_RATE);
    expect(normalizeCommissionRate(-5)).toBe(DEFAULT_COMMISSION_RATE);
  });

  it('honors a custom fallback', () => {
    expect(normalizeCommissionRate('abc', null)).toBeNull();
    expect(normalizeCommissionRate('0.12', null)).toBe(0.12);
  });
});