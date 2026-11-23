const {
  classifyPhoto,
  MIN_PHOTO_WIDTH,
  IDEAL_PHOTO_WIDTH,
} = require('../../src/core/services/photoAudit');

describe('classifyPhoto', () => {
  it('flags a portrait photo', () => {
    expect(classifyPhoto({ width: 645, height: 799 })).toEqual({
      problem: 'portrait',
      width: 645,
      height: 799,
    });
  });

  it('flags a landscape photo under the floor', () => {
    expect(classifyPhoto({ width: 1210, height: 680 }).problem).toBe('too-small');
  });

  it('flags a photo that is usable but soft on the desktop hero', () => {
    expect(classifyPhoto({ width: MIN_PHOTO_WIDTH, height: 960 }).problem).toBe('soft-on-desktop');
    expect(classifyPhoto({ width: IDEAL_PHOTO_WIDTH - 1, height: 1000 }).problem).toBe('soft-on-desktop');
  });

  it('passes a photo at the ideal width', () => {
    expect(classifyPhoto({ width: IDEAL_PHOTO_WIDTH, height: 1536 })).toBeNull();
    expect(classifyPhoto({ width: 2078, height: 1170 })).toBeNull();
  });

  it('returns null rather than guessing when the size is unreadable', () => {
    expect(classifyPhoto({})).toBeNull();
    expect(classifyPhoto(null)).toBeNull();
    expect(classifyPhoto({ width: 0, height: 0 })).toBeNull();
  });

  it('treats a square photo below the floor as too small', () => {
    expect(classifyPhoto({ width: 755, height: 755 }).problem).toBe('too-small');
  });
});
