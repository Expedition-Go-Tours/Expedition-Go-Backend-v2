/**
 * Wikimedia Reference Image Fetcher
 *
 * Automatically fetches reference images for attractions from Wikimedia Commons.
 * These images are used by CLIP to identify what each attraction looks like,
 * enabling accurate hero image selection for tour photos.
 *
 * No API key required. No rate limits for reasonable usage.
 */

const logger = require('./logger');

const WIKIPEDIA_API = 'https://en.wikipedia.org/api/rest_v1';
const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'TravioAfrica/1.0 (https://travioafrica.com; contact@travioafrica.com)';

/**
 * Search for reference images of an attraction on Wikimedia Commons.
 *
 * @param {string} attractionName - e.g. "Cape Coast Castle"
 * @param {number} [maxImages=3] - max images to return
 * @returns {Promise<string[]>} array of image URLs
 */
async function fetchReferenceImages(attractionName, maxImages = 3) {
  if (!attractionName || attractionName.length < 3) return [];

  // Try multiple search strategies
  const searchTerms = buildSearchTerms(attractionName);

  for (const term of searchTerms) {
    try {
      const images = await searchWikimedia(term, maxImages);
      if (images.length > 0) {
        logger.info(`[Wikimedia] Found ${images.length} reference images for "${attractionName}" via "${term}"`);
        return images;
      }
    } catch (err) {
      logger.warn(`[Wikimedia] Search failed for "${term}": ${err.message}`);
    }
  }

  // Fallback: try Wikipedia page images
  try {
    const images = await getWikipediaPageImages(attractionName, maxImages);
    if (images.length > 0) {
      logger.info(`[Wikimedia] Found ${images.length} Wikipedia page images for "${attractionName}"`);
      return images;
    }
  } catch (err) {
    logger.warn(`[Wikimedia] Wikipedia fallback failed for "${attractionName}": ${err.message}`);
  }

  return [];
}

/**
 * Build search terms from attraction name.
 * Tries the full name, then stripped versions for better matches.
 */
function buildSearchTerms(name) {
  const terms = [name];

  // Strip common prefixes/suffixes that might not be in Wikipedia titles
  const stripped = name
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+(tour|experience|visit|trip|activity)$/i, '')
    .trim();

  if (stripped !== name) terms.push(stripped);

  // Add "Ghana" for disambiguation
  if (!name.toLowerCase().includes('ghana')) {
    terms.push(`${name} Ghana`);
  }

  return terms;
}

/**
 * Search Wikimedia Commons for images matching a query.
 */
async function searchWikimedia(query, maxImages) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: '6', // File namespace
    gsrlimit: String(maxImages * 2), // over-fetch for filtering
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: '800',
    format: 'json',
  });

  const url = `${WIKIMEDIA_API}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return [];

  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return [];

  const images = [];
  for (const page of Object.values(pages)) {
    const info = page?.imageinfo?.[0];
    if (!info) continue;

    // Filter: must be an actual image, not SVG/PDF, reasonable size
    if (!info.mime?.startsWith('image/')) continue;
    if (info.mime === 'image/svg+xml') continue;
    if (info.width < 200 || info.height < 200) continue;

    // Prefer the resized URL (800px wide) for faster CLIP processing
    const imageUrl = info.thumburl || info.url;
    if (imageUrl) images.push(imageUrl);

    if (images.length >= maxImages) break;
  }

  return images;
}

/**
 * Get images from a Wikipedia article page.
 */
async function getWikipediaPageImages(pageTitle, maxImages) {
  // First, find the Wikipedia page
  const searchUrl = `${WIKIPEDIA_API}/page/search/${encodeURIComponent(pageTitle)}?limit=3`;
  const searchRes = await fetch(searchUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });

  if (!searchRes.ok) return [];

  const searchData = await searchRes.json();
  const pages = searchData?.pages;
  if (!pages?.length) return [];

  // Get media from the first matching page
  const page = pages[0];
  const mediaUrl = `${WIKIPEDIA_API}/page/media/${encodeURIComponent(page.title)}`;
  const mediaRes = await fetch(mediaUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10000),
  });

  if (!mediaRes.ok) return [];

  const mediaData = await mediaRes.json();
  const items = mediaData?.items || mediaData?.media || [];

  const images = [];
  for (const item of items) {
    // Only include actual images (not audio/video)
    if (item.type !== 'image') continue;

    const src = item.original?.source || item.src;
    if (src && src.match(/\.(jpg|jpeg|png|webp)$/i)) {
      images.push(src);
    }

    if (images.length >= maxImages) break;
  }

  return images;
}

module.exports = {
  fetchReferenceImages,
  buildSearchTerms,
};
