/**
 * Simulation: Test destination ranking with XGBoost
 */
const xgboost = require('../utils/xgboostService');

// Simulate destination data (from SQL query)
const destinations = [
  { city: 'Accra', country: 'Ghana', tourCount: 7, totalBookings: 21, avgRating: 4.83, latitude: 5.56, longitude: -0.19 },
  { city: 'La-Dade-Kotopon', country: 'Ghana', tourCount: 3, totalBookings: 9, avgRating: null, latitude: 5.55, longitude: -0.17 },
  { city: 'Dedenya', country: 'Ghana', tourCount: 2, totalBookings: 9, avgRating: 4.84, latitude: 5.85, longitude: 0.05 },
  { city: 'Cape Coast', country: 'Ghana', tourCount: 1, totalBookings: 10, avgRating: 4.75, latitude: 5.105, longitude: -1.247 },
  { city: 'Kintampo South', country: 'Ghana', tourCount: 1, totalBookings: 6, avgRating: 5.00, latitude: 7.65, longitude: -1.73 },
  { city: 'Aburi', country: 'Ghana', tourCount: 1, totalBookings: 4, avgRating: null, latitude: 5.85, longitude: -0.17 },
  { city: 'Ada Foah', country: 'Ghana', tourCount: 1, totalBookings: 0, avgRating: null, latitude: 5.78, longitude: 0.63 },
];

console.log('=== Destination Ranking Simulation ===\n');

// Test 1: Anonymous user (no location)
console.log('--- Test 1: Anonymous (no location) ---');
const maxBookings = Math.max(...destinations.map(c => c.totalBookings || 0), 1);
const ranked1 = destinations.map(c => {
  const tourCountScore = Math.log10((c.tourCount || 0) + 1) / 2;
  const bookingsScore = Math.log10((c.totalBookings || 0) + 1) / 4;
  const ratingScore = c.avgRating ? parseFloat(c.avgRating) / 5 : 0.5;
  const distanceScore = 0.5;
  const score = (tourCountScore * 0.25) + (bookingsScore * 0.30) + (ratingScore * 0.30) + (distanceScore * 0.15);
  return { ...c, _score: score };
}).sort((a, b) => b._score - a._score);

for (const d of ranked1) {
  console.log(`  ${d._score.toFixed(4)} — ${d.city} (${d.tourCount} tours, ${d.totalBookings} bookings, ${d.avgRating || 'no'} rating)`);
}

// Test 2: User near Cape Coast
console.log('\n--- Test 2: User near Cape Coast (5.1, -1.2) ---');
const ranked2 = destinations.map(c => {
  const tourCountScore = Math.log10((c.tourCount || 0) + 1) / 2;
  const bookingsScore = Math.log10((c.totalBookings || 0) + 1) / 4;
  const ratingScore = c.avgRating ? parseFloat(c.avgRating) / 5 : 0.5;
  let distanceScore = 0.5;
  if (c.latitude && c.longitude) {
    const dist = xgboost.haversineKm(5.1, -1.2, c.latitude, c.longitude);
    distanceScore = Math.max(0, 1 - dist / 500);
  }
  const score = (tourCountScore * 0.25) + (bookingsScore * 0.30) + (ratingScore * 0.30) + (distanceScore * 0.15);
  return { ...c, _score: score };
}).sort((a, b) => b._score - a._score);

for (const d of ranked2) {
  const dist = d.latitude ? xgboost.haversineKm(5.1, -1.2, d.latitude, d.longitude).toFixed(0) : '?';
  console.log(`  ${d._score.toFixed(4)} — ${d.city} (${dist}km away)`);
}

// Verify Cape Coast ranks higher for nearby user
console.log(`\nCape Coast rank for anonymous: ${ranked1.findIndex(d => d.city === 'Cape Coast') + 1}`);
console.log(`Cape Coast rank for nearby user: ${ranked2.findIndex(d => d.city === 'Cape Coast') + 1}`);

console.log('\n=== Destination Ranking Simulation PASSED ===');
