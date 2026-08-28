/**
 * BM25 Search Index
 *
 * Pure JavaScript BM25 implementation for tour search.
 * No external dependencies — runs in-memory with Redis persistence.
 *
 * Usage:
 *   const bm25 = require('./bm25Index');
 *   await bm25.buildIndex(tours);
 *   const results = bm25.search('kakum canopy walk', 20);
 */

const logger = require('./logger');

// BM25 parameters
const K1 = 1.5;  // Term frequency saturation
const B = 0.75;  // Document length normalization

// Stopwords to filter out
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
  'be', 'has', 'had', 'have', 'do', 'does', 'did', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'shall', 'not', 'no', 'nor', 'so',
  'if', 'then', 'than', 'too', 'very', 'just', 'about', 'up', 'out', 'all',
]);

// In-memory index state
let documents = new Map();  // tourId → { tokens, length, fields }
let invertedIndex = new Map();  // token → Map<tourId, frequency>
let avgDocLength = 0;
let docCount = 0;
let built = false;

/**
 * Tokenize text: lowercase, split, remove stopwords, basic stemming.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build the full index from an array of tour objects.
 * @param {Object[]} tours - Array of tour records from Prisma
 */
function buildIndex(tours) {
  const start = Date.now();
  documents.clear();
  invertedIndex.clear();

  let totalLength = 0;

  for (const tour of tours) {
    const fieldTexts = {
      title: tour.title || '',
      description: (tour.description || '').slice(0, 1000),
      tags: (tour.tags || []).join(' '),
      category: tour.category || '',
      city: tour.city || '',
      country: tour.country || '',
      attractions: (tour.attractions || []).join(' '),
      moodTags: (tour.aiMoodTags || []).join(' '),
      primaryCategory: tour.aiPrimaryCategory || '',
    };

    const allText = Object.values(fieldTexts).join(' ');
    const tokens = tokenize(allText);

    // Weight title tokens higher by duplicating them
    const titleTokens = tokenize(fieldTexts.title);
    const weightedTokens = [...tokens, ...titleTokens, ...titleTokens];

    documents.set(tour.id, {
      tokens: weightedTokens,
      length: weightedTokens.length,
      fields: fieldTexts,
    });

    totalLength += weightedTokens.length;

    // Build inverted index
    const freq = new Map();
    for (const token of weightedTokens) {
      freq.set(token, (freq.get(token) || 0) + 1);
    }

    for (const [token, count] of freq) {
      if (!invertedIndex.has(token)) {
        invertedIndex.set(token, new Map());
      }
      invertedIndex.get(token).set(tour.id, count);
    }
  }

  docCount = tours.length;
  avgDocLength = docCount > 0 ? totalLength / docCount : 0;
  built = true;

  const duration = Date.now() - start;
  logger.info(`[BM25] Index built: ${docCount} tours, ${invertedIndex.size} unique tokens, ${duration}ms`);
}

/**
 * Add a single tour to the index (incremental).
 */
function addDocument(tour) {
  const fieldTexts = {
    title: tour.title || '',
    description: (tour.description || '').slice(0, 1000),
    tags: (tour.tags || []).join(' '),
    category: tour.category || '',
    city: tour.city || '',
    country: tour.country || '',
    attractions: (tour.attractions || []).join(' '),
    moodTags: (tour.aiMoodTags || []).join(' '),
    primaryCategory: tour.aiPrimaryCategory || '',
  };

  const allText = Object.values(fieldTexts).join(' ');
  const tokens = tokenize(allText);
  const titleTokens = tokenize(fieldTexts.title);
  const weightedTokens = [...tokens, ...titleTokens, ...titleTokens];

  // Remove old entry if exists
  removeDocument(tour.id);

  documents.set(tour.id, {
    tokens: weightedTokens,
    length: weightedTokens.length,
    fields: fieldTexts,
  });

  const freq = new Map();
  for (const token of weightedTokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  for (const [token, count] of freq) {
    if (!invertedIndex.has(token)) {
      invertedIndex.set(token, new Map());
    }
    invertedIndex.get(token).set(tour.id, count);
  }

  // Update averages
  docCount = documents.size;
  let totalLength = 0;
  for (const doc of documents.values()) {
    totalLength += doc.length;
  }
  avgDocLength = docCount > 0 ? totalLength / docCount : 0;
}

/**
 * Remove a tour from the index.
 */
function removeDocument(tourId) {
  const doc = documents.get(tourId);
  if (!doc) return;

  for (const token of doc.tokens) {
    const posting = invertedIndex.get(token);
    if (posting) {
      posting.delete(tourId);
      if (posting.size === 0) {
        invertedIndex.delete(token);
      }
    }
  }

  documents.delete(tourId);
  docCount = documents.size;
  if (docCount > 0) {
    let totalLength = 0;
    for (const d of documents.values()) {
      totalLength += d.length;
    }
    avgDocLength = totalLength / docCount;
  }
}

/**
 * Score a single document against a query using BM25.
 */
function scoreDocument(queryTokens, tourId) {
  const doc = documents.get(tourId);
  if (!doc) return 0;

  let score = 0;
  const seen = new Set();

  for (const token of queryTokens) {
    if (seen.has(token)) continue;
    seen.add(token);

    const posting = invertedIndex.get(token);
    if (!posting) continue;

    const tf = posting.get(tourId) || 0;
    if (tf === 0) continue;

    const df = posting.size;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);

    const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / avgDocLength)));

    score += idf * tfNorm;
  }

  return score;
}

/**
 * Search the index with a query string.
 * @param {string} query - User search query
 * @param {number} limit - Max results (default 20)
 * @returns {Array<{tourId: string, score: number}>}
 */
function search(query, limit = 20) {
  if (!built || docCount === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Collect candidate documents (union of posting lists)
  const candidates = new Set();
  for (const token of queryTokens) {
    const posting = invertedIndex.get(token);
    if (posting) {
      for (const tourId of posting.keys()) {
        candidates.add(tourId);
      }
    }
  }

  // Score and rank
  const results = [];
  for (const tourId of candidates) {
    const score = scoreDocument(queryTokens, tourId);
    if (score > 0) {
      results.push({ tourId, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Get index stats.
 */
function stats() {
  return {
    built,
    docCount,
    tokenCount: invertedIndex.size,
    avgDocLength: Math.round(avgDocLength * 10) / 10,
  };
}

/**
 * Check if index is ready.
 */
function isReady() {
  return built && docCount > 0;
}

module.exports = {
  buildIndex,
  addDocument,
  removeDocument,
  search,
  scoreDocument,
  tokenize,
  stats,
  isReady,
};
