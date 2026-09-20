const { matchTourForTitle, normalizeTitle } = require('../../src/core/services/externalReviewMatcher');

const TOURS = [
  { id: 't1', title: 'Cape Coast Castle, Elmina Castle & Kakum National Park Day Tour', location: 'Accra, Ghana' },
  { id: 't2', title: 'Shai Hills Safari & Akosombo Boat Cruise Day Tour', location: 'Accra, Ghana' },
  { id: 't3', title: 'Accra Guided City Tour: Cultural and Historical Experience', location: 'Accra, Ghana' },
  { id: 't4', title: 'The Kumasi Cultural and Heritage Day Tour', location: 'Accra, Ghana' },
];

describe('externalReviewMatcher', () => {
  describe('normalizeTitle', () => {
    it('lowercases, strips punctuation and folds accents', () => {
      expect(normalizeTitle('Café & Bar — Day Tour!')).toBe('cafe and bar day tour');
    });
  });

  describe('matchTourForTitle', () => {
    it('matches an exact title', () => {
      expect(matchTourForTitle('Cape Coast Castle, Elmina Castle & Kakum National Park Day Tour', TOURS)?.id).toBe('t1');
    });

    it('matches a platform variant through token overlap', () => {
      expect(matchTourForTitle('Cape Coast Castle & Elmina Castle Tour', TOURS)?.id).toBe('t1');
    });

    it('matches through attraction aliases when titles differ', () => {
      expect(matchTourForTitle('Shai Hills Safari with Akosombo Cruise', TOURS)?.id).toBe('t2');
    });

    it('does not match a business-level row', () => {
      expect(matchTourForTitle('Expedition-Go Tours LTD', TOURS)).toBeNull();
    });

    it('does not match on a generic location word alone', () => {
      expect(matchTourForTitle('Accra', TOURS)).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(matchTourForTitle('', TOURS)).toBeNull();
      expect(matchTourForTitle('Something', [])).toBeNull();
    });
  });
});
