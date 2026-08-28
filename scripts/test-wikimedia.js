/**
 * Test: Wikimedia reference image fetcher
 */
const { fetchReferenceImages } = require('../utils/wikimediaRefImages');

async function test() {
  const attractions = [
    'Cape Coast Castle',
    'Elmina Castle',
    'Kakum National Park',
    'Mole National Park',
    'Kwame Nkrumah Memorial Park',
  ];

  for (const name of attractions) {
    console.log(`\n--- ${name} ---`);
    try {
      const images = await fetchReferenceImages(name, 3);
      if (images.length === 0) {
        console.log('  No images found');
      } else {
        for (const img of images) {
          console.log('  ' + img.slice(0, 80) + '...');
        }
      }
    } catch (err) {
      console.log('  ERROR:', err.message);
    }
  }

  console.log('\n=== Test Complete ===');
}

test().catch(console.error);
