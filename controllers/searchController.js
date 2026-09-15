/**
 * Unified search endpoint — combines tours, attractions, places, and regions
 * into a single scored result list. Server-side equivalent of the prototype's
 * getSearchResults() + scoreRecord().
 *
 * GET /api/search?q=&scope=&limit=
 *
 * Scoring tiers (from prototype):
 *   1000  exact name match
 *    985  compact (no spaces/punct) match
 *    910  prefix match
 *    855  word-prefix match
 *    835  alias exact match
 *    800  alias prefix match
 *    745  contains match
 *    725  compact-contains match
 *    675  all-tokens match
 *    610  edit-distance match
 *    535  fuzzy-token match
 *
 * Kind bonuses: place +priorityBoost+attractionCount; attraction +18; region +8
 */

const crypto = require('crypto');
const prisma = require('../utils/prismaClient');
const cache = require('../utils/cacheHelper');
const { placeTourCount } = require('../utils/placeListing');
const catchAsync = require('../utils/catchAsync');

/* ── Ghana regions ──────────────────────────────────────────────────────── */
const GHANA_REGIONS = [
  'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern',
  'Greater Accra', 'North East', 'Northern', 'Oti', 'Savannah',
  'Upper East', 'Upper West', 'Volta', 'Western', 'Western North',
];

/* ── Normalisation (matches prototype exactly) ──────────────────────────── */
function normaliseSearch(x) {
  return String(x || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactSearch(x) {
  return normaliseSearch(x).replace(/\s+/g, '');
}

/**
 * Does `needle` occur in `haystack` starting at a word boundary?
 *
 * Raw `includes` produces mid-word false positives — searching "tema" matched
 * "Asan·tema·nso". Anchoring to a boundary keeps genuine middle-of-name matches
 * ("kakum" in "Cape Coast Castle, Kakum") while rejecting those.
 */
function wordStartIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    if (idx === 0 || !/[a-z0-9]/.test(haystack[idx - 1])) return true;
    from = idx + 1;
  }
}

/**
 * Word-anchored compact match: the query with separators stripped must match
 * the name (also stripped) starting at a word boundary. Lets "capecoast" match
 * "Cape Coast" without letting "tema" match "Asantemanso".
 */
function compactWordStartMatch(name, cq) {
  if (!name || !cq) return false;
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (words.slice(i).join('').startsWith(cq)) return true;
  }
  return false;
}

/* ── Levenshtein (edit distance) — matches prototype ────────────────────── */
function limitedEditDistance(a, b, maxDist) {
  a = String(a || '');
  b = String(b || '');
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > maxDist) return maxDist + 1;
    prev = cur;
  }
  return prev[b.length];
}

/* ── Scope filter ───────────────────────────────────────────────────────── */
function scopeWhere(scope) {
  if (scope === 'ghana') return { travioGhanaTour: { isActive: true } };
  if (scope === 'expedition') return { expeditionTour: { isActive: true } };
  return {};
}

/* ── Priority boost for places (from prototype) ─────────────────────────── */
const PRIORITY_WEIGHT = { 'Very High': 44, 'High': 30, 'Medium': 14, 'Standard': 0 };

/* ── Generic stopwords for distinctive-token matching ────────────────────── */
const GENERIC_TOKENS = new Set([
  'the', 'and', 'of', 'in', 'at', 'ghana', 'national', 'park', 'site',
  'centre', 'center', 'museum', 'castle', 'fort', 'falls', 'waterfalls',
  'beach', 'reserve', 'sanctuary', 'memorial', 'resource', 'garden',
  'gardens', 'market', 'palace', 'square', 'harbour', 'harbor', 'lake',
  'mount', 'mountain', 'river', 'village', 'gallery', 'house',
]);

