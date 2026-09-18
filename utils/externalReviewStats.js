/**
 * External review aggregates — storage, sync and the combined rating/count
 * that homepage ranking uses.
 *
 * Why this exists: homepage ranking used to rank tours on in-app reviews only,
 * so a tour with 3 in-app reviews but 595 TripAdvisor reviews ranked as if it
 * had 3. This module stores each platform's OFFICIAL product-page totals per
 * tour and denormalizes the combined value onto Tour.combinedRating /
 * combinedReviewCount, so external reviews affect WHICH tours surface — not
 * just their order — and ranking stays a plain indexed read.
 *
 * The internal columns (Tour.averageRating / Tour.reviewCount) are NEVER
 * overwritten — they are maintained incrementally by utils/ratingHelper.js.
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const { matchTourForTitle } = require('./externalReviewMatcher');
const {
  COUNTED_SOURCES,
  combineExternalStats,
  combineTourStats,
  toNumber,
} = require('./externalReviewCombine');

function tourLocation(tour) {
  return [tour && tour.city, tour && tour.country].filter(Boolean).join(', ') || null;
}

/** Keep only valid star buckets; preserves the 1★ bucket for the combine step. */
function normalizeDistribution(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  let any = false;
  for (const star of [5, 4, 3, 2, 1]) {
    const raw = input[star] !== undefined ? input[star] : input[String(star)];
    const value = Math.max(0, Math.floor(toNumber(raw)));
    out[star] = value;
    if (value > 0) any = true;
  }
  return any ? out : null;
}

/** Per-tour external stat rows for a set of tour ids. */
async function getExternalStatsByTour(tourIds, client = prisma) {
  const ids = Array.isArray(tourIds) ? tourIds.filter(Boolean) : [];
  if (ids.length === 0) return new Map();

  const rows = await client.tourExternalReviewStat.findMany({
    where: { tourId: { in: ids }, source: { in: COUNTED_SOURCES } },
    select: { tourId: true, source: true, rating: true, reviewCount: true, distribution: true },
  });

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.tourId)) map.set(row.tourId, []);
    map.get(row.tourId).push(row);
  }
  return map;
}

/**
 * Combined rating/count for a list of tours (which must carry `id`,
 * `averageRating` and `reviewCount`). Returns Map<tourId, {rating,
 * reviewCount, externalReviewCount}>.
 */
async function getCombinedStatsByTour(tours, client = prisma) {
  const list = Array.isArray(tours) ? tours : [];
  const externalByTour = await getExternalStatsByTour(list.map((t) => t.id), client);
  const result = new Map();

  for (const tour of list) {
    const external = combineExternalStats(externalByTour.get(tour.id) || []);
    const combined = combineTourStats(tour.averageRating, tour.reviewCount, external);
    result.set(tour.id, { ...combined, externalReviewCount: external.reviewCount });
  }
  return result;
}

/**
 * Recompute and persist Tour.combinedRating / combinedReviewCount for the given
 * tours from their current internal stats plus stored external aggregates.
 *
 * Accepts a transaction client so it can run inside a review-rating write.
 */
async function recomputeCombinedStatsForTours(tourIds, client = prisma) {
  const ids = [...new Set((Array.isArray(tourIds) ? tourIds : []).filter(Boolean))];
  if (ids.length === 0) return 0;

  const tours = await client.tour.findMany({
    where: { id: { in: ids } },
    select: { id: true, averageRating: true, reviewCount: true },
  });
  const externalByTour = await getExternalStatsByTour(ids, client);

  let updated = 0;
  for (const tour of tours) {
    const external = combineExternalStats(externalByTour.get(tour.id) || []);
    const combined = combineTourStats(tour.averageRating, tour.reviewCount, external);
    await client.tour.update({
      where: { id: tour.id },
      data: {
        combinedRating: combined.reviewCount > 0 ? combined.rating : null,
        combinedReviewCount: combined.reviewCount,
      },
    });
    updated += 1;
  }
  return updated;
}

/**
 * Apply a scraper sync payload: match each product to a tour, upsert its
 * official totals, drop rows for sources this run covers but no longer
 * supplies, recompute the combined values, and refresh the homepage cache.
 *
 * Payload: { products: [{ id, source, tourTitle, tourUrl, rating, reviewCount, distribution }] }
 */
