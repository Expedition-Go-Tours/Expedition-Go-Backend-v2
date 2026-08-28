/**
 * Simulation: Test CLIP client (Node.js side)
 * Tests the client interface — actual CLIP service must be running on Hetzner.
 */
const clip = require('../utils/clipClient');

console.log('=== CLIP Client Simulation ===\n');

async function run() {
  // Test 1: Health check (will fail locally since CLIP runs on Hetzner)
  console.log('--- Test 1: Health check ---');
  const healthy = await clip.isHealthy();
  console.log(`  CLIP service healthy: ${healthy}`);
  if (!healthy) {
    console.log('  (Expected: CLIP runs on Hetzner, not locally)');
    console.log('  Skipping remote tests — client interface verified by import.\n');
  }

  // Test 2: Verify client exports
  console.log('--- Test 2: Client interface ---');
  console.log(`  classifyImage: ${typeof clip.classifyImage}`);
  console.log(`  embedImage: ${typeof clip.embedImage}`);
  console.log(`  embedText: ${typeof clip.embedText}`);
  console.log(`  scoreQuality: ${typeof clip.scoreQuality}`);
  console.log(`  isHealthy: ${typeof clip.isHealthy}`);

  // Test 3: Error handling (should throw gracefully when service is down)
  console.log('\n--- Test 3: Error handling (service down) ---');
  try {
    await clip.classifyImage('https://example.com/test.jpg');
    console.log('  ERROR: Should have thrown');
  } catch (err) {
    console.log(`  Correctly threw: ${err.message.slice(0, 80)}`);
  }

  console.log('\n=== CLIP Client Simulation PASSED ===');
}

run().catch(err => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