/* ── Score a single entity against the query ────────────────────────────── */
function scoreRecord(kind, item, nq, cq) {
  if (!nq) return 0;

  const name = normaliseSearch(item.name || '');
  const cname = compactSearch(item.name || '');
  const aliases = normaliseSearch(item.aliases || '');
  const town = normaliseSearch(item.town || '');
  const region = normaliseSearch(item.region || '');
  const category = normaliseSearch(item.category || '');
  const all = [name, aliases, town, region, category].join(' ');
  let score = 0;

  // Tier 1: exact
  if (name === nq) score = 1000;
  // Tier 2: compact match
  else if (cname === cq && cq.length > 2) score = 985;
  // Tier 3: prefix
  else if (name.startsWith(nq)) score = 910;
  // Tier 4: word-prefix
  else if (name.split(' ').some(w => w.startsWith(nq))) score = 855;
  // Tier 5: alias exact
  else if (aliases.split(';').map(x => x.trim()).includes(nq)) score = 835;
  // Tier 6: alias prefix
  else if (aliases.startsWith(nq)) score = 800;
  // Tier 7: contains (word-anchored — no mid-word matches)
  else if (wordStartIncludes(name, nq)) score = 745;
  // Tier 8: compact-contains (word-anchored, tolerates differing spacing)
  else if (cq.length > 2 && compactWordStartMatch(name, cq)) score = 725;
  // Tier 9: all-tokens (each token word-anchored)
  else {
    const tokens = nq.split(' ').filter(Boolean);
    const allTokens = tokens.length && tokens.every(t => wordStartIncludes(all, t));
    if (allTokens) score = 675 + Math.min(tokens.length * 12, 60);
  }

  // Tier 10: edit distance
  if (!score && cq.length >= 3 && cq.length <= 32 && cname.length <= 46) {
    const maxDist = Math.max(cq.length >= 5 ? 2 : 1, Math.min(3, Math.floor(cq.length * 0.30)));
    const d = limitedEditDistance(cq, cname, maxDist);
    if (d <= maxDist) score = 610 - d * 42;
  }

  // Tier 11: fuzzy token
  if (!score && nq.length >= 3) {
    const qTokens = nq.split(' ');
    const nameTokens = name.split(' ');
    let fuzzyHits = 0;
    for (const qt of qTokens) {
      if (qt.length < 3) continue;
      if (nameTokens.some(nt => nt.startsWith(qt))) fuzzyHits++;
      else {
        const maxTokenDist = qt.length >= 5 ? 2 : 1;
        if (nameTokens.some(nt => Math.abs(nt.length - qt.length) <= maxTokenDist && limitedEditDistance(qt, nt, maxTokenDist) <= maxTokenDist)) fuzzyHits++;
      }
    }
    if (fuzzyHits && fuzzyHits >= Math.ceil(qTokens.length * 0.7)) score = 535 + fuzzyHits * 14;
  }

  // Apply kind bonuses — places must rank above attractions for the same base
  // score so that destination searches (e.g. "Accra") land on a place that
  // carries a region, enabling homepage personalization.
  if (score) {
    if (kind === 'place') score += 25 + Math.min(item.attractionCount || 0, 20);
    if (kind === 'attraction') score += 18;
    if (kind === 'region') score += 8;
  }

  return score;
}

/* ── Build suggestion response for a single entity ──────────────────────── */
function buildSuggestion(kind, item, score) {
  const name = item.name || '';
  const region = item.region || '';

  let subtitle = '';
  let meta = '';
  let icon = '';
  let badge = '';

  if (kind === 'tour') {
    icon = '◉';
    badge = 'Tour';
    subtitle = region ? `Tour in ${region} Region, Ghana` : 'Tour experience in Ghana';
    meta = item.city ? `${item.city} · Experience` : 'Experience';
  } else if (kind === 'place') {
    icon = '⌖';
    badge = 'Destination';
    subtitle = placeSubtitle(item);
    meta = placeMeta(item);
  } else if (kind === 'attraction') {
    icon = '✦';
    badge = 'Attraction';
    subtitle = attractionSubtitle(item);
    meta = [item.category, item.town].filter(Boolean).join(' · ');
  } else if (kind === 'region') {
    icon = '▦';
    badge = 'Region';
    subtitle = 'Region in Ghana';
    meta = `${item.attractionCount || 0} attraction site${(item.attractionCount || 0) === 1 ? '' : 's'}`;
  }

  return { kind, name, region, subtitle, meta, icon, badge, score, entity: item };
}

