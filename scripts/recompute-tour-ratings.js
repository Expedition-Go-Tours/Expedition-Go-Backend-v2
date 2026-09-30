#!/usr/bin/env node
/**
 * Rebuild the denormalized rating columns from the Review table.
 *
 *   node scripts/recompute-tour-ratings.js [--dry-run]
 *
 * Tour.averageRating / Tour.reviewCount and SupplierProfile.averageRating are
 * maintained incrementally by src/core/services/ratingHelper.js on every review
 * that travels through the API (create, edit, approve, reject, delete). Rows
 * removed with raw SQL skip that path entirely, so the counters drift — a
 * cleanup that deleted 37 approved reviews in psql left 12 tours advertising a
 * rating no review supported and a supplier profile still reading 4.86 with
 * zero reviews behind it.
 *
 * Tour.combinedRating / combinedReviewCount inherit the staleness, because
 * recomputeCombinedStatsForTours() folds the internal columns into the combined
 * figure. So this rebuilds the internals first and re-derives the combined
 * ones afterwards. The external TripAdvisor / GetYourGuide rows are never
 * written — only the in-app half of the combined number is corrected, and
 * tours whose reviews are entirely external keep exactly what they had.
 *
 * Internal and profile columns are written only where the value actually
 * differs, so a second run reports zero changes. The combined columns are
 * re-derived on every run (cheap, and it is the field ranking caches read).
 */

const prisma = require('../src/core/services/prismaClient');
const cache = require('../src/core/services/cacheHelper');
const { recomputeCombinedStatsForTours } = require('../src/core/services/externalReviewStats');

// console, not the shared logger: with LOGTAIL_TOKEN set the logger ships every
// line to the remote aggregator, which would swallow the --dry-run report that
// is this script's whole point.

const DRY_RUN = process.argv.includes('--dry-run');

/** ratingHelper rounds the running average to 2dp — match it exactly. */
const round2 = (value) => Math.round(value * 100) / 100;

/** Compare a Decimal? column against a freshly computed value (or null). */
function sameRating(current, expected) {
  const nowValue = current === null || current === undefined ? null : Number(current);
  if (expected === null) return nowValue === null;
  if (nowValue === null) return false;
  return Math.abs(nowValue - expected) < 0.005;
}

const fmt = (value) => (value === null ? 'null' : value.toFixed(2));

async function main() {
  const [reviews, tours, profiles] = await Promise.all([
    prisma.review.findMany({
      where: { status: 'APPROVED' },
      select: { rating: true, tourId: true },
    }),
    prisma.tour.findMany({
      select: { id: true, title: true, supplierId: true, averageRating: true, reviewCount: true },
    }),
    prisma.supplierProfile.findMany({
      select: { userId: true, averageRating: true },
    }),
  ]);

  const tourById = new Map(tours.map((t) => [t.id, t]));
  const perTour = new Map();
  const perSupplier = new Map();

  const tally = (map, key, rating) => {
    const stat = map.get(key) || { sum: 0, count: 0 };
    stat.sum += rating;
    stat.count += 1;
    map.set(key, stat);
  };

  for (const review of reviews) {
    const tour = tourById.get(review.tourId);
    if (!tour) continue;
    tally(perTour, tour.id, review.rating);
    tally(perSupplier, tour.supplierId, review.rating);
  }

  const tourUpdates = [];
  for (const tour of tours) {
    const stat = perTour.get(tour.id);
    const expectedCount = stat ? stat.count : 0;
    const expectedRating = expectedCount > 0 ? round2(stat.sum / expectedCount) : null;
    const currentCount = tour.reviewCount || 0;

    if (currentCount === expectedCount && sameRating(tour.averageRating, expectedRating)) continue;

    tourUpdates.push({
      id: tour.id,
      title: tour.title,
      from: { rating: tour.averageRating, count: currentCount },
      to: { rating: expectedRating, count: expectedCount },
    });
  }

  const profileUpdates = [];
  for (const profile of profiles) {
    const stat = perSupplier.get(profile.userId);
    const expected = stat && stat.count > 0 ? round2(stat.sum / stat.count) : null;
    if (sameRating(profile.averageRating, expected)) continue;
    profileUpdates.push({ userId: profile.userId, from: profile.averageRating, to: expected });
  }

  console.log(
    `[Ratings] ${DRY_RUN ? 'would update' : 'updating'} ` +
      `${tourUpdates.length}/${tours.length} tours and ` +
      `${profileUpdates.length}/${profiles.length} supplier profiles ` +
      `from ${reviews.length} approved reviews.`
  );

  for (const update of tourUpdates) {
    console.log(
      `  - ${update.title} [${update.id}]: ` +
        `${fmt(update.from.rating)} (${update.from.count}) -> ` +
        `${fmt(update.to.rating)} (${update.to.count})`
    );
  }
  for (const update of profileUpdates) {
    console.log(`  - profile ${update.userId}: ${fmt(update.from)} -> ${fmt(update.to)}`);
  }

  if (DRY_RUN) return;

  if (tourUpdates.length > 0) {
    await prisma.$transaction(
      tourUpdates.map((update) =>
        prisma.tour.update({
          where: { id: update.id },
          data: { averageRating: update.to.rating, reviewCount: update.to.count },
        })
      )
    );
  }

  // Re-derive combined from the corrected internals + untouched external rows.
  const combined = await recomputeCombinedStatsForTours(tours.map((t) => t.id));
  console.log(`[Ratings] Re-derived combined rating/count for ${combined} tours.`);

  if (profileUpdates.length > 0) {
    await prisma.$transaction(
      profileUpdates.map((update) =>
        prisma.supplierProfile.update({
          where: { userId: update.userId },
          data: { averageRating: update.to },
        })
      )
    );
  }

  // Ranking and the SEO payloads read the combined columns out of cache.
  await cache.invalidateHomepageCaches().catch((err) => {
    console.warn(`[Ratings] homepage cache invalidation failed: ${err.message}`);
  });
  await cache.invalidateKeys(['expedition:*']).catch(() => {});
  console.log('[Ratings] Done.');
}

main()
  .catch((err) => {
    console.error(`[Ratings] Failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    // The cache helper keeps a Redis connection open, which would otherwise
    // hold the event loop after the work is done — exit explicitly.
    process.exit(process.exitCode || 0);
  });
