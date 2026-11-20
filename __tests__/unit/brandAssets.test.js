/**
 * Brand logo loading for generated PDFs: a receipt must still render when
 * Cloudinary is unreachable, and the bitmap must never be refetched per
 * download.
 */

const { getBrandLogo, clearBrandLogoCache } = require('../../src/core/services/brandAssets');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082',
  'hex',
);

function pngResponse() {
  return { ok: true, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
}

beforeEach(() => {
  clearBrandLogoCache();
  jest.restoreAllMocks();
});

describe('getBrandLogo', () => {
  it('returns a PNG buffer and caches it', async () => {
    const fetchMock = jest.fn().mockResolvedValue(pngResponse());
    global.fetch = fetchMock;

    const first = await getBrandLogo('ghana');
    const second = await getBrandLogo('ghana');

    expect(Buffer.isBuffer(first)).toBe(true);
    expect(first.equals(PNG)).toBe(true);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-200 response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(getBrandLogo('ghana')).resolves.toBeNull();
  });

  it('returns null when the payload is not a PNG', async () => {
    const junk = Buffer.from('<html>nope</html>');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.byteLength),
    });
    await expect(getBrandLogo('ghana')).resolves.toBeNull();
  });

  it('returns null instead of throwing when the network fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(getBrandLogo('ghana')).resolves.toBeNull();
  });

  it('does not cache failures, so a later request can recover', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(pngResponse());

    await expect(getBrandLogo('ghana')).resolves.toBeNull();
    const recovered = await getBrandLogo('ghana');
    expect(Buffer.isBuffer(recovered)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