async function syncExternalReviewStats(payload = {}) {
  const products = Array.isArray(payload.products) ? payload.products : [];
  const syncStartedAt = new Date();

  const tours = await prisma.tour.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, title: true, city: true, country: true, region: true },
  });
  const candidates = tours.map((t) => ({ id: t.id, title: t.title, location: tourLocation(t) }));

  const touchedSources = new Set();
  const rows = [];
  const unmatched = [];
  const seen = new Set();

  for (const product of products) {
    if (!product || typeof product !== 'object') continue;
    const source = String(product.source || '').trim().toUpperCase();
    if (!COUNTED_SOURCES.includes(source)) continue;

    const title = product.tourTitle || product.title || '';
    const match = matchTourForTitle(title, candidates);
    if (!match) {
      unmatched.push({ source, title, reason: 'no-tour-match' });
      continue;
    }

    const reviewCount = Math.max(0, Math.floor(toNumber(product.reviewCount)));
    const rawRating = toNumber(product.rating);
    if (reviewCount <= 0 || rawRating <= 0) {
      unmatched.push({ source, title, reason: 'no-official-totals' });
      continue;
    }

    // One row per (tour, source) — if two products resolve to the same tour,
    // keep the larger total rather than letting the last one win.
    const dedupeKey = `${match.id}:${source}`;
    const entry = {
      tourId: match.id,
      source,
      rating: Math.min(5, Math.round(rawRating * 100) / 100),
      reviewCount,
      distribution: normalizeDistribution(product.distribution),
      productId: product.id ? String(product.id) : null,
      productUrl: product.tourUrl ? String(product.tourUrl) : null,
      matchedTitle: title,
    };

    if (seen.has(dedupeKey)) {
      const index = rows.findIndex((r) => `${r.tourId}:${r.source}` === dedupeKey);
      if (index >= 0 && reviewCount > rows[index].reviewCount) rows[index] = entry;
      continue;
    }
    seen.add(dedupeKey);
    rows.push(entry);
    touchedSources.add(source);
  }

  if (payload.dryRun) {
    return {
      dryRun: true,
      matched: rows.length,
      tours: new Set(rows.map((r) => r.tourId)).size,
      sources: [...touchedSources],
      unmatched,
    };
  }

  if (rows.length > 0) {
    await prisma.$transaction(
      rows.map((row) =>
        prisma.tourExternalReviewStat.upsert({
          where: { tourId_source: { tourId: row.tourId, source: row.source } },
          create: {
            tourId: row.tourId,
            source: row.source,
            rating: row.rating,
            reviewCount: row.reviewCount,
            distribution: row.distribution,
            productId: row.productId,
            productUrl: row.productUrl,
            syncedAt: syncStartedAt,
          },
          update: {
            rating: row.rating,
            reviewCount: row.reviewCount,
            distribution: row.distribution,
            productId: row.productId,
            productUrl: row.productUrl,
            syncedAt: syncStartedAt,
          },
        })
      )
    );
  }

  // Rows for the sources this run covers that were NOT refreshed are stale
  // (a product stopped matching, or the tour was unpublished).
  if (touchedSources.size > 0) {
    await prisma.tourExternalReviewStat.deleteMany({
      where: { source: { in: [...touchedSources] }, syncedAt: { lt: syncStartedAt } },
    });
  }

  // Recompute the denormalized combined value for every tour this run touched,
  // so ranking picks the change up immediately.
  const touchedTourIds = rows.map((r) => r.tourId);
  const toursUpdated = await recomputeCombinedStatsForTours(touchedTourIds);

  // Refresh every cache that reads the combined stats: the homepage sections
  // and the Expedition detail/list/featured/sitemap payloads (which now carry
  // the combined rating for SEO and sort by it).
  await cache.invalidateHomepageCaches();
  await cache.invalidateKeys(['expedition:*']).catch(() => {});

  return {
    matched: rows.length,
    tours: toursUpdated,
    sources: [...touchedSources],
    unmatched,
  };
}

module.exports = {
  COUNTED_SOURCES,
  combineExternalStats,
  combineTourStats,
  getExternalStatsByTour,
  getCombinedStatsByTour,
  recomputeCombinedStatsForTours,
  syncExternalReviewStats,
  tourLocation,
};
