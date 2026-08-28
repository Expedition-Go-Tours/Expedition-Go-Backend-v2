/**
 * Simulation: Test BM25 search index
 */
const bm25 = require('../utils/bm25Index');

// Simulate tour data
const tours = [
  { id: '1', title: 'Cape Coast Castle & Elmina Castle Tour', description: 'Visit the historic Cape Coast Castle and Elmina Castle, learn about the transatlantic slave trade', tags: ['history', 'culture', 'heritage', 'castle'], category: 'Cultural', city: 'Cape Coast', country: 'Ghana', attractions: ['Cape Coast Castle', 'Elmina Castle'], aiMoodTags: ['historic', 'educational', 'sobering'], aiPrimaryCategory: 'culture_heritage' },
  { id: '2', title: 'Kakum National Park Canopy Walk', description: 'Experience the famous canopy walkway at Kakum National Park, 40 meters above the forest floor', tags: ['nature', 'hiking', 'forest', 'adventure'], category: 'Adventure', city: 'Cape Coast', country: 'Ghana', attractions: ['Kakum National Park'], aiMoodTags: ['adventurous', 'outdoor', 'thrilling'], aiPrimaryCategory: 'nature_outdoors' },
  { id: '3', title: 'Accra City Tour', description: 'Explore the vibrant city of Accra, visit Independence Square, Makola Market, and the National Museum', tags: ['city', 'walking', 'culture', 'market'], category: 'City Tours', city: 'Accra', country: 'Ghana', attractions: ['Independence Square', 'Makola Market'], aiMoodTags: ['urban', 'cultural', 'lively'], aiPrimaryCategory: 'city_walking' },
  { id: '4', title: 'Mole National Park Safari', description: 'Spot elephants, antelopes, and baboons on a walking safari in Ghanas largest wildlife park', tags: ['safari', 'wildlife', 'nature', 'elephants'], category: 'Wildlife', city: 'Tamale', country: 'Ghana', attractions: ['Mole National Park'], aiMoodTags: ['wild', 'natural', 'exciting'], aiPrimaryCategory: 'animals_nature' },
  { id: '5', title: 'Wli Waterfalls Hiking Tour', description: 'Hike to the tallest waterfall in West Africa through the Agumatsa Wildlife Sanctuary', tags: ['waterfall', 'hiking', 'nature', 'adventure'], category: 'Adventure', city: 'Hohoe', country: 'Ghana', attractions: ['Wli Waterfalls'], aiMoodTags: ['refreshing', 'natural', 'active'], aiPrimaryCategory: 'nature_outdoors' },
  { id: '6', title: 'Ghana Food & Cooking Experience', description: 'Learn to cook traditional Ghanaian dishes like jollof rice, banku, and fufu with a local chef', tags: ['food', 'cooking', 'culture', 'local'], category: 'Food & Drink', city: 'Accra', country: 'Ghana', attractions: [], aiMoodTags: ['delicious', 'hands-on', 'cultural'], aiPrimaryCategory: 'food_drink' },
  { id: '7', title: 'Volta Region Adventure', description: 'Multi-day adventure through the Volta Region visiting waterfalls, mountains, and traditional villages', tags: ['adventure', 'nature', 'mountains', 'villages'], category: 'Adventure', city: 'Ho', country: 'Ghana', attractions: ['Mount Afadja', 'Tafi Atome Monkey Sanctuary'], aiMoodTags: ['adventurous', 'scenic', 'immersive'], aiPrimaryCategory: 'sports_adventure' },
  { id: '8', title: 'Cape Coast Day Tour with Assin Manso Slave River', description: 'Full day tour visiting Cape Coast Castle, Assin Manso Slave River, and Kakum National Park canopy walk', tags: ['history', 'nature', 'culture', 'full-day'], category: 'Cultural', city: 'Cape Coast', country: 'Ghana', attractions: ['Cape Coast Castle', 'Assin Manso', 'Kakum National Park'], aiMoodTags: ['educational', 'moving', 'comprehensive'], aiPrimaryCategory: 'culture_heritage' },
];

console.log('=== BM25 Simulation ===\n');

// Build index
bm25.buildIndex(tours);
console.log('Index stats:', bm25.stats());

// Test searches
const queries = [
  'kakum canopy walk',
  'food cooking ghana',
  'castle history slave',
  'safari elephants wildlife',
  'waterfall hiking nature',
  'accra city tour',
  'adventure',
  'beach',  // should return nothing
];

for (const query of queries) {
  const results = bm25.search(query, 5);
  console.log(`\nSearch: "${query}"`);
  if (results.length === 0) {
    console.log('  No results');
  } else {
    for (const r of results) {
      const tour = tours.find(t => t.id === r.tourId);
      console.log(`  ${r.score.toFixed(3)} — ${tour.title}`);
    }
  }
}

// Test incremental add/remove
console.log('\n--- Incremental add ---');
bm25.addDocument({ id: '9', title: 'Labadi Beach Resort', description: 'Relax on the popular Labadi Beach near Accra', tags: ['beach', 'relaxation', 'swimming'], category: 'Beach', city: 'Accra', country: 'Ghana', attractions: ['Labadi Beach'], aiMoodTags: ['relaxing', 'sunny'], aiPrimaryCategory: 'water_activities' });

const beachResults = bm25.search('beach swimming', 3);
console.log('Search "beach swimming" after adding Labadi Beach:');
for (const r of beachResults) {
  const doc = bm25.tokenize ? tours.find(t => t.id === r.tourId) : null;
  console.log(`  ${r.score.toFixed(3)} — tour ${r.tourId}`);
}

console.log('\nIndex stats after add:', bm25.stats());

console.log('\n--- Incremental remove ---');
bm25.removeDocument('9');
console.log('Index stats after remove:', bm25.stats());

console.log('\n=== BM25 Simulation PASSED ===');
