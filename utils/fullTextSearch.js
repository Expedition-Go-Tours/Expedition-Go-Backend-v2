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
 *
 * Uses a single SQL CTE to avoid fetching all IDs into JS.
 */
async function searchToursByRelevance(searchTerm, where, skip, take) {
  if (!searchTerm) return { ids: [], totalCount: 0 };

  try {
    // Single SQL: FTS filter + rank + count + paginate
    // The CTE approach avoids two round-trips
    const rows = await prisma.$queryRawUnsafe(`
      WITH matched AS (
        SELECT id,
          ts_rank(
            to_tsvector($1, coalesce(title, '') || ' ' || coalesce(description, '')),
            plainto_tsquery($1, $2)
          ) AS rank
        FROM "Tour"
        WHERE status = 'ACTIVE'
          AND to_tsvector($1, coalesce(title, '') || ' ' || coalesce(description, ''))
              @@ plainto_tsquery($1, $2)
      )
      SELECT id, (SELECT COUNT(*)::int FROM matched) AS total
      FROM matched
      ORDER BY rank DESC
      OFFSET $3 LIMIT $4
    `, FTS_CONFIG, searchTerm, skip, take);

    const totalCount = rows.length > 0 ? rows[0].total : 0;
    return { ids: rows.map(r => r.id), totalCount };
  } catch {
    // Fallback: return empty — caller will handle gracefully
    return { ids: [], totalCount: 0 };
  }
}

module.exports = {
  rankTourIdsBySearch,
  searchToursByRelevance,
  FTS_CONFIG,
};
