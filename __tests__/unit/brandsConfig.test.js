/**
 * Audit events about a booking are labelled by where the BOOKING was taken,
 * not by whichever storefront handled the request.
 *
 * That distinction only started mattering when cancellations and pickup edits
 * stopped being scoped to the selling storefront: before it, Ghana's cancel
 * logged `source: 'expedition'` unconditionally — every customer cancel on
 * travioghana.com filed under the wrong platform.
 */
const { eventNamespaceForSource, getDefaultBrand, BRANDS } = require('../../config/brands');

describe('eventNamespaceForSource', () => {
  it.each([
    ['EXPEDITION', 'expedition'],
    ['GHANA', 'ghana'],
    ['TRAVIO_AFRICA', 'travioafrica'],
  ])('maps BookingSource.%s to the %s namespace', (source, expected) => {
    expect(eventNamespaceForSource(source)).toBe(expected);
  });

  it('follows the brand config instead of duplicating it', () => {
    // If a brand's eventNamespace is ever renamed, this follows automatically —
    // there is no second copy to fall out of step.
    const sources = Object.values(BRANDS).map((brand) => brand.source);
    expect(sources).toEqual(expect.arrayContaining(['EXPEDITION', 'GHANA', 'TRAVIO_AFRICA']));
    for (const source of sources) {
      const brand = Object.values(BRANDS).find((b) => b.source === source);
      expect(eventNamespaceForSource(source)).toBe(brand.eventNamespace);
    }
  });

  it('labels legacy TRAVIO bookings as travio rather than pinning them to a default', () => {
    // BookingSource.TRAVIO is the schema default and no brand claims it, so
    // falling back to the default brand would file them under whichever
    // storefront happens to be default today.
    expect(eventNamespaceForSource('TRAVIO')).toBe('travio');
  });

  it('accepts lowercase, since some call sites pass it that way', () => {
    expect(eventNamespaceForSource('ghana')).toBe('ghana');
  });

  it('falls back to the default brand when there is no source at all', () => {
    const fallback = getDefaultBrand().eventNamespace;

    expect(eventNamespaceForSource(null)).toBe(fallback);
    expect(eventNamespaceForSource('')).toBe(fallback);
  });
});
