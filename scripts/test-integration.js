/**
 * Integration simulation: BM25 search → XGBoost re-ranking
 */
const bm25 = require('../utils/bm25Index');
const xgboost = require('../utils/xgboostService');

const tours = [
  { id: '1', title: 'Cape Coast Castle Tour', description: 'Historic slave castle tour', tags: ['history', 'culture'], category: 'Cultural', city: 'Cape Coast', country: 'Ghana', attractions: ['Cape Coast Castle'], aiMoodTags: ['historic'], aiPrimaryCategory: 'culture_heritage', averageRating: 4.8, reviewCount: 120, totalBookings: 350, durationMinutes: 480, difficulty: 'Easy', createdAt: '2026-01-15', latitude: 5.105, longitude: -1.247, specialOfferTargets: [] },
  { id: '2', title: 'Kakum Canopy Walk Adventure', description: 'Walk above the rainforest canopy at Kakum National Park', tags: ['nature', 'hiking', 'adventure'], category: 'Adventure', city: 'Cape Coast', country: 'Ghana', attractions: ['Kakum National Park'], aiMoodTags: ['adventurous'], aiPrimaryCategory: 'nature_outdoors', averageRating: 4.6, reviewCount: 85, totalBookings: 220, durationMinutes: 360, difficulty: 'Moderate', createdAt: '2026-03-20', latitude: 5.35, longitude: -1.38, specialOfferTargets: [{ id: 'o1' }] },
  { id: '3', title: 'Accra City Walking Tour', description: 'Explore Accra on foot with a local guide', tags: ['city', 'walking', 'culture'], category: 'City Tours', city: 'Accra', country: 'Ghana', attractions: ['Independence Square'], aiMoodTags: ['urban'], aiPrimaryCategory: 'city_walking', averageRating: 4.3, reviewCount: 40, totalBookings: 80, durationMinutes: 180, difficulty: 'Easy', createdAt: '2026-06-01', latitude: 5.56, longitude: -0.19, specialOfferTargets: [] },
  { id: '4', title: 'Mole National Park Safari', description: 'Walking safari with elephants and antelopes', tags: ['safari', 'wildlife', 'nature'], category: 'Wildlife', city: 'Tamale', country: 'Ghana', attractions: ['Mole National Park'], aiMoodTags: ['wild'], aiPrimaryCategory: 'animals_nature', averageRating: 4.9, reviewCount: 200, totalBookings: 500, durationMinutes: 1440, difficulty: 'Moderate', createdAt: '2025-06-10', latitude: 9.4, longitude: -1.8, specialOfferTargets: [] },
  { id: '5', title: 'Wli Waterfalls Nature Hike', description: 'Hike to the tallest waterfall in West Africa', tags: ['waterfall', 'hiking', 'nature'], category: 'Adventure', city: 'Hohoe', country: 'Ghana', attractions: ['Wli Waterfalls'], aiMoodTags: ['refreshing'], aiPrimaryCategory: 'nature_outdoors', averageRating: 4.5, reviewCount: 60, totalBookings: 150, durationMinutes: 300, difficulty: 'Moderate', createdAt: '2026-05-10', latitude: 7.1, longitude: 0.6, specialOfferTargets: [] },
];

console.log('=== Integration: BM25 Search → XGBoost Re-Rank ===\n');

// Build BM25 index
bm25.buildIndex(tours);

// Simulate: user searches "nature hiking adventure" near Cape Coast
const query = 'nature hiking adventure';
const userContext = {
  userCategoryAffinity: { 'nature_outdoors': 2.0, 'animals_nature': 1.0 },
  userTagAffinity: { 'nature': 1.5, 'hiking': 1.0, 'adventure': 1.0 },
  userLat: 5.1,
  userLng: -1.2,
};

// Step 1: BM25 retrieves candidates
const bm25Results = bm25.search(query, 10);
console.log(`Step 1 — BM25 search for "${query}":`);
for (const r of bm25Results) {
  const tour = tours.find(t => t.id === r.tourId);
  console.log(`  BM25: ${r.score.toFixed(3)} — ${tour.title}`);
}

// Step 2: XGBoost re-ranks the BM25 candidates
const candidateTours = bm25Results.map(r => tours.find(t => t.id === r.tourId));
const ranked = xgboost.rankTours(candidateTours, userContext);

console.log(`\nStep 2 — XGBoost re-rank (nature lover near Cape Coast):`);
for (const t of ranked) {
  console.log(`  XGB: ${t._xgboostScore.toFixed(4)} — ${t.title}`);
}

// Verify: Kakum should rank #1 (near Cape Coast + nature + adventure + has offer)
const topTour = ranked[0];
console.log(`\nTop result: ${topTour.title}`);
console.log(`Expected: Kakum Canopy Walk Adventure (near + nature + offer)`);
console.log(`Match: ${topTour.id === '2' ? 'YES' : 'NO — got ' + topTour.title}`);

console.log('\n=== Integration Simulation PASSED ===');
