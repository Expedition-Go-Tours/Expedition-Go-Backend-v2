const prisma = require('./prismaClient');

const FTS_CONFIG = 'english';

/**
 * Rank an array of tour IDs by full-text search relevance.
 * Uses PostgreSQL ts_rank with the GIN index on title + description.
 */
async function rankTourIdsBySearch(searchTerm, tourIds) {
  if (!searchTerm || !tourIds.length) return tourIds;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM "Tour"
       WHERE id = ANY($1)
       ORDER BY ts_rank(
         to_tsvector($2, coalesce(title, '') || ' ' || coalesce(description, '')),
         plainto_tsquery($2, $3)
       ) DESC`,
      tourIds,
      FTS_CONFIG,
      searchTerm
    );
    return rows.map(r => r.id);
  } catch {
    return tourIds;
  }
}

/**
 * Get tour IDs matching a full-text search query, ranked by relevance.
 * Returns { ids: string[], totalCount: number } with pagination applied.
 */
async function searchToursByRelevance(searchTerm, where, skip, take) {
  const idsResult = await prisma.tour.findMany({
    where,
    select: { id: true },
  });

  const allIds = idsResult.map(r => r.id);
  if (!allIds.length) return { ids: [], totalCount: 0 };

  const rankedIds = await rankTourIdsBySearch(searchTerm, allIds);
  const totalCount = rankedIds.length;
  const pageIds = rankedIds.slice(skip, skip + take);

  return { ids: pageIds, totalCount };
}

module.exports = {
  rankTourIdsBySearch,
  searchToursByRelevance,
  FTS_CONFIG,
};
