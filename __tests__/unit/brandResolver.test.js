const { resolveBrand, hostnameOf } = require('../../utils/brandResolver');

describe('brandResolver', () => {
  describe('hostnameOf', () => {
    it('extracts the host from an origin, URL, or bare host', () => {
      expect(hostnameOf('https://travioghana.com')).toBe('travioghana.com');
      expect(hostnameOf('https://supplier.travioghana.com/login')).toBe('supplier.travioghana.com');
      expect(hostnameOf('api.travioghana.com:443')).toBe('api.travioghana.com');
      expect(hostnameOf('TRAVIOGHANA.COM')).toBe('travioghana.com');
    });

    it('returns null for empty or unusable input', () => {
      expect(hostnameOf('')).toBeNull();
      expect(hostnameOf(null)).toBeNull();
      expect(hostnameOf(undefined)).toBeNull();
      expect(hostnameOf(42)).toBeNull();
    });
  });

  describe('resolveBrand', () => {
    it('maps Ghana storefront and API hosts to ghana', () => {
      expect(resolveBrand('https://travioghana.com')).toBe('ghana');
      expect(resolveBrand('https://www.travioghana.com')).toBe('ghana');
      expect(resolveBrand('https://supplier.travioghana.com')).toBe('ghana');
      expect(resolveBrand('api.travioghana.com')).toBe('ghana');
    });

    it('maps Expedition hosts to expedition', () => {
      expect(resolveBrand('https://expeditiongotours.com')).toBe('expedition');
      expect(resolveBrand('https://www.expeditiongotours.com')).toBe('expedition');
    });

    it('falls back to default for TravioAfrica and unknown hosts', () => {
      expect(resolveBrand('https://travioafrica.com')).toBe('default');
      expect(resolveBrand('https://supplier.travioafrica.com')).toBe('default');
      expect(resolveBrand('https://expedition-go-frontend.vercel.app')).toBe('default');
      expect(resolveBrand('')).toBe('default');
    });

    it('does not match brand names embedded in other domains', () => {
      expect(resolveBrand('https://evil-travioghana.com')).toBe('default');
      expect(resolveBrand('https://travioghana.com.attacker.io')).toBe('default');
    });
  });
});