function placeSubtitle(place) {
  const n = normaliseSearch(place.name || '');
  if (n === 'accra') return 'Capital city of Ghana · Greater Accra Region';
  if (n === 'tema') return 'City in Greater Accra Region, Ghana · near Accra';
  if (place.placeType && /major city|regional capital/i.test(place.placeType)) return `City in ${place.region} Region, Ghana`;
  if (place.placeType && /town/i.test(place.placeType)) return `Town in ${place.region} Region, Ghana`;
  if (place.placeType && /tourism/i.test(place.placeType)) return `Tourism area in ${place.region} Region, Ghana`;
  if (place.placeType && /urban area/i.test(place.placeType)) return `City / town in ${place.region} Region, Ghana`;
  return `Place in ${place.region || 'Ghana'} Region`;
}

/**
 * Honest, real-count meta for a destination suggestion.
 *
 * Never claims "attraction sites" when we only counted tours (or vice versa),
 * and says nothing numeric when the place has neither. Counts exclude the seeded
 * "City / Town" rows, which exist only to make a town autocomplete — a place
 * like Amasaman must not report its own autocomplete row as an attraction.
 */
function placeMeta(place) {
  // `listingCount` is the place-scoped figure the listing page itself reports
  // (set for the few suggestions that actually render); `tourCount` is the cheap
  // exact-city fallback. Take the larger so the number can never undersell.
  const tours = Math.max(place.listingCount || 0, place.tourCount || 0);
  const attractions = place.attractionCount || 0;
  if (tours > 0) {
    // When the place has no tours of its own the count comes from its region —
    // say so, rather than implying the tours are here.
    return place.fallbackRegion
      ? `${tours} tour${tours === 1 ? '' : 's'} in ${place.fallbackRegion}`
      : `${tours} tour${tours === 1 ? '' : 's'} available`;
  }
  if (attractions > 0) return `${attractions} attraction${attractions === 1 ? '' : 's'}`;
  return 'Destination in Ghana';
}

/** How many place suggestions get the (more expensive) listing-consistent count. */
const LISTING_COUNT_MAX = 3;

/**
 * Upgrade the cheap exact-city tour count to the place-scoped count the
 * `/expedition/tours?place=` listing reports, so "N tours available" in the
 * dropdown matches the page it opens. Only the place suggestions that actually
 * made the response are counted, in parallel, and best-effort — a failure keeps
 * the cheap count rather than breaking search. Place resolution is cached 6h,
 * and the whole search response is cached, so this stays cheap.
 */
async function applyListingCounts(results, placeScope) {
  const places = results.filter((r) => r.kind === 'place').slice(0, LISTING_COUNT_MAX);
  if (places.length === 0) return;

  await Promise.all(places.map(async (r) => {
    try {
      const result = await placeTourCount(r.entity.name, placeScope);
      if (result == null) return;
      r.entity.listingCount = result.count;
      r.entity.fallbackRegion = result.fallbackRegion;
      r.meta = placeMeta(r.entity);
    } catch { /* keep the cheap exact-city count */ }
  }));
}

function attractionSubtitle(a) {
  return `Attraction site in ${a.region || 'Ghana'} Region`;
}

/* ── Normalise region names: strip trailing " Region" for consistency ─── */
function normaliseRegion(r) {
  if (!r) return '';
  return r.replace(/\s+region$/i, '').trim();
}

/**
 * Values in the `town` column that name a feature, not a settlement. Kept
 * deliberately narrow — a generic word like "beach" or "falls" is often just a
 * suffix on a real town ("Busua Beach" → Busua), so only unambiguous features
 * are rejected.
 */
const NON_SETTLEMENT = [
  /^(lake|river|mount|mountains?|volta lake)\b/i,
  /\b(national park|national reserve|resource reserve|ramsar site|sanctuary|waterfalls?)\b/i,
];

/** Clean one "town" segment; null when it isn't usable as a settlement name. */
function cleanTownSegment(segment) {
  let s = String(segment || '').trim();
  if (!s) return null;
  // Leading "near ", trailing qualifiers.
  s = s.replace(/^near\s+/i, '')
       .replace(/\s+near\s+.*$/i, '')
       .replace(/\s+(area|district)$/i, '')
       .trim();
  s = s.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
  if (s.length < 3) return null;
  const flat = normaliseSearch(s);
  if (/\bregion$/i.test(s)) return null; // "Northern Region"
  if (GHANA_REGIONS.some((r) => normaliseSearch(r) === flat)) return null; // "Greater Accra", "Eastern"
  if (NON_SETTLEMENT.some((re) => re.test(s))) return null; // "Lake Volta", "Kakum National Park"
  return s;
}

