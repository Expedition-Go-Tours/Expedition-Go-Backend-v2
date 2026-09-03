/**
 * Deterministic app-activity engine for the TravioAfrica ops assistant.
 *
 * Answers "check activity / what happened / who logged in / any errors" style
 * questions with STRUCTURED FACTS computed in SQL — never free-form model
 * guesses. The LLM is only allowed to narrate these facts.
 *
 * All queries are read-only and executed against the AuditLog (and supporting
 * tables). api.error rows already carry a `metadata.classification` written by
 * errorMiddleware: real (5xx) / auth (401) / business (intentional 4xx).
 * Scanner 404s and route misses are not recorded at all.
 *
 * @version 1.0.0
 */

const WINDOW_DEFAULT_HOURS = 2;

/**
 * @param {Object} opts
 * @param {Object} opts.pg     - pg client or any { query(sql) } returning { rows }.
 * @param {number} [opts.hours] - look-back window (default 2).
 * @returns {Promise<Object>} structured activity facts (see shape below).
 */
async function buildActivityReport({ pg, hours = WINDOW_DEFAULT_HOURS } = {}) {
  const now = new Date();
  const start = new Date(now.getTime() - hours * 3600000);
  const isoStart = start.toISOString().replace('T', ' ').slice(0, 19);
  const isoNow = now.toISOString().replace('T', ' ').slice(0, 19);

  const facts = {
    window: { hours, start: isoStart, end: isoNow },
    errors: { real: [], auth: [], business: [] },
    logins: [],
    signups: { users: 0, suppliers: 0 },
    anomalies: [],
    noise: { probes: 0 },
    generatedAt: now.toISOString(),
  };

  // ── Errors: real (5xx) grouped by endpoint + user ──────────────
  {
    const r = await pg.query(`
      SELECT metadata->'endpoint'->>'url' AS endpoint,
             metadata->>'statusCode' AS status,
             metadata->>'errorName' AS name,
             COALESCE("userEmail", '(anonymous)') AS email,
             count(*)::int AS count,
             min("createdAt") AS first_at,
             max("createdAt") AS last_at
      FROM "AuditLog"
      WHERE action = 'api.error'
        AND metadata->>'classification' IN ('real', 'auth')
        AND "createdAt" >= '${isoStart}' AND "createdAt" <= '${isoNow}'
      GROUP BY 1, 2, 3, 4
      ORDER BY count DESC
    `);
    for (const row of r.rows) {
      const cls = row.status === '401' ? 'auth' : 'real';
      facts.errors[cls].push({
        endpoint: row.endpoint || '(unknown)',
        status: row.status,
        errorName: row.name || 'Error',
        count: row.count,
        users: [row.email],
        firstAt: fmt(row.first_at),
        lastAt: fmt(row.last_at),
      });
    }
  }

  // ── Errors: business 4xx (intentional, e.g. "No supplier application found") ─
  {
    const r = await pg.query(`
      SELECT metadata->'endpoint'->>'url' AS endpoint,
             metadata->>'statusCode' AS status,
             metadata->>'message' AS message,
             COALESCE("userEmail", '(anonymous)') AS email,
             count(*)::int AS count
      FROM "AuditLog"
      WHERE action = 'api.error'
        AND metadata->>'classification' = 'business'
        AND "createdAt" >= '${isoStart}' AND "createdAt" <= '${isoNow}'
      GROUP BY 1, 2, 3, 4
      ORDER BY count DESC
    `);
    for (const row of r.rows) {
      facts.errors.business.push({
        endpoint: row.endpoint || '(unknown)',
        status: row.status,
        message: row.message || '',
        count: row.count,
        users: [row.email],
      });
    }
  }

  // ── Scanner/probe count still observed (informational, never "errors") ──
  {
    // Noise is filtered at write time now, but older rows (before this fix) may
    // still carry probe paths. Count them only so a digest can say "N probe
    // requests blocked/ignored" without ever calling them application errors.
    const r = await pg.query(`
      SELECT count(*)::int AS probes
      FROM "AuditLog"
      WHERE action = 'api.error'
        AND metadata->>'classification' IS NULL
        AND metadata->'endpoint'->>'url' ~ '/dns-query|/query|/resolve|/owa/|/Dr0v|/ui/|favicon|/.env'
        AND "createdAt" >= '${isoStart}' AND "createdAt" <= '${isoNow}'
    `);
    facts.noise.probes = r.rows[0]?.probes || 0;
  }

  // ── Logins: exact email + time ─────────────────────────────────
  {
    const r = await pg.query(`
      SELECT "userEmail" AS email, "createdAt" AS at
      FROM "AuditLog"
      WHERE action = 'auth.login'
        AND "createdAt" >= '${isoStart}' AND "createdAt" <= '${isoNow}'
      ORDER BY "createdAt" ASC
    `);
    facts.logins = r.rows.map((row) => ({ email: row.email, at: fmt(row.at) }));
  }

  // ── Signups ─────────────────────────────────────────────────────
  {
    const r = await pg.query(`
      SELECT
        (SELECT count(*)::int FROM "User" WHERE "createdAt" >= '${isoStart}' AND "createdAt" <= '${isoNow}') AS users,
        (SELECT count(*)::int FROM "SupplierProfile" WHERE "createdAt" >= '${isoStart}' AND "createdAt" <= '${isoNow}') AS suppliers
    `);
    facts.signups.users = r.rows[0]?.users || 0;
    facts.signups.suppliers = r.rows[0]?.suppliers || 0;
  }

  // ── Anomaly: burst detection (>=5 same-user errors in <60s) ─────
  {
    const r = await pg.query(`
      WITH bursts AS (
        SELECT "userEmail",
               metadata->'endpoint'->>'url' AS endpoint,
               date_trunc('second', "createdAt") AS sec,
               count(*)::int AS per_sec
        FROM "AuditLog"
        WHERE action = 'api.error'
          AND metadata->>'classification' = 'real'
          AND "createdAt" >= '${isoStart}' AND "createdAt" <= '${isoNow}'
        GROUP BY 1, 2, 3
        HAVING count(*) >= 5
      )
      SELECT "userEmail" AS email, endpoint, max(per_sec) AS peak, count(*)::int AS seconds
      FROM bursts
      GROUP BY 1, 2
      ORDER BY peak DESC
    `);
    for (const row of r.rows) {
      facts.anomalies.push({
        type: 'error_burst',
        email: row.email || '(anonymous)',
        endpoint: row.endpoint,
        peakPerSecond: row.peak,
        seconds: row.seconds,
      });
    }
  }

  return facts;
}

function fmt(v) {
  if (!v) return null;
  const s = new Date(v);
  return Number.isNaN(s.getTime()) ? String(v) : s.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

module.exports = { buildActivityReport, WINDOW_DEFAULT_HOURS };
