/**
 * Ghana's 16 administrative regions and their capitals.
 *
 * Single source of truth: the attractions XLSX import and the homepage
 * "Popular Destinations" section both bucket places by region, so they must
 * agree on which city represents a region.
 */

const GHANA_REGION_CAPITALS = {
  'Greater Accra': 'Accra',
  Ashanti: 'Kumasi',
  Central: 'Cape Coast',
  Eastern: 'Koforidua',
  Western: 'Sekondi-Takoradi',
  Volta: 'Ho',
  Bono: 'Sunyani',
  Northern: 'Tamale',
  Oti: 'Dambai',
  'Bono East': 'Techiman',
  Ahafo: 'Goaso',
  Savannah: 'Damongo',
  'North East': 'Nalerigu',
  'Upper East': 'Bolgatanga',
  'Upper West': 'Wa',
  'Western North': 'Sefwi Wiawso',
};

const GHANA_REGION_KEYS = new Map(
  Object.keys(GHANA_REGION_CAPITALS).map((r) => [r.toLowerCase(), r])
);

/**
 * The canonical bare region name ("Eastern") for any spelling the catalog uses
 * ("Eastern", "Eastern Region", "eastern region"), or null when it is not one
 * of Ghana's 16 regions.
 */
function canonicalGhanaRegion(region) {
  const s = String(region || '').trim().replace(/\s+region$/i, '').trim();
  if (!s) return null;
  return GHANA_REGION_KEYS.get(s.toLowerCase()) || null;
}

/**
 * The capital city for a region in any of its spellings, or null when the
 * region is unknown.
 */
function capitalForRegion(region) {
  const canonical = canonicalGhanaRegion(region);
  return canonical ? GHANA_REGION_CAPITALS[canonical] : null;
}

/** The bare region for a capital city ("Accra" → "Greater Accra"), or null. */
function regionForCapital(city) {
  const target = String(city || '').trim().toLowerCase();
  if (!target) return null;
  for (const [region, capital] of Object.entries(GHANA_REGION_CAPITALS)) {
    if (capital.toLowerCase() === target) return region;
  }
  return null;
}

module.exports = {
  GHANA_REGION_CAPITALS,
  canonicalGhanaRegion,
  capitalForRegion,
  regionForCapital,
};
