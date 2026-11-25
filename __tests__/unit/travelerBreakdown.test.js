const {
  categoryKeyForLabel,
  travelerParts,
  travelerLabel,
} = require('../../src/core/services/travelerBreakdown');

describe('travelerBreakdown', () => {
  it('counts every numeric category and ignores metadata', () => {
    const parts = travelerParts({
      adults: 1,
      seniors: 2,
      students: 1,
      phoneNumber: '+233200000000',
      location: 'Accra',
      details: [{ ageGroup: 'adult' }],
    });

    expect(parts).toEqual([
      { key: 'adults', count: 1, singular: 'adult', plural: 'adults' },
      { key: 'seniors', count: 2, singular: 'senior', plural: 'seniors' },
      { key: 'students', count: 1, singular: 'student', plural: 'students' },
    ]);
    expect(travelerLabel({ adults: 1, seniors: 2 })).toBe('1 adult, 2 seniors');
    expect(travelerLabel({ adults: 1, phoneNumber: '233201234567' })).toBe('1 adult');
  });

  it('keeps the familiar buckets first and sorts supplier categories after them', () => {
    expect(travelerParts({ youth: 1, infants: 1, adults: 1, children: 1 }).map((p) => p.key))
      .toEqual(['adults', 'children', 'infants', 'youth']);
  });

  it('uses details only when the booking has no numeric counts', () => {
    const parts = travelerParts({
      details: [
        { ageGroup: 'Adult' },
        { ageGroup: 'Senior', count: 2 },
        { ageGroup: 'student' },
      ],
    });

    expect(parts.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: 'adults', count: 1 },
      { key: 'seniors', count: 2 },
      { key: 'students', count: 1 },
    ]);
  });

  it('normalizes category labels to payload keys', () => {
    expect(categoryKeyForLabel('Senior Citizen')).toBe('seniorcitizens');
    expect(categoryKeyForLabel('Child')).toBe('children');
    expect(categoryKeyForLabel('Youth')).toBe('youths');
  });

  it('returns no parts for malformed payloads', () => {
    expect(travelerParts(null)).toEqual([]);
    expect(travelerParts('travelers')).toEqual([]);
    expect(travelerParts([])).toEqual([]);
  });
});
