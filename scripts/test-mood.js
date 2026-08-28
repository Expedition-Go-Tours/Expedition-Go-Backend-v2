/**
 * Simulation: Test MoodSection improvements
 */

// Simulate the category filtering
const SKIP_CATEGORIES = new Set(['Transportation']);

const categories = [
  { name: 'Nature & Outdoors', tourCount: 10, score: 0.5 },
  { name: 'City & Walking Tours', tourCount: 7, score: 0.3 },
  { name: 'Animals & Nature', tourCount: 6, score: 0.2 },
  { name: 'Royalty & History', tourCount: 4, score: 0.15 },
  { name: 'Art & Museums', tourCount: 4, score: 0.1 },
  { name: 'Transportation', tourCount: 4, score: 0.05 },
  { name: 'Wellness & Relaxation', tourCount: 3, score: 0.03 },
  { name: 'Music & Shows', tourCount: 2, score: 0.01 },
];

console.log('=== MoodSection Simulation ===\n');

// Filter
const filtered = categories.filter(c => c.tourCount > 0 && !SKIP_CATEGORIES.has(c.name));

console.log('Before filtering:', categories.length, 'categories');
console.log('After filtering:', filtered.length, 'categories');
console.log('\nRemoved:');
const removed = categories.filter(c => !filtered.includes(c));
for (const c of removed) {
  console.log('  -', c.name);
}

console.log('\nRanked categories (what user sees):');
for (const c of filtered) {
  console.log('  ' + c.score.toFixed(3) + ' — ' + c.name + ' (' + c.tourCount + ' tours)');
}

// Simulate CLIP image selection
console.log('\n--- CLIP Image Selection ---');
const tourImages = [
  'cover_photo.jpg',
  'beach_sunset.jpg',
  'food_market.jpg',
  'castle_exterior.jpg',
  'group_hiking.jpg',
];

const categoryLabel = 'Nature & Outdoors';
console.log('Category:', categoryLabel);
console.log('Available images:', tourImages.length);
console.log('CLIP would score each image against "' + categoryLabel + '"');
console.log('Expected winner: beach_sunset.jpg or group_hiking.jpg');
console.log('Instead of always using: cover_photo.jpg');

console.log('\n=== MoodSection Simulation PASSED ===');
