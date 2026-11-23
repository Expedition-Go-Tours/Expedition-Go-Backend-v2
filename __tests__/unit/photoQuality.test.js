/**
 * The upload gate.
 *
 * These thresholds are not taste: a phone tile renders at 366px (≈1100 at 3×)
 * and the desktop hero column at ~816px (≈1630 at 2×), so 1280 is the floor and
 * 2048 is what keeps the hero sharp. The live catalogue had 9 of 14 sampled
 * photos under 1280px, two of them portrait — exactly what this rejects.
 */
const { assessDimensions, MIN_PHOTO_WIDTH } = require('../../src/core/services/photoQuality');
const { validateTourForReview } = require('../../src/core/domain/tourController');

describe('assessDimensions', () => {
  it('accepts a landscape photo at the floor and marks 2048 as sharp', () => {
    const floor = assessDimensions({ width: MIN_PHOTO_WIDTH, height: 960 });
    expect(floor.ok).toBe(true);
    expect(floor.lowRes).toBe(true);

    const sharp = assessDimensions({ width: 2048, height: 1536 });
    expect(sharp.ok).toBe(true);
    expect(sharp.lowRes).toBe(false);
  });

  it('rejects a portrait photo and names the shape', () => {
    const verdict = assessDimensions({ width: 645, height: 799 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/portrait/i);
    expect(verdict.reason).toContain('645×799');
  });

  it('rejects a photo narrower than 1280 even when it is landscape', () => {
    const verdict = assessDimensions({ width: 1210, height: 680 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/too small/i);
    expect(verdict.reason).toContain('1280');
  });

  it('rejects a square photo below the floor', () => {
    expect(assessDimensions({ width: 755, height: 755 }).ok).toBe(false);
  });

  it('rejects an unreadable size instead of guessing', () => {
    expect(assessDimensions({}).ok).toBe(false);
    expect(assessDimensions(null).ok).toBe(false);
    expect(assessDimensions({ width: 0, height: 0 }).ok).toBe(false);
  });
});

describe('validateTourForReview photos', () => {
  const tour = (photos) => ({
    title: 'The North Safari',
    description: 'A sufficiently long description for validation.',
    photos,
    categorization: { category: 'tour' },
    productContent: {
      writingLanguage: 'English',
      highlights: ['One'],
      locations: [{ name: 'Mole National Park' }],
      meetingMode: 'none',
    },
  });

  it('requires five photos, not one', () => {
    const errors = validateTourForReview(tour(['a.jpg']));
    expect(errors.join(' ')).toMatch(/at least 5 photos/i);
    expect(errors.join(' ')).toContain('you have 1');
  });

  it('passes once five photos are present', () => {
    const errors = validateTourForReview(tour(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']));
    expect(errors.join(' ')).not.toMatch(/photos/i);
  });

  it('ignores empty slots in the photo array', () => {
    const errors = validateTourForReview(tour(['a.jpg', '', null, undefined]));
    expect(errors.join(' ')).toMatch(/at least 5 photos/i);
  });
});
