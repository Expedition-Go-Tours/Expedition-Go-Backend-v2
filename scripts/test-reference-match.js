/**
 * Test: Reference-based CLIP matching for attractions
 */
const { findBestMatch } = require('../utils/referenceImageMatcher');

async function test() {
  // Simulate: Cape Coast Castle tour has photos of both castles
  const tourPhotos = [
    'https://res.cloudinary.com/dfpagrtoy/image/upload/v1787653781/user-photos/frdyizber2ll6e5hsax0.jpg', // Cape Coast Castle
    'https://res.cloudinary.com/dfpagrtoy/image/upload/v1787653782/user-photos/rhngyh2sf9zvjb9hpy9c.jpg', // Elmina Castle
    'https://res.cloudinary.com/dfpagrtoy/image/upload/v1787653781/user-photos/kvlz3flgurjsjctfbopj.jpg', // Kakum canopy
  ];

  const attractions = ['Cape Coast Castle', 'Elmina Castle', 'Kakum National Park'];

  for (const attr of attractions) {
    console.log(`\n--- Finding best image for: ${attr} ---`);
    try {
      const match = await findBestMatch(attr, tourPhotos);
      if (match) {
        console.log(`  Best match: ${match.imageUrl.slice(-30)}`);
        console.log(`  Confidence: ${(match.score * 100).toFixed(1)}%`);
      } else {
        console.log('  No match found (CLIP unavailable or no references)');
      }
    } catch (err) {
      console.log('  ERROR:', err.message);
    }
  }

  console.log('\n=== Test Complete ===');
}

test().catch(console.error);
