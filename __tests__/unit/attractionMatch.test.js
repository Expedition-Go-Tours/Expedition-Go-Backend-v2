const {
  normalizeName,
  variantsFor,
  buildAttractionIndex,
  canonicalFor,
} = require('../../utils/attractionMatch');

describe('attractionMatch', () => {
  describe('normalizeName', () => {
    it('lowercases, strips accents and punctuation, collapses whitespace', () => {
      expect(normalizeName("St. George's Castle")).toBe('st george s castle');
      expect(normalizeName('  Kakum   National Park ')).toBe('kakum national park');
      expect(normalizeName('Café / Musée')).toBe('cafe musee');
    });

    it('handles null and undefined', () => {
      expect(normalizeName(null)).toBe('');
      expect(normalizeName(undefined)).toBe('');
    });
  });

  describe('variantsFor', () => {
    it('returns the name plus each alias', () => {
      const v = variantsFor({ name: 'Boti Falls', aliases: 'Boti Waterfalls; Boti Falls Ghana' });
      expect(v).toEqual(expect.arrayContaining(['Boti Falls', 'Boti Waterfalls', 'Boti Falls Ghana']));
    });

    it('splits on comma and pipe too', () => {
      const v = variantsFor({ name: 'X', aliases: 'A, B | C' });
      expect(v).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    });

    it('handles missing aliases', () => {
      expect(variantsFor({ name: 'Solo' })).toEqual(['Solo']);
      expect(variantsFor({ name: 'Solo', aliases: null })).toEqual(['Solo']);
      expect(variantsFor(null)).toEqual([]);
    });
  });

  describe('buildAttractionIndex + canonicalFor', () => {
    const rows = [
      { id: '1', name: 'Boti Falls', aliases: 'Boti Waterfalls; Boti Falls Ghana' },
      { id: '2', name: 'Kakum National Park', aliases: 'Kakum Canopy Walkway; canopy walk' },
      { id: '3', name: 'Elmina Castle', aliases: null },
    ];

    it('resolves an itinerary variant to the canonical attraction', () => {
      const index = buildAttractionIndex(rows);
      expect(canonicalFor(index, 'Boti Waterfalls').name).toBe('Boti Falls');
      expect(canonicalFor(index, 'kakum canopy walkway').name).toBe('Kakum National Park');
      expect(canonicalFor(index, 'Elmina Castle').name).toBe('Elmina Castle');
    });

    it('is case and punctuation insensitive', () => {
      const index = buildAttractionIndex(rows);
      expect(canonicalFor(index, 'BOTI WATERFALLS').name).toBe('Boti Falls');
      expect(canonicalFor(index, 'boti-waterfalls').name).toBe('Boti Falls');
    });

    it('returns null for unknown stops and empty input', () => {
      const index = buildAttractionIndex(rows);
      expect(canonicalFor(index, 'Nowhere Special')).toBeNull();
      expect(canonicalFor(index, '')).toBeNull();
      expect(canonicalFor(null, 'Boti Falls')).toBeNull();
    });

    it('keeps the first attraction on a spelling collision', () => {
      const index = buildAttractionIndex([
        { id: 'a', name: 'Twin Falls', aliases: null },
        { id: 'b', name: 'Other', aliases: 'Twin Falls' },
      ]);
      expect(canonicalFor(index, 'Twin Falls').id).toBe('a');
    });

    it('tolerates rows without a name', () => {
      const index = buildAttractionIndex([{ id: 'x', aliases: 'Ghost' }, { id: 'y', name: 'Real' }]);
      expect(index.has('ghost')).toBe(false);
      expect(canonicalFor(index, 'Real').id).toBe('y');
    });
  });
});
