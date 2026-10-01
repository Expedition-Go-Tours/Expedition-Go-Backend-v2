#!/usr/bin/env node
/**
 * Backfill external review aggregates into the backend.
 *
 *   node scripts/backfill-external-review-stats.js [path/to/externalReviews.json]
 *
 * Reads the storefront's scraped dataset, matches each product to a tour and
 * stores its official TripAdvisor / GetYourGuide totals, then recomputes the
 * denormalized combined rating/count for every tour. Safe to re-run — the sync
 * is an upsert.
 *
 * The file defaults to the sibling storefront checkout and can be overridden
 * with a path argument or EXTERNAL_REVIEWS_FILE.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../src/core/services/prismaClient');
const logger = require('../src/core/services/logger');
const {
  syncExternalReviewStats,
  recomputeCombinedStatsForTours,
} = require('../src/core/services/externalReviewStats');

const DEFAULT_PATHS = [
  process.env.EXTERNAL_REVIEWS_FILE,
  path.join(__dirname, '..', '..', 'Expedition-Go-Lite', 'public', 'data', 'externalReviews.json'),
  path.join(__dirname, '..', '..', 'Expedition-Go-Lite', 'src', 'data', 'externalReviews.json'),
].filter(Boolean);

function resolveFile(argPath) {
  const candidates = [argPath, ...DEFAULT_PATHS].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `externalReviews.json not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Pass a path as the first argument or set EXTERNAL_REVIEWS_FILE.'
  );
}

async function main() {
  const file = resolveFile(process.argv[2]);
  logger.info(`[Backfill] Reading ${file}`);

  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const products = Array.isArray(raw.products) ? raw.products : [];
  if (products.length === 0) {
    logger.warn('[Backfill] Dataset has no products — nothing to do.');
    return;
  }

  // Without this field the payload carries only the platform's own wording,
  // which the fuzzy matcher demonstrably misattributes — the Cape Coast
  // listing (211 reviews) scores highest against "Transport form Accra to Cape
  // Coast", and the Boti Falls listing against "Waterfalls Massage". This
  // script used to do exactly that and quietly moved reviews onto tours that
  // had none. Fail loudly instead of writing plausible-looking wrong rows.
  const stamped = products.filter((p) => p && p.mappedTourTitle).length;
  if (stamped === 0) {
    logger.warn(
      '[Backfill] No product carries `mappedTourTitle` — falling back to raw platform ' +
        'wording, which the matcher can attach to the wrong tour. Regenerate the dataset ' +
        'with the storefront sync (or pass a dataset newer than the field) before backfilling.'
    );
  } else {
    logger.info(`[Backfill] ${stamped}/${products.length} products carry a curated tour title.`);
  }

  const summary = await syncExternalReviewStats({ products });
  logger.info(
    `[Backfill] matched=${summary.matched} tours=${summary.tours} ` +
      `sources=${(summary.sources || []).join(',') || 'none'} ` +
      `unmatched=${summary.unmatched ? summary.unmatched.length : 0}`
  );
  if (summary.unmatched && summary.unmatched.length > 0) {
    logger.warn('[Backfill] Unmatched products:');
    for (const item of summary.unmatched.slice(0, 25)) {
      logger.warn(`  - [${item.source}] ${item.title} (${item.reason})`);
    }
  }

  // Recompute every tour so combined stats are consistent even for tours that
  // have only in-app reviews (or were seeded before this change).
  const all = await prisma.tour.findMany({ select: { id: true } });
  const updated = await recomputeCombinedStatsForTours(all.map((t) => t.id));
  logger.info(`[Backfill] Recomputed combined stats for ${updated} tours.`);
}

main()
  .catch((err) => {
    logger.error(`[Backfill] Failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    // The cache helper keeps a Redis connection open, which would otherwise
    // hold the event loop after the work is done — exit explicitly.
    process.exit(process.exitCode || 0);
  });
