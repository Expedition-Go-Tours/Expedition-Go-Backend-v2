/**
 * Simulation: Test XGBoost ranking service
 */
const xgboost = require('../utils/xgboostService');

// Simulate tour data with various characteristics
const tours = [
  { id: '1', title: 'Cape Coast Castle Tour', category: 'Cultural', tags: ['history', 'culture'], aiPrimaryCategory: 'culture_heritage', aiMoodTags: ['historic'], averageRating: 4.8, reviewCount: 120, totalBookings: 350, durationMinutes: 480, difficulty: 'Easy', createdAt: '2026-01-15', latitude: 5.105, longitude: -1.247, specialOfferTargets: [] },
  { id: '2', title: 'Kakum Canopy Walk', category: 'Adventure', tags: ['nature', 'hiking'], aiPrimaryCategory: 'nature_outdoors', aiMoodTags: ['adventurous'], averageRating: 4.6, reviewCount: 85, totalBookings: 220, durationMinutes: 360, difficulty: 'Moderate', createdAt: '2026-03-20', latitude: 5.35, longitude: -1.38, specialOfferTargets: [{ id: 'offer1' }] },
  { id: '3', title: 'Accra Nightlife Tour', category: 'Nightlife', tags: ['nightlife', 'party'], aiPrimaryCategory: 'nightlife_party', aiMoodTags: ['fun', 'vibrant'], averageRating: 4.2, reviewCount: 30, totalBookings: 45, durationMinutes: 240, difficulty: 'Easy', createdAt: '2026-07-01', latitude: 5.56, longitude: -0.19, specialOfferTargets: [] },
  { id: '4', title: 'Mole Safari', category: 'Wildlife', tags: ['safari', 'wildlife'], aiPrimaryCategory: 'animals_nature', aiMoodTags: ['wild', 'natural'], averageRating: 4.9, reviewCount: 200, totalBookings: 500, durationMinutes: 1440, difficulty: 'Moderate', createdAt: '2025-06-10', latitude: 9.4, longitude: -1.8, specialOfferTargets: [] },
  { id: '5', title: 'New Beach Experience', category: 'Beach', tags: ['beach', 'relaxation'], aiPrimaryCategory: 'water_activities', aiMoodTags: ['relaxing'], averageRating: 4.0, reviewCount: 5, totalBookings: 10, durationMinutes: 300, difficulty: 'Easy', createdAt: '2026-08-20', latitude: 5.55, longitude: -0.15, specialOfferTargets: [{ id: 'offer2' }] },
];

console.log('=== XGBoost Simulation ===\n');

// Test 1: Anonymous user (no personalization)
console.log('--- Test 1: Anonymous user (no context) ---');
const anonRanked = xgboost.rankTours([...tours], {});
for (const t of anonRanked) {
  console.log(`  ${t._xgboostScore.toFixed(4)} — ${t.title} (rating: ${t.averageRating}, bookings: ${t.totalBookings})`);
}

// Test 2: User who likes nature/adventure
console.log('\n--- Test 2: Nature/adventure lover ---');
const natureLover = xgboost.rankTours([...tours], {
  userCategoryAffinity: { 'nature_outdoors': 2.0, 'animals_nature': 1.5, 'sports_adventure': 1.0 },
  userTagAffinity: { 'nature': 1.5, 'hiking': 1.0, 'adventure': 1.0 },
});
for (const t of natureLover) {
  console.log(`  ${t._xgboostScore.toFixed(4)} — ${t.title} (category: ${t.aiPrimaryCategory})`);
}

// Test 3: User near Cape Coast (location-based)
console.log('\n--- Test 3: User near Cape Coast (5.1, -1.2) ---');
const localUser = xgboost.rankTours([...tours], {
  userLat: 5.1,
  userLng: -1.2,
});
for (const t of localUser) {
  console.log(`  ${t._xgboostScore.toFixed(4)} — ${t.title}`);
}

// Test 4: Feature computation
console.log('\n--- Test 4: Feature vector for tour 1 ---');
const features = xgboost.computeFeatures(tours[0], {
  userCategoryAffinity: { 'culture_heritage': 1.5 },
  userTagAffinity: { 'history': 1.0 },
  userLat: 5.1,
  userLng: -1.2,
});
const featureNames = ['bayesian_rating', 'booking_velocity', 'review_count', 'total_bookings', 'category_affinity', 'tag_affinity', 'recency', 'distance', 'clip_similarity', 'ai_confidence', 'special_offer', 'difficulty', 'duration'];
for (let i = 0; i < features.length; i++) {
  console.log(`  ${featureNames[i]}: ${features[i].toFixed(4)}`);
}
console.log(`  → Score: ${xgboost.predict(features).toFixed(4)}`);

// Test 5: Cosine similarity
console.log('\n--- Test 5: Cosine similarity ---');
const vecA = [1, 0, 0, 1, 0];
const vecB = [1, 0, 0, 1, 0];  // identical
const vecC = [0, 1, 0, 0, 1];  // orthogonal
console.log(`  A·A = ${xgboost.cosineSimilarity(vecA, vecB).toFixed(4)} (should be 1.0)`);
console.log(`  A·C = ${xgboost.cosineSimilarity(vecA, vecC).toFixed(4)} (should be 0.0)`);

// Test 6: Haversine distance
console.log('\n--- Test 6: Haversine distance ---');
const dist = xgboost.haversineKm(5.1, -1.2, 5.56, -0.19);  // Cape Coast to Accra
console.log(`  Cape Coast → Accra: ${dist.toFixed(1)} km`);

console.log('\n=== XGBoost Simulation PASSED ===');
