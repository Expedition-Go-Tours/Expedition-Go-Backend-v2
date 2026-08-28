/**
 * XGBoost Ranking Service
 *
 * Computes features and scores tours for personalized ranking.
 * Currently uses a weighted heuristic model — designed to be replaced
 * with XGBoost when enough booking data is collected.
 *
 * Features computed per tour:
 *   [0]  bayesian_rating      — smoothed average rating
 *   [1]  booking_velocity_14d — bookings in last 14 days (normalized)
 *   [2]  review_count_log     — log10(reviewCount + 1)
 *   [3]  total_bookings_log   — log10(totalBookings + 1)
 *   [4]  category_affinity    — user's category affinity (0-1)
 *   [5]  tag_affinity         — user's tag affinity (0-1)
 *   [6]  recency_score        — newer tours score higher
 *   [7]  distance_score       — closer tours score higher (if location available)
 *   [8]  clip_similarity      — CLIP embedding similarity to user history
 *   [9]  ai_confidence        — AI classification confidence
 *   [10] has_special_offer    — boolean (0 or 1)
 *   [11] difficulty_encoded   — Easy=0, Moderate=1, Challenging=2, Expert=3
 *   [12] duration_hours_log   — log10(durationMinutes/60 + 1)
 */

const logger = require('./logger');

// Bayesian smoothing constants (from homepageRanking.js)
const BAYESIAN_C = 5;
const BAYESIAN_M = 3.0;

// Feature weights (tuned heuristically — replace with XGBoost model later)
const WEIGHTS = [
  0.20,  // bayesian_rating
  0.15,  // booking_velocity_14d
  0.08,  // review_count_log
  0.10,  // total_bookings_log
  0.12,  // category_affinity
  0.08,  // tag_affinity
  0.07,  // recency_score
  0.05,  // distance_score
  0.05,  // clip_similarity
  0.03,  // ai_confidence
  0.03,  // has_special_offer
  0.02,  // difficulty_encoded
  0.02,  // duration_hours_log
];

const DIFFICULTY_MAP = { easy: 0, moderate: 1, challenging: 2, expert: 3 };

/**
 * Compute features for a single tour.
 * @param {Object} tour - Tour record with all fields
 * @param {Object} context - { userCategoryAffinity, userTagAffinity, userLat, userLng, userClipEmbedding }
 * @returns {number[]} - Feature vector (13 dimensions)
 */
function computeFeatures(tour, context = {}) {
  const now = Date.now();

  // [0] Bayesian rating
  const n = tour.reviewCount || 0;
  const avg = tour.averageRating ? parseFloat(tour.averageRating) : 0;
  const bayesian = (BAYESIAN_C * BAYESIAN_M + n * avg) / (BAYESIAN_C + n);

  // [1] Booking velocity (14-day, normalized by log)
  const velocity14d = tour._bookingVelocity14d || 0;
  const bookingVelocityNorm = Math.log10(velocity14d + 1) / 3;

  // [2] Review count (log normalized)
  const reviewCountLog = Math.log10((tour.reviewCount || 0) + 1) / 3;

  // [3] Total bookings (log normalized)
  const totalBookingsLog = Math.log10((tour.totalBookings || 0) + 1) / 5;

  // [4] Category affinity
  const categoryAffinity = context.userCategoryAffinity?.[tour.aiPrimaryCategory || tour.category] || 0;

  // [5] Tag affinity
  const tourTags = new Set([...(tour.tags || []), ...(tour.aiMoodTags || [])]);
  let tagAffinity = 0;
  if (context.userTagAffinity && tourTags.size > 0) {
    let matches = 0;
    for (const tag of tourTags) {
      if (context.userTagAffinity[tag]) matches += context.userTagAffinity[tag];
    }
    tagAffinity = Math.min(1, matches / tourTags.size);
  }

  // [6] Recency (newer = higher, decays over 180 days)
  const ageMs = now - new Date(tour.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 1 - ageDays / 180);

  // [7] Distance (if both user and tour have location)
  let distanceScore = 0.5; // neutral when no location
  if (context.userLat != null && context.userLng != null && tour.latitude != null && tour.longitude != null) {
    const dist = haversineKm(context.userLat, context.userLng, tour.latitude, tour.longitude);
    distanceScore = Math.max(0, 1 - dist / 500); // 500km range
  }

  // [8] CLIP similarity (cosine similarity of embeddings)
  let clipSimilarity = 0;
  if (context.userClipEmbedding && tour.clipEmbedding) {
    clipSimilarity = cosineSimilarity(context.userClipEmbedding, tour.clipEmbedding);
  }

  // [9] AI confidence
  const aiConfidence = tour.aiConfidence || 0;

  // [10] Has special offer
  const hasSpecialOffer = (tour.specialOfferTargets?.length > 0 || tour.specialOffers?.length > 0) ? 1 : 0;

  // [11] Difficulty encoded
  const difficultyEncoded = (DIFFICULTY_MAP[(tour.difficulty || '').toLowerCase()] || 0) / 3;

  // [12] Duration (log normalized)
  const durationHoursLog = Math.log10((tour.durationMinutes || 60) / 60 + 1) / 2;

  return [
    bayesian / 5,        // normalize to 0-1
    bookingVelocityNorm,
    reviewCountLog,
    totalBookingsLog,
    categoryAffinity,
    tagAffinity,
    recencyScore,
    distanceScore,
    clipSimilarity,
    aiConfidence,
    hasSpecialOffer,
    difficultyEncoded,
    durationHoursLog,
  ];
}

/**
 * Score a tour using weighted features.
 * @param {number[]} features - Feature vector
 * @returns {number} - Score between 0 and 1
 */
function predict(features) {
  let score = 0;
  for (let i = 0; i < features.length; i++) {
    score += features[i] * (WEIGHTS[i] || 0);
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * Rank a list of tours for a user.
 * @param {Object[]} tours - Array of tour records
 * @param {Object} context - User context (affinity, location, embeddings)
 * @returns {Object[]} - Tours sorted by score, with score attached
 */
function rankTours(tours, context = {}) {
  const scored = tours.map(tour => {
    const features = computeFeatures(tour, context);
    const score = predict(features);
    return { ...tour, _xgboostScore: score, _features: features };
  });

  scored.sort((a, b) => b._xgboostScore - a._xgboostScore);
  return scored;
}

/**
 * Haversine distance in kilometers.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = {
  computeFeatures,
  predict,
  rankTours,
  haversineKm,
  cosineSimilarity,
  WEIGHTS,
};
