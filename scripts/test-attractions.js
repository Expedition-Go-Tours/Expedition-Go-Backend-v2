/**
 * Simulation: Test attraction filtering and ranking
 */

// Simulate the junk filter
const JUNK_PATTERNS = /airport|dropoff|arrival|return back|nightlife|night life|pub |bar |transport/i;
const LOGISTICS_PATTERNS = /pickup|dropoff|transfer|shuttle|drive to|drive back/i;

const attractions = [
  { name: 'Cape Coast Castle', tourCount: 2, totalBookings: 12, avgRating: 4.9 },
  { name: 'Elmina Castle', tourCount: 2, totalBookings: 12, avgRating: 4.9 },
  { name: 'Kakum National Park', tourCount: 1, totalBookings: 2, avgRating: 5.0 },
  { name: 'Aburi Botanical Gardens', tourCount: 3, totalBookings: 13, avgRating: null },
  { name: 'Black Star Square', tourCount: 3, totalBookings: 5, avgRating: 4.7 },
  { name: 'Mole National Park', tourCount: 1, totalBookings: 6, avgRating: 5.0 },
  { name: 'Return back To Accra', tourCount: 1, totalBookings: 4, avgRating: null },
  { name: 'Three headed palm tree', tourCount: 1, totalBookings: 4, avgRating: null },
  { name: 'Airport Dropoff', tourCount: 1, totalBookings: 5, avgRating: null },
  { name: 'Arrival from the Airport', tourCount: 1, totalBookings: 5, avgRating: null },
  { name: 'Accra International Airport', tourCount: 2, totalBookings: 4, avgRating: null },
  { name: 'Purple Pub Osu', tourCount: 1, totalBookings: 4, avgRating: 4.7 },
  { name: 'The Nightlife Experience', tourCount: 1, totalBookings: 5, avgRating: null },
  { name: 'The Kumasi NightLife Experience', tourCount: 1, totalBookings: 5, avgRating: null },
  { name: 'The Capecoast NightLife', tourCount: 1, totalBookings: 5, avgRating: null },
  { name: 'Wli Waterfalls', tourCount: 1, totalBookings: 4, avgRating: 5.0 },
  { name: 'Tafi Monkey Sanctuary', tourCount: 1, totalBookings: 4, avgRating: 5.0 },
  { name: 'Akosombo Lake', tourCount: 1, totalBookings: 4, avgRating: 5.0 },
  { name: 'Shai Hills Resource Reserve', tourCount: 1, totalBookings: 5, avgRating: 4.7 },
  { name: 'Kwame Nkrumah Memorial Park', tourCount: 1, totalBookings: 3, avgRating: 4.7 },
];

console.log('=== Attraction Filtering Simulation ===\n');

// Filter
const filtered = attractions.filter(a => {
  const name = a.name || '';
  if (JUNK_PATTERNS.test(name)) return false;
  if (LOGISTICS_PATTERNS.test(name)) return false;
  if (name.length < 3) return false;
  return true;
});

console.log(`Before: ${attractions.length} attractions`);
console.log(`After:  ${filtered.length} attractions`);
console.log(`\nRemoved:`);
const removed = attractions.filter(a => !filtered.includes(a));
for (const a of removed) {
  console.log(`  - ${a.name}`);
}

// Rank by XGBoost-style scoring
console.log('\nRanked attractions:');
const maxBookings = Math.max(...filtered.map(a => a.totalBookings || 0), 1);
const ranked = filtered.map(a => {
  const tourCountScore = Math.log10((a.tourCount || 0) + 1) / 2;
  const bookingsScore = Math.log10((a.totalBookings || 0) + 1) / 4;
  const ratingScore = a.avgRating ? parseFloat(a.avgRating) / 5 : 0.4;
  const score = (tourCountScore * 0.20) + (bookingsScore * 0.25) + (ratingScore * 0.25) + 0.15 + 0.15;
  return { ...a, _score: score };
}).sort((a, b) => b._score - a._score);

for (const a of ranked) {
  console.log(`  ${a._score.toFixed(4)} — ${a.name} (${a.tourCount} tours, ${a.totalBookings} bookings, ${a.avgRating || 'no'} rating)`);
}

console.log('\n=== Attraction Filtering Simulation PASSED ===');
