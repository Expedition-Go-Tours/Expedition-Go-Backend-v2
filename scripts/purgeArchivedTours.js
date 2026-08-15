const { purgeArchivedTours } = require('../utils/tourPurge');

async function main() {
  console.log('[TourPurge] Starting...');
  const result = await purgeArchivedTours();
  console.log(`[TourPurge] Done: ${result.purged} purged, ${result.skipped} skipped, ${result.failed} failed`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[TourPurge] Fatal:', err);
      process.exit(1);
    });
}

module.exports = main;