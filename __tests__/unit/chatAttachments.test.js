/**
 * Inbound email attachment helpers.
 */

const { classify, isAllowed } = require('../../utils/chatAttachments');

describe('chatAttachments', () => {
  it('classifies images as image and everything else as document', () => {
    expect(classify('image/jpeg')).toBe('image');
    expect(classify('image/png')).toBe('image');
    expect(classify('application/pdf')).toBe('document');
    expect(classify('video/mp4')).toBe('document');
  });

  it('enforces the size caps per type', () => {
    expect(isAllowed('image/png', 1024)).toBe(true);
    expect(isAllowed('image/png', 9 * 1024 * 1024)).toBe(false);
    expect(isAllowed('application/pdf', 10 * 1024 * 1024)).toBe(true);
    expect(isAllowed('application/pdf', 20 * 1024 * 1024)).toBe(false);
  });

  it('rejects unknown / executable types and zero sizes', () => {
    expect(isAllowed('application/octet-stream', 100)).toBe(false);
    expect(isAllowed('application/x-msdownload', 100)).toBe(false);
    expect(isAllowed('application/pdf', 100)).toBe(true);
    expect(isAllowed('text/plain', 100)).toBe(true);
    expect(isAllowed('image/png', 0)).toBe(false);
  });
});