/**
 * Extract a clean town/locality name from the curated Attraction table's
 * free-text `town` column, which mixes forms like:
 *   "Aburi", "Abelemkpe, Accra", "Abossey Okai / Accra",
 *   "Kakum / near Cape Coast", "near Tamale", "Boti / Yilo Krobo area",
 *   "Eastern / southern Ghana", "Northern Region", "Lake Volta / Akosombo"
 *
 * Segments are tried in order and the first usable settlement wins, so
 * "Lake Volta / Akosombo" resolves to Akosombo rather than to a lake. Returns
 * null when no segment names a settlement (region-only values, features).
 */
function normalizeTown(raw) {
  const segments = String(raw || '').split(/[,/]/);
  for (const segment of segments) {
    const town = cleanTownSegment(segment);
    if (town) return town;
  }
  return null;
}

/* ── Main handler ───────────────────────────────────────────────────────── */
exports.unifiedSearch = catchAsync(async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 14, 20);
  const scope = (req.query.scope || '').toLowerCase();

  if (q.length < 2) {
    return res.json({ status: 'success', data: { query: q, results: [], stats: { places: 0, attractions: 0, regions: 0, tours: 0 } } });
  }

  const nq = normaliseSearch(q);
  const cq = compactSearch(q);
  const scopeKey = scope || 'all';
  const cacheKey = `hp:search:${scopeKey}:${crypto.createHash('md5').update(`${nq}:${limit}`).digest('hex')}`;

  const data = await cache.getOrSet(cacheKey, async () => {
    const scopeFilter = scopeWhere(scope);
    const scored = [];
    const tokens = nq.split(' ').filter(t => t.length >= 3);
    // SQL `contains` can't match an unspaced query to a spaced value ("capecoast"
    // vs "Cape Coast"), so for those we drop the `contains` prefilter and score
    // the whole (small) candidate set in memory — scoreRecord's compact tier then
    // matches it. Only longer unspaced queries trigger it, so ordinary one-word
    // searches keep the cheap indexed path. Cities are always scored in full
    // (there are ~15 of them).
    const compactQuery = !q.includes(' ') && q.length >= 6;

    // 1. Attractions — match name + aliases (full query + individual tokens for typo tolerance)
    try {
      const nameOrConditions = [
        { name: { contains: q, mode: 'insensitive' } },
        { aliases: { contains: q, mode: 'insensitive' } },
        { town: { contains: q, mode: 'insensitive' } },
      ];
      for (const token of tokens) {
        nameOrConditions.push({ name: { contains: token, mode: 'insensitive' } });
        nameOrConditions.push({ aliases: { contains: token, mode: 'insensitive' } });
      }

      const attractions = await prisma.attraction.findMany({
        // Exclude the seeded "City / Town" place rows so a town added for
        // autocomplete doesn't also surface as an Attraction suggestion.
        where: {
          status: 'ACTIVE',
          ...(compactQuery ? {} : { OR: nameOrConditions }),
          NOT: { category: 'City / Town' },
        },
        select: {
          name: true, slug: true, town: true, region: true, category: true,
          aliases: true, priority: true, placeType: true, tourCount: true,
          heroImage: true,
        },
        take: compactQuery ? 600 : 30,
      }).catch(() => []);

      for (const a of attractions) {
        const score = scoreRecord('attraction', a, nq, cq);
        if (score > 0) scored.push(buildSuggestion('attraction', a, score));
      }
    } catch {}

    // 2. Places — tours first (cities with bookable tours), then the curated
    // Attraction table's towns (XLSX) so a place that has attractions but no
    // tours still autocompletes and its region fallback can kick in.
    const placeByName = new Map();
    const addPlace = (item, score) => {
      const key = item.name.toLowerCase();
      const prev = placeByName.get(key);
      if (prev) {
        if (score > prev._score) {
          prev._score = score;
          if (item.placeType && item.placeType !== 'City / Town') prev.placeType = prev.placeType || item.placeType;
        }
        prev.tourCount = Math.max(prev.tourCount || 0, item.tourCount || 0);
        prev.attractionCount = Math.max(prev.attractionCount || 0, item.attractionCount || 0);
        if (!prev.region && item.region) prev.region = item.region;
        return;
      }
      item._score = score;
      placeByName.set(key, item);
    };

    try {
      const cities = await prisma.tour.groupBy({
        by: ['city', 'country', 'region'],
        // No `contains` filter: the city list is tiny, and scoring it in full is
        // what lets an unspaced query ("capecoast") still find "Cape Coast".
        where: { status: 'ACTIVE', ...scopeFilter },
        _count: { _all: true },
        orderBy: { _count: { city: 'desc' } },
        take: 50,
      }).catch(() => []);

      for (const c of cities) {
        if (!c.city) continue;
        const item = {
          name: c.city,
          region: normaliseRegion(c.region),
          priority: 'Standard',
          // Real number of bookable tours in this city (was previously surfaced
          // as "N attraction sites", which was simply wrong).
          tourCount: c._count?._all ?? 0,
          placeType: 'City / Town',
        };
        const score = scoreRecord('place', item, nq, cq);
        if (score > 0) addPlace(item, score);
      }
    } catch {}

    // 2b. Attraction-table towns — places we have attractions for (from the
    // XLSX import) but maybe no tours. Cap at the top 5 matches.
    try {
      const attrs = await prisma.attraction.findMany({
        where: {
          status: 'ACTIVE',
          region: { not: null },
          ...(compactQuery ? {} : { town: { contains: q, mode: 'insensitive' } }),
        },
        select: { town: true, region: true, placeType: true, category: true },
        take: compactQuery ? 600 : 300,
      }).catch(() => []);

      const townAgg = new Map();
      for (const a of attrs) {
        const name = normalizeTown(a.town);
        if (!name) continue;
        const key = name.toLowerCase();
        // The seeded "City / Town" rows exist purely so the town autocompletes.
        // They must still produce a suggestion, but must NOT be counted as
        // attractions (otherwise every seeded town claims "1 attraction site").
        const isPlaceRow = a.category === 'City / Town';
        const prev = townAgg.get(key) || {
          name,
          region: normaliseRegion(a.region),
          placeType: a.placeType || 'Town',
          count: 0,
        };
        if (isPlaceRow) {
          prev.placeType = a.placeType || prev.placeType;
        } else {
          prev.count += 1;
        }
        if (!prev.region && a.region) prev.region = normaliseRegion(a.region);
        townAgg.set(key, prev);
      }

      const scoredTowns = [];
      for (const t of townAgg.values()) {
        const item = {
          name: t.name,
          region: t.region,
          placeType: t.placeType,
          attractionCount: t.count,
        };
        const score = scoreRecord('place', item, nq, cq);
        if (score > 0) scoredTowns.push({ item, score });
      }
      scoredTowns.sort((a, b) => b.score - a.score);
      for (const { item, score } of scoredTowns.slice(0, 5)) addPlace(item, score);
    } catch {}

    for (const item of placeByName.values()) {
      const score = item._score;
      delete item._score;
      scored.push(buildSuggestion('place', item, score));
    }

    // 3. Regions — exact/prefix match on region names
    for (const r of GHANA_REGIONS) {
      const item = { name: `${r} Region`, region: r, attractionCount: 0 };
      const score = scoreRecord('region', item, nq, cq);
      if (score > 0) {
        // Count attractions in this region
        try {
          const count = await prisma.attraction.count({
            // Exclude the seeded "City / Town" autocomplete rows so the region
            // total reflects real attraction sites only.
            where: { status: 'ACTIVE', region: r, NOT: { category: 'City / Town' } },
          }).catch(() => 0);
          item.attractionCount = count;
        } catch {}
        scored.push(buildSuggestion('region', item, score));
      }
    }

    // 4. Tours — title + description + attractions array + tags match
    try {
      const tourOrConditions = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { tags: { has: q } },
      ];
      for (const token of tokens) {
        tourOrConditions.push({ title: { contains: token, mode: 'insensitive' } });
        tourOrConditions.push({ tags: { has: token } });
      }

      // Collect all attraction names/aliases found in section 1 to match against tour attractions array
      const attractionNames = scored
        .filter(r => r.kind === 'attraction')
        .flatMap(r => {
          const names = [r.entity.name];
          if (r.entity.aliases) names.push(...r.entity.aliases.split(/[;,]/).map(s => s.trim()).filter(Boolean));
          return names;
        });
      const tourFromAttractions = attractionNames.length > 0;
      if (tourFromAttractions) {
        tourOrConditions.push({ attractions: { hasSome: attractionNames } });
      }

      const tours = await prisma.tour.findMany({
        where: { status: 'ACTIVE', ...scopeFilter, OR: tourOrConditions },
        select: {
          id: true, title: true, slug: true, city: true, country: true, region: true,
          coverPhoto: true, averageRating: true, reviewCount: true,
          totalBookings: true, description: true,
        },
        orderBy: [{ reviewCount: 'desc' }, { totalBookings: 'desc' }],
        take: 20,
      }).catch(() => []);

      for (const t of tours) {
        const item = {
          name: t.title,
          region: normaliseRegion(t.region),
          city: t.city || '',
          aliases: '',
        };
        const score = scoreRecord('tour', item, nq, cq);
        // Tours matched via attractions array get an attraction-visit boost
        const attractionBoost = (score === 0 && tourFromAttractions) ? 15 : 0;
        if (score > 0 || attractionBoost > 0) {
          scored.push(buildSuggestion('tour', { ...item, slug: t.slug, coverPhoto: t.coverPhoto }, score + 12 + attractionBoost));
        }
      }
    } catch {}

    // Ordering: matching TOURS lead, then destinations, attractions, regions
    // (each group by score). Tours-first is intentional — a keyword search
    // should surface the bookable experience before the place it happens in.
    const kindOrder = { place: 0, attraction: 1, region: 2 };
    scored.sort((a, b) => {
      const tourFirst = (a.kind === 'tour' ? 0 : 1) - (b.kind === 'tour' ? 0 : 1);
      if (tourFirst !== 0) return tourFirst;
      if (b.score !== a.score) return b.score - a.score;
      return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    });

    const results = scored.slice(0, limit);

    // Make the destination "N tours available" match the listing page.
    const placeScope = scope === 'ghana'
      ? { ghanaOnly: true }
      : scope === 'expedition' ? { expeditionOnly: true } : {};
    await applyListingCounts(results, placeScope);

    const stats = {
      places: scored.filter(r => r.kind === 'place').length,
      attractions: scored.filter(r => r.kind === 'attraction').length,
      regions: scored.filter(r => r.kind === 'region').length,
      tours: scored.filter(r => r.kind === 'tour').length,
    };

    return { query: q, results, stats };
  }, 300);

  res.json({ status: 'success', data });
});

