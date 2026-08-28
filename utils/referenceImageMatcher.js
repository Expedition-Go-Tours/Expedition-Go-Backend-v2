/**
 * Reference-Based CLIP Image Matching
 *
 * Uses Wikimedia Commons reference images + CLIP embeddings to identify
 * which tour photo shows a specific attraction.
 *
 * Flow:
 *   1. Fetch reference images for attraction from Wikimedia
 *   2. CLIP encodes each reference into a 512-dim vector
 *   3. CLIP encodes each tour photo into a 512-dim vector
 *   4. Cosine similarity → highest match = the right photo
 *
 * Cost: $0 (self-hosted CLIP + free Wikimedia API)
 */

const logger = require('./logger');
const { fetchReferenceImages } = require('./wikimediaRefImages');
const clip = require('./clipClient');
const xgboost = require('./xgboostService');

// Cache: attractionName → reference embeddings (in-memory, rebuilt on restart)
const referenceCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get reference image embeddings for an attraction.
 * Fetches from Wikimedia, encodes with CLIP, caches in memory.
 *
 * @param {string} attractionName
 * @returns {Promise<number[][]>} array of embedding vectors
 */
async function getReferenceEmbeddings(attractionName) {
  const cached = referenceCache.get(attractionName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.embeddings;
  }

  const images = await fetchReferenceImages(attractionName, 3);
  if (images.length === 0) {
    referenceCache.set(attractionName, { embeddings: [], timestamp: Date.now() });
    return [];
  }

  const embeddings = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const { embedding } = await clip.embedImage(images[i]);
      if (embedding) embeddings.push(embedding);
    } catch (err) {
      logger.warn(`[RefMatch] Failed to encode reference image for "${attractionName}": ${err.message}`);
    }
    // Rate limit: wait between CLIP calls to avoid 429 errors
    if (i < images.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  referenceCache.set(attractionName, { embeddings, timestamp: Date.now() });
  return embeddings;
}

/**
 * Find the best matching image for an attraction from a list of tour photos.
 *
 * @param {string} attractionName - e.g. "Cape Coast Castle"
 * @param {string[]} candidateImages - array of image URLs to compare
 * @returns {Promise<{imageUrl: string, score: number} | null>}
 */
async function findBestMatch(attractionName, candidateImages) {
  if (!candidateImages || candidateImages.length === 0) return null;

  // Check if CLIP is available
  const healthy = await clip.isHealthy().catch(() => false);
  if (!healthy) return null;

  // Get reference embeddings for this attraction
  const refEmbeddings = await getReferenceEmbeddings(attractionName);
  if (refEmbeddings.length === 0) return null;

  // Score each candidate image against the references
  let bestImage = null;
  let bestScore = 0;

  for (let i = 0; i < candidateImages.length; i++) {
    try {
      const { embedding } = await clip.embedImage(candidateImages[i]);
      if (!embedding) continue;

      // Compare against all reference embeddings, take the best match
      let maxSimilarity = 0;
      for (const refEmb of refEmbeddings) {
        const similarity = xgboost.cosineSimilarity(embedding, refEmb);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }

      if (maxSimilarity > bestScore) {
        bestScore = maxSimilarity;
        bestImage = candidateImages[i];
      }
    } catch {
      // Skip failed images
    }
    // Rate limit: wait between CLIP calls
    if (i < candidateImages.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (bestImage && bestScore > 0.5) { // minimum threshold
    return { imageUrl: bestImage, score: bestScore };
  }

  return null;
}

/**
 * Clear the reference cache (for testing or manual refresh).
 */
function clearCache() {
  referenceCache.clear();
}

module.exports = {
  getReferenceEmbeddings,
  findBestMatch,
  clearCache,
};
