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
const prisma = require('../utils/prismaClient');
const logger = require('../utils/logger');
const {
  syncExternalReviewStats,
  recomputeCombinedStatsForTours,
} = require('../utils/externalReviewStats');

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
  });