/* ── Loose place candidates for unknown search fallback ─────────────────── */
exports.loosePlaceResolve = catchAsync(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ status: 'success', data: { query: q, guess: null, region: null } });
  }

  const nq = normaliseSearch(q);
  const cq = compactSearch(q);

  // Try attractions first
  try {
    const attractions = await prisma.attraction.findMany({
      where: { status: 'ACTIVE', OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { aliases: { contains: q, mode: 'insensitive' } },
      ] },
      select: { name: true, region: true, town: true },
      take: 5,
    }).catch(() => []);

    let bestScore = 0;
    let best = null;
    for (const a of attractions) {
      const score = scoreRecord('attraction', a, nq, cq);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    if (best && bestScore >= 500) {
      return res.json({ status: 'success', data: { query: q, guess: best.name, region: best.region, kind: 'attraction', score: bestScore } });
    }
  } catch {}

  // Try places (cities)
  try {
    const cities = await prisma.tour.groupBy({
        by: ['city', 'region'],
        where: { status: 'ACTIVE', city: { contains: q, mode: 'insensitive' } },
        _count: { _all: true },
        take: 5,
      }).catch(() => []);

    for (const c of cities) {
      if (!c.city) continue;
      const item = { name: c.city, region: normaliseRegion(c.region) };
      const score = scoreRecord('place', item, nq, cq);
      if (score >= 500) {
        return res.json({ status: 'success', data: { query: q, guess: c.city, region: item.region, kind: 'place', score } });
      }
    }
  } catch {}

  res.json({ status: 'success', data: { query: q, guess: null, region: null, kind: 'unknown', score: 0 } });
});
