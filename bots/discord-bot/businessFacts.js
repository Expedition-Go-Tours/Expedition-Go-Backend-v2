/**
 * businessFacts.js — deterministic business-metric layer for the Discord bot.
 *
 * Produces the NUMBERS. Never produces the prose. The caller hands the returned
 * facts to MiMo, which writes the natural-language answer under a constrained
 * system prompt (FACT_NARRATE_SYSTEM) that forbids inventing or inferring a
 * figure. This keeps answer quality and natural language intact while making
 * every number reproducible.
 *
 * Why a facts layer at all: the Phase 0 replay showed the bot answering the same
 * question two different ways — "total revenue for the past week" returned
 * $604.00 on one run and $105.00 on the next, because the model chose a
 * different status filter each time. The SQL agent is the reason the bot is
 * capable of answering novel questions, and it stays the fallback for
 * everything this layer does not claim; but a number the business quotes
 * internally cannot depend on which filter the model happened to pick.
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 *   answerBusinessFact() is the whole pipeline: route → cache lookup → query →
 *   currency gate → integrity gate → narrate (→ reviewed template if the model
 *   call fails). It returns
 *     { ok: true,  answer, fact, sql, facts, route, sqlMs, narrMs, totalMs,
 *       cacheHit, narrFallback }
 *     { ok: false, stage, reason }  — a refusal the caller MUST honour by
 *                                    falling through to the SQL agent.
 *
 *   Two later additions, both Phase 3, both designed so that neither can turn
 *   a wrong number into a confident one:
 *     - a shared in-process cache (below), which can only ever replay a result
 *       that already passed every gate; and
 *     - renderReviewedTemplate(), used ONLY when the narration call fails.
 *       MiMo writes the prose for every routed question; the template is the
 *       fallback for the one case where it could not.
 *   A refusal is never an error to be swallowed into a wrong answer. The
 *   currency gate below is the important case: all bookings are USD today, so a
 *   flat total would look right until a second currency made it wrong. Rather
 *   than substitute USD for a question that asked for GBP, it refuses.
 *
 *   getBusinessFacts() is the single-metric step underneath it, exported because
 *   the fact SQL is unit-tested directly and because the revenue-definition
 *   audit needs the raw query.
 *
 * Every SELECT carries explicit AS aliases. Positional row access (x[0])
 * silently yields undefined, because pg keys rows by column NAME; that
 * produced empty fact objects during Phase 0 which the narration then reported
 * as a confident "no data is available". factIntegrity() below exists to make
 * that class of bug loud.
 *
 * @module bots/discord-bot/businessFacts
 */

const {
  REVENUE_STATUSES,
  SIMULATED_BOOKING_CLAUSE,
  TOP_TOURS_DATE_COLUMN,
  revenueClauses,
  windowClause,
  describeWindow,
  money,
} = require('../../src/core/services/metricDefinitions');
const { routeToFact, factsCacheEnabled, factsTemplateEnabled } = require('./factRouter');

/**
 * Constrained narration contract for MiMo. Mirrors ACTIVITY_NARRATE_SYSTEM in
 * queryAgent.js: the model may only restate supplied facts, and must never
 * produce a number of its own.
 */
const FACT_NARRATE_SYSTEM = [
  'You turn a pre-computed business-facts report into a concise, accurate answer for a travel-operations operator.',
  '',
  'STRICT RULES:',
  '- State ONLY figures present in the report JSON. Never invent, estimate, extrapolate, round, or infer a number.',
  '- Always name the time window the facts cover. If the report window is "all time", say "All time" explicitly in the answer.',
  '- If money spans more than one currency, report each currency separately and NEVER sum across currencies.',
  '- The report states which filter definitions were applied (e.g. which booking statuses count as revenue). Do not contradict or restate them differently.',
  '- If the report contains no rows, say plainly that there were none.',
  '- Do not compare with other periods unless the report contains both.',
  '- No emojis or emoticons (symbols such as $ and % are fine). Use **bold** for key numbers.',
  '- Be concise and professional, with no filler and no preamble.',
  'Output ONLY the answer text.',
].join('\n');

/** Bounded result sizes. Prevents an accidental full-table scan being narrated. */
const LIMITS = Object.freeze({ topTours: 5, topToursMax: 10 });

/**
 * Minimal sequential-parameter WHERE builder.
 *
 * Every `?` must receive its own $N. Computing the index once per fragment
 * collapses a two-parameter predicate to $1,$1, which Postgres rejects with
 * "could not determine data type of parameter $1" — the same failure that
 * silently emptied the compact schema earlier.
 */
function where() {
  const clauses = [];
  const params = [];
  return {
    add(fragment, values = []) {
      // Capture the base BEFORE mutating params, or the index shifts
      // mid-replacement and later placeholders skip numbers.
      const base = params.length;
      let used = 0;
      const sql = fragment.replace(/\?/g, () => {
        const pos = base + 1 + used;
        params.push(values[used]);
        used += 1;
        return `$${pos}`;
      });
      if (sql.trim()) clauses.push(sql);
      return this;
    },
    get sql() {
      return clauses.length ? clauses.join(' AND ') : 'TRUE';
    },
    get params() {
      return params;
    },
  };
}

/**
 * Normalise a SQL numeric to a JS number, WITHOUT turning a missing value into
 * a zero.
 *
 * pg returns rows keyed by column NAME, so a SELECT that forgets an alias (or
 * aliases it differently) yields `undefined` for that field rather than
 * throwing. Collapsing `undefined` to `null` here would let that row through as
 * "no value" and the narration would report $0.00 with full confidence — the
 * same silent failure that previously emptied the compact schema. `undefined`
 * and non-numeric input are therefore passed through as `undefined`, which
 * factIntegrity() reports as a malformed fact before anything is narrated.
 *
 * A genuine SQL NULL (AVG over zero rows, for instance) stays `null`.
 */
const num = (x) => {
  if (x === undefined) return undefined;
  if (x === null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * First row of a scalar aggregate, or an empty object.
 *
 * A COUNT/AVG query always returns exactly one row, so in production this is
 * just rows[0]. Returning {} rather than throwing matters when it is NOT one
 * row: the resulting fact has undefined fields, which factIntegrity() reports
 * loudly, instead of a TypeError that looks like a crash. A refusal is fine; a
 * confident wrong number is not.
 */
const first = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : {});

/**
 * Detect a malformed fact payload: any object with no own keys, or any
 * explicitly-undefined field.
 *
 * A facts layer that returns empty objects is WORSE than no facts layer — the
 * narration turns them into a confident "there were none". This is a gate, not
 * a lint.
 */
function factIntegrity(facts) {
  const problems = [];
  const walk = (node, pathStr) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pathStr}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      if (keys.length === 0) {
        problems.push(`${pathStr} is an empty object (all fields undefined)`);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (v === undefined) problems.push(`${pathStr}.${k} is undefined`);
        else walk(v, `${pathStr}.${k}`);
      }
    }
  };
  walk(facts, 'facts');
  return problems;
}

// ── Per-metric queries ─────────────────────────────────────────────────────

/**
 * Resolve a deterministic fact.
 *
 * @param {string} metric
 * @param {object} opts
 * @param {Date}   [opts.from] inclusive start
 * @param {Date}   [opts.to]   exclusive end
 * @param {object} [opts.window] the route's window (used for the isAllTime rule)
 * @param {string} [opts.statusFilter]
 * @param {boolean}[opts.windowedCount]
 * @param {string} [opts.currencyFilter]
 * @param {string} [opts.customerRole]
 * @param {object} pg  a pg-like client (only .query is used)
 * @returns {Promise<object>} never throws
 */
async function getBusinessFacts(metric, opts = {}) {
  const {
    window: win = {},
    statusFilter = null,
    windowedCount = false,
    currencyFilter = null,
    customerRole = null,
    topToursLimit = null,
    pg,
    onRowCount = null,
  } = opts;
  const q = where();
  // Single exit for every metric's query, which makes it the one place a row
  // count can be observed without repeating it in all ~18 return statements.
  // The answer query is always the last one a metric runs, so last-write-wins
  // reports the rows the caller actually answered from.
  const run = async (sql, params) => {
    const rows = (await pg.query(sql, params)).rows;
    if (onRowCount) onRowCount(rows.length);
    return rows;
  };
  const wLabel = describeWindow(win);

  try {
    switch (metric) {
      // ── REVENUE ────────────────────────────────────────────────────────
      // Grouped by currency, always. Every window drops simulated seed
      // bookings: a period figure that counted them contradicted the all-time
      // figure and the rest of the platform. See metricDefinitions note 1.
      case 'revenue': {
        const { clauses, note } = revenueClauses();
        q.add(clauses.join(' AND '));
        const w = windowClause('"b"."createdAt"', win);
        if (w.clause) q.add(w.clause, w.params);
        if (currencyFilter) q.add('"b"."currency" = ?', [currencyFilter]);
        const sql =
          'SELECT "b"."currency" AS currency, COUNT(*)::int AS bookings, ' +
          'COALESCE(SUM("b"."total"),0)::text AS gross ' +
          `FROM "Booking" b WHERE ${q.sql} GROUP BY "b"."currency" ORDER BY bookings DESC`;
        const rows = await run(sql, q.params);
        return {
          ok: true,
          metric,
          window: wLabel,
          definition: `revenue = ${note}`,
          currencyGrouping: 'by currency; never summed across currencies',
          sql,
          facts: {
            currencyCount: rows.length,
            byCurrency: rows.map((r) => ({
              currency: r.currency,
              bookings: r.bookings,
              gross: num(r.gross),
              grossFormatted: money(num(r.gross), r.currency),
            })),
          },
        };
      }

      // ── BOOKINGS ───────────────────────────────────────────────────────
      // Simulated seed bookings are excluded here too: a count that included
      // them next to a revenue total that did not would contradict itself.
      case 'bookings': {
        q.add(SIMULATED_BOOKING_CLAUSE);
        if (statusFilter) q.add('"b"."status"::text = ?', [statusFilter]);
        const w = windowClause('"b"."createdAt"', win);
        if (w.clause) q.add(w.clause, w.params);
        if (currencyFilter) q.add('"b"."currency" = ?', [currencyFilter]);
        const sql =
          'SELECT "b"."status"::text AS status, "b"."currency" AS currency, COUNT(*)::int AS n, ' +
          'COALESCE(SUM("b"."total"),0)::text AS gross ' +
          `FROM "Booking" b WHERE ${q.sql} GROUP BY 1,2 ORDER BY n DESC`;
        const rows = await run(sql, q.params);
        return {
          ok: true,
          metric,
          window: wLabel,
          definition: (statusFilter ? `status = ${statusFilter}` : 'all booking statuses, grouped') + '; simulated excluded',
          currencyGrouping: 'by currency; never summed across currencies',
          sql,
          facts: {
            rows: rows.map((r) => ({
              status: r.status, currency: r.currency, n: r.n, gross: num(r.gross),
            })),
          },
        };
      }

      // ── TOURS ──────────────────────────────────────────────────────────
      case 'tours': {
        if (statusFilter) {
          q.add('"status"::text = ?', [statusFilter]);
          const sql = `SELECT COUNT(*)::int AS n FROM "Tour" WHERE ${q.sql}`;
          const rows = await run(sql, q.params);
          return {
            ok: true, metric, window: 'current snapshot', statusFilter, sql,
            definition: `tours with status = ${statusFilter}`,
            facts: { n: first(rows).n, status: statusFilter },
          };
        }
        if (windowedCount) {
          const w = windowClause('"createdAt"', win);
          if (w.clause) q.add(w.clause, w.params);
          const sql = `SELECT COUNT(*)::int AS n FROM "Tour" WHERE ${q.sql}`;
          const rows = await run(sql, q.params);
          return {
            ok: true, metric, window: wLabel, sql,
            definition: 'tours created in the window',
            facts: { created: first(rows).n },
          };
        }
        const sql = 'SELECT "status"::text AS status, COUNT(*)::int AS n FROM "Tour" GROUP BY 1 ORDER BY n DESC';
        const rows = await run(sql, []);
        return {
          ok: true, metric, window: 'current snapshot', sql,
          definition: 'tours by status',
          facts: { rows: rows.map((r) => ({ status: r.status, n: r.n })) },
        };
      }

      // ── SUPPLIERS ──────────────────────────────────────────────────────
      case 'suppliers': {
        if (statusFilter) {
          q.add('"status"::text = ?', [statusFilter]);
          const sql = `SELECT COUNT(*)::int AS n FROM "SupplierProfile" WHERE ${q.sql}`;
          const rows = await run(sql, q.params);
          return {
            ok: true, metric, window: 'current snapshot', statusFilter, sql,
            definition: `supplier profiles with status = ${statusFilter}`,
            facts: { n: first(rows).n, status: statusFilter },
          };
        }
        if (windowedCount) {
          const w = windowClause('"createdAt"', win);
          if (w.clause) q.add(w.clause, w.params);
          const sql = `SELECT COUNT(*)::int AS n FROM "SupplierProfile" WHERE ${q.sql}`;
          const rows = await run(sql, q.params);
          return {
            ok: true, metric, window: wLabel, sql,
            definition: 'supplier profiles created in the window',
            facts: { created: first(rows).n },
          };
        }
        const sql = 'SELECT "status"::text AS status, COUNT(*)::int AS n FROM "SupplierProfile" GROUP BY 1 ORDER BY n DESC';
        const rows = await run(sql, []);
        return {
          ok: true, metric, window: 'current snapshot', sql,
          definition: 'supplier profiles by status',
          facts: { rows: rows.map((r) => ({ status: r.status, n: r.n })) },
        };
      }

      // ── SIGNUPS ────────────────────────────────────────────────────────
      case 'signups': {
        const w = windowClause('"createdAt"', win);
        if (w.clause) q.add(w.clause, w.params);
        const sql = `SELECT COUNT(*)::int AS n FROM "User" WHERE ${q.sql}`;
        const rows = await run(sql, q.params);
        return {
          ok: true, metric, window: wLabel, sql,
          definition: 'user accounts created in the window (all roles)',
          facts: { newUsers: first(rows).n },
        };
      }

      // ── CUSTOMERS (customer-role users) ───────────────────────────────
      // 52 on 2026-09-29. NOT the same as bookingCustomers (26) or users (91).
      case 'customers': {
        if (!customerRole) {
          return { ok: false, metric, reason: 'customers requires an explicit customer role' };
        }
        const sql = `SELECT COUNT(*)::int AS n FROM "User" WHERE "roles" @> ARRAY[${quoteLiteral(customerRole)}]::"UserRole"[]`;
        const rows = await run(sql, []);
        return {
          ok: true, metric, window: 'current snapshot', sql,
          definition: `users holding the '${customerRole}' role`,
          facts: { n: first(rows).n, population: `users with the '${customerRole}' role` },
        };
      }

      // ── BOOKING CUSTOMERS (distinct users who have booked) ─────────────
      case 'bookingCustomers': {
        const sql = `SELECT COUNT(DISTINCT "customerId")::int AS n FROM "Booking" b WHERE ${SIMULATED_BOOKING_CLAUSE}`;
        const rows = await run(sql, []);
        return {
          ok: true, metric, window: 'all time', sql,
          definition: 'distinct users with at least one real (non-simulated) booking',
          facts: { n: first(rows).n, population: 'distinct booking customers' },
        };
      }

      // ── USERS (all accounts) ───────────────────────────────────────────
      case 'users': {
        const sql = 'SELECT COUNT(*)::int AS n FROM "User"';
        const rows = await run(sql, []);
        return {
          ok: true, metric, window: 'all time', sql,
          definition: 'all user accounts, every role',
          facts: { n: first(rows).n, population: 'all users' },
        };
      }

      // ── REFUNDS ────────────────────────────────────────────────────────
      case 'refunds': {
        q.add('"b"."status"::text = ?', ['REFUNDED']);
        const w = windowClause('"b"."createdAt"', win);
        if (w.clause) q.add(w.clause, w.params);
        if (currencyFilter) q.add('"b"."currency" = ?', [currencyFilter]);
        const sql =
          'SELECT "b"."currency" AS currency, COUNT(*)::int AS n, ' +
          'COALESCE(SUM("b"."refundAmount"),0)::text AS amount ' +
          `FROM "Booking" b WHERE ${q.sql} GROUP BY 1 ORDER BY n DESC`;
        const rows = await run(sql, q.params);
        return {
          ok: true, metric, window: wLabel, sql,
          definition: 'bookings with status = REFUNDED',
          currencyGrouping: 'by currency; never summed across currencies',
          facts: {
            byCurrency: rows.map((r) => ({
              currency: r.currency, n: r.n, amount: num(r.amount),
              amountFormatted: money(num(r.amount), r.currency),
            })),
          },
        };
      }

      // ── DISPUTES ───────────────────────────────────────────────────────
      case 'disputes': {
        if (statusFilter) {
          q.add('"status"::text = ?', [statusFilter]);
          const sql = `SELECT COUNT(*)::int AS n FROM "Dispute" WHERE ${q.sql}`;
          const rows = await run(sql, q.params);
          return {
            ok: true, metric, window: 'current snapshot', statusFilter, sql,
            definition: `disputes with status = ${statusFilter}`,
            facts: { n: first(rows).n, status: statusFilter },
          };
        }
        const sql = 'SELECT "status"::text AS status, COUNT(*)::int AS n FROM "Dispute" GROUP BY 1 ORDER BY n DESC';
        const rows = await run(sql, []);
        return {
          ok: true, metric, window: 'current snapshot', sql,
          definition: 'disputes by status',
          facts: { rows: rows.map((r) => ({ status: r.status, n: r.n })) },
        };
      }

      // ── PAYOUTS ────────────────────────────────────────────────────────
      case 'payouts': {
        if (statusFilter) q.add('"status"::text = ?', [statusFilter]);
        const w = windowClause('"createdAt"', win);
        if (w.clause) q.add(w.clause, w.params);
        if (currencyFilter) q.add('"currency" = ?', [currencyFilter]);
        const sql =
          'SELECT "status"::text AS status, "currency" AS currency, COUNT(*)::int AS n, ' +
          'COALESCE(SUM("amount"),0)::text AS amount ' +
          `FROM "PayoutRequest" WHERE ${q.sql} GROUP BY 1,2 ORDER BY n DESC`;
        const rows = await run(sql, q.params);
        return {
          ok: true, metric, window: wLabel, sql,
          definition: 'payout requests',
          currencyGrouping: 'by currency; never summed across currencies',
          facts: {
            rows: rows.map((r) => ({
              status: r.status, currency: r.currency, n: r.n, amount: num(r.amount),
            })),
          },
        };
      }

      // ── REVIEWS ────────────────────────────────────────────────────────
      case 'reviews': {
        const w = windowClause('"createdAt"', win);
        if (w.clause) q.add(w.clause, w.params);
        const sql = `SELECT COUNT(*)::int AS count, AVG("rating")::text AS avg FROM "Review" WHERE ${q.sql}`;
        const rows = await run(sql, q.params);
        return {
          ok: true, metric, window: wLabel, sql,
          definition: 'average star rating of reviews in the window',
          facts: { count: first(rows).count, avg: num(first(rows).avg) },
        };
      }

      // ── TOP TOURS (revenue-oriented) ──────────────────────────────────
      // Reads paidAt, never createdAt. A "tours created" ranking is a separate
      // metric and must not be derived from this one.
      case 'topTours': {
        // The requested row count. A question that names a count we cannot serve
        // ("top 15 tours") is REFUSED, not silently truncated to the cap: the
        // caller falls through to the SQL agent, which can rank as many as asked.
        const requested = Number.isInteger(topToursLimit) ? topToursLimit : LIMITS.topTours;
        if (requested > LIMITS.topToursMax) {
          return {
            ok: false,
            metric,
            sql: '',
            reason: `requested ${requested} top tours, more than the ${LIMITS.topToursMax} this layer returns`,
          };
        }
        const limit = Math.max(1, Math.min(requested, LIMITS.topToursMax));
        q.add(`"b"."status" IN (${revenueStatusList()})`);
        q.add(SIMULATED_BOOKING_CLAUSE);
        if (currencyFilter) q.add('"b"."currency" = ?', [currencyFilter]);
        const dateCol = TOP_TOURS_DATE_COLUMN;
        const w = windowClause(`"b"."${dateCol}"`, win);
        if (w.clause) q.add(w.clause, w.params);
        // ORDER BY the numeric expression, NOT the `gross` alias: `gross` is
        // COALESCE(...)::text, so ordering by it sorts lexicographically and
        // "60" outranks "475". That returned the wrong tours in the wrong order
        // for every ranking question. `t."title"` breaks ties deterministically.
        const sql =
          'SELECT t."title" AS title, t."city" AS city, "b"."currency" AS currency, ' +
          'COUNT(*)::int AS bookings, COALESCE(SUM("b"."total"),0)::text AS gross ' +
          'FROM "Booking" b JOIN "Tour" t ON "b"."tourId" = t."id" ' +
          `WHERE ${q.sql} GROUP BY 1,2,3 ORDER BY COALESCE(SUM("b"."total"),0) DESC, t."title" ASC LIMIT ${limit}`;
        const rows = await run(sql, q.params);
        return {
          ok: true, metric, window: wLabel, sql,
          definition: `top tours by revenue using ${dateCol} (when payment was taken), status IN (${REVENUE_STATUSES.join(', ')}); simulated excluded`,
          currencyGrouping: 'by currency; never summed across currencies',
          facts: {
            dateColumn: dateCol,
            limit,
            rows: rows.map((r) => ({
              title: r.title, city: r.city, currency: r.currency,
              bookings: r.bookings, gross: num(r.gross),
              grossFormatted: money(num(r.gross), r.currency),
            })),
          },
        };
      }

      default:
        return { ok: false, metric, reason: `no fact query for metric: ${metric}` };
    }
  } catch (e) {
    return { ok: false, metric, sql: '', reason: String(e.message || e) };
  }
}

/** Escape a value for safe inclusion as a SQL string literal. */
function quoteLiteral(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** The approved revenue statuses as a SQL literal list: 'CONFIRMED','COMPLETED'. */
function revenueStatusList() {
  return REVENUE_STATUSES.map((s) => quoteLiteral(s)).join(',');
}

/**
 * Currency-safety gate.
 *
 * If the question named a currency and the returned data contains none in that
 * currency, the fact layer must REFUSE. Answering "we made $604" to "what is
 * the revenue in gbp" is a wrong answer delivered confidently; falling through
 * to the SQL agent is strictly better.
 *
 * @param {{currencyFilter: string|null}} route
 * @param {object} result a getBusinessFacts() result
 * @returns {{ok: boolean, reason?: string}}
 */
function currencyIsSatisfied(route, result) {
  if (!route || !route.currencyFilter) return { ok: true };
  if (!result || !result.ok) return { ok: false, reason: 'fact query failed' };

  const facts = result.facts || {};
  const rows = facts.byCurrency || facts.rows || [];
  const present = [...new Set(rows.map((r) => String(r.currency || '').toUpperCase()).filter(Boolean))];
  if (present.length === 0) {
    return {
      ok: false,
      reason: `no rows in any currency; declining rather than substituting a currency for ${route.currencyFilter}`,
    };
  }
  if (present.includes(route.currencyFilter)) return { ok: true };
  return { ok: false, reason: `data has [${present.join(', ')}] but the question asked for ${route.currencyFilter}` };
}

/**
 * Build the payload handed to MiMo for narration.
 * Includes the window, the filter definitions and the SQL so the narration —
 * and any later audit — can see exactly what produced the number.
 */
function buildNarrationPayload(question, result) {
  return {
    question,
    metric: result.metric,
    window: result.window,
    definition: result.definition || null,
    currencyGrouping: result.currencyGrouping || null,
    facts: result.facts,
  };
}

/** Narration is a short rewrite of a small JSON report. Matches FINAL_MAX_TOKENS. */
const NARRATE_MAX_TOKENS = 1400;

// ── Shared answer cache (Phase 3) ──────────────────────────────────────────
//
// Measured in the Phase 2 replay: SQL is 0.016% of fact-path wall clock (30ms
// of 189.6s across the 15 routed questions) and every routed question costs
// exactly ONE model call — the narration — which is the entire remaining
// latency (median 7.1s). The numbers are deterministic and effectively free,
// so a repeat of the same question should cost neither a query nor a
// round-trip.
//
// The key is the ROUTE, not the question text. Two questions that route
// identically ask for the same thing: "whats the revenue for the past month"
// and "show revenue by currency for the past month" both resolve to revenue +
// rolling 30 days + no currency filter. routeToFact only ever claims
// self-contained single-metric questions (its CONTEXTUAL_MARKERS decline "in
// usd" and anything that needs an earlier turn), so a route genuinely is an
// equivalence class of questions. Keying on wording would make this cache
// per-question rather than shared, and would leave the existing per-user Redis
// cache in index.js as the only reuse — one user asking the same thing twice.
//
// Deliberately in-process: the bot runs as a single PM2 process (instances:1),
// so a Map in this module is already shared by every user in every channel.
// Redis would add serialization plus a silent no-op whenever Redis is down, for
// an entry that lives a minute. The per-user Redis cache in index.js is
// untouched and still sits in front as a second layer.
//
// Freshness is a TTL rather than invalidation, because a rolling window's end
// moves with the clock and a booking can land at any moment. 60s matches
// ANSWER_CACHE_TTL_SEC in index.js.
const FACT_CACHE_TTL_MS = 60 * 1000;
/** Longest an in-flight narration may be shared before a later caller retries. */
const FACT_CACHE_PENDING_MS = 2 * 60 * 1000;
const FACT_CACHE_MAX = 200;

/**
 * key → `{ value }` for a settled success, or `{ promise }` for an in-flight
 * one. The promise is single-flight: two operators asking the same question a
 * second apart share ONE model call instead of racing two 19-second calls.
 * Refusals are never stored, so a transient failure is retried rather than
 * pinned for a minute.
 */
const factCache = new Map();

/**
 * Cache identity for a route.
 *
 * Everything getBusinessFacts() reads is in here — metric, window, status,
 * windowed-count, currency, role, date column and top-N limit — so two routes
 * with the same key necessarily produce the same SQL and the same facts.
 * `window.from`/`to` are deliberately NOT in the key: they move every
 * millisecond for a rolling window, which would make every rolling entry
 * uncacheable. The TTL is the freshness bound instead, and it also covers the
 * calendar case (a booking landing mid-day).
 *
 * @param {object|null} route
 * @returns {string|null}
 */
function factCacheKey(route) {
  if (!route) return null;
  const w = route.window || {};
  return [
    route.metric || '',
    w.label || '',
    w.isAllTime ? 'all' : 'win',
    route.statusFilter || '',
    route.windowedCount ? 'wc' : '',
    route.currencyFilter || '',
    route.customerRole || '',
    route.topToursDateColumn || '',
    route.topToursLimit == null ? '' : String(route.topToursLimit),
  ].join('|');
}

function factCacheGet(key) {
  const entry = factCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    factCache.delete(key);
    return null;
  }
  // Re-insert to mark recency: a Map iterates in insertion order, so the first
  // key is always the least recently used.
  factCache.delete(key);
  factCache.set(key, entry);
  return entry;
}

function factCacheSet(key, entry) {
  factCache.delete(key);
  factCache.set(key, entry);
  while (factCache.size > FACT_CACHE_MAX) {
    const oldest = factCache.keys().next().value;
    if (oldest === key) break; // never evict what was just written
    factCache.delete(oldest);
  }
}

/** Tests and any future invalidation hook. */
function clearFactCache() {
  factCache.clear();
}

// ── Reviewed template (Phase 3) ────────────────────────────────────────────

/**
 * Render a reviewed, deterministic answer from facts the gates already proved.
 *
 * This is the FALLBACK for a failed narration call and nothing else. MiMo
 * writes the prose for every routed question under FACT_NARRATE_SYSTEM; this
 * runs only when that call throws or comes back empty, where the choice is
 * between a reviewed rendering of numbers we have already validated, and
 * falling through to the SQL agent — the nondeterministic path that answered
 * "revenue for the past month" as $4,833.14 on one run and $5,733.14 on
 * another. Deterministic prose beats a dice roll, but only if it prints what it
 * was given.
 *
 * Rules it must keep:
 *   - Print ONLY fields present in `facts`. Anything missing, null or not a
 *     finite number makes it return null, which the caller turns back into a
 *     refusal — so an unrecognised fact shape degrades to today's behaviour
 *     (fall through to the SQL agent) rather than to a guess. This is why the
 *     switch has a `default: return null`.
 *   - Never sum across currencies; list one currency per clause.
 *   - Always lead with the window, as FACT_NARRATE_SYSTEM requires.
 *   - Never round. Trailing zeros are removed from an average because they
 *     carry no value; the digits themselves are never shortened.
 *
 * @param {object} route
 * @param {object} fact a getBusinessFacts() result
 * @returns {string|null} null means "cannot render this — refuse"
 */
function renderReviewedTemplate(route, fact) {
  if (!fact || fact.ok === false || !fact.facts) return null;
  const f = fact.facts;
  const metric = fact.metric || (route && route.metric) || '';
  const win = String(fact.window || 'All time');
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const qty = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // money() returns null when the value was never there, which is a refusal.
  // The USD suffix is not decoration: money() renders USD as a bare "$", and an
  // operator reading "$4995.14" beside a second currency cannot tell which is
  // which — the exact ambiguity the currency-grouping rule exists to prevent.
  const cash = (amount, currency) => {
    if (typeof currency !== 'string' || !currency) return null;
    const m = money(amount, currency);
    if (m === null) return null;
    return currency === 'USD' ? `${m} USD` : m;
  };

  const body = (text) => {
    const d = String(fact.definition || '').replace(/\.$/, '');
    return d ? `${text}\nDefinition: ${d}.` : text;
  };

  switch (metric) {
    case 'revenue': {
      const rows = f.byCurrency;
      if (!Array.isArray(rows)) return null;
      if (rows.length === 0) return body(`${win}: there were no qualifying bookings.`);
      const parts = [];
      for (const r of rows) {
        if (!r || !isNum(r.bookings)) return null;
        const m = cash(r.gross, r.currency);
        if (m === null) return null;
        parts.push(`${m} from ${qty(r.bookings, 'booking', 'bookings')}`);
      }
      return body(`${win}: revenue was ${parts.join('; ')}.`);
    }

    case 'bookings': {
      const rows = f.rows;
      if (!Array.isArray(rows)) return null;
      if (rows.length === 0) return body(`${win}: there were no matching bookings.`);
      const parts = [];
      for (const r of rows) {
        if (!r || !isNum(r.n) || typeof r.status !== 'string') return null;
        const m = cash(r.gross, r.currency);
        if (m === null) return null;
        parts.push(`${r.status} (${r.currency}): ${qty(r.n, 'booking', 'bookings')}, ${m}`);
      }
      return body(`${win}: bookings by status — ${parts.join('; ')}.`);
    }

    // Three metrics share one shape: a status-filtered count, a windowed
    // created-count, or a by-status breakdown.
    case 'tours':
    case 'suppliers':
    case 'disputes': {
      const nouns = {
        tours: ['tour', 'tours'],
        suppliers: ['supplier profile', 'supplier profiles'],
        disputes: ['dispute', 'disputes'],
      }[metric];
      if (isNum(f.n) && typeof f.status === 'string') {
        return body(`${win}: ${qty(f.n, nouns[0], nouns[1])} with status ${f.status}.`);
      }
      if (isNum(f.created)) {
        return body(`${win}: ${qty(f.created, nouns[0], nouns[1])} ${f.created === 1 ? 'was' : 'were'} created.`);
      }
      if (Array.isArray(f.rows)) {
        if (f.rows.length === 0) return body(`${win}: there were no ${nouns[1]}.`);
        const parts = [];
        for (const r of f.rows) {
          if (!r || !isNum(r.n) || typeof r.status !== 'string') return null;
          parts.push(`${r.status}: ${r.n}`);
        }
        return body(`${win}: ${nouns[1]} by status — ${parts.join('; ')}.`);
      }
      return null;
    }

    case 'signups': {
      if (!isNum(f.newUsers)) return null;
      return body(
        `${win}: ${qty(f.newUsers, 'new user account', 'new user accounts')} ` +
          `${f.newUsers === 1 ? 'was' : 'were'} created.`,
      );
    }

    // The three populations are 52 / 26 / 91 and are never interchangeable, so
    // the template always spells out which one it counted — that substitution
    // was one of the Phase 0 defects.
    case 'customers':
    case 'bookingCustomers':
    case 'users': {
      if (!isNum(f.n)) return null;
      if (typeof f.population !== 'string' || !f.population) return null;
      return body(`${win}: ${f.n} (${f.population}).`);
    }

    case 'refunds': {
      const rows = f.byCurrency;
      if (!Array.isArray(rows)) return null;
      if (rows.length === 0) return body(`${win}: there were no refunds.`);
      const parts = [];
      for (const r of rows) {
        if (!r || !isNum(r.n)) return null;
        const m = cash(r.amount, r.currency);
        if (m === null) return null;
        parts.push(`${qty(r.n, 'refund', 'refunds')} totalling ${m}`);
      }
      return body(`${win}: ${parts.join('; ')}.`);
    }

    case 'payouts': {
      const rows = f.rows;
      if (!Array.isArray(rows)) return null;
      if (rows.length === 0) return body(`${win}: there were no payout requests.`);
      const parts = [];
      for (const r of rows) {
        if (!r || !isNum(r.n) || typeof r.status !== 'string') return null;
        const m = cash(r.amount, r.currency);
        if (m === null) return null;
        parts.push(`${r.status} (${r.currency}): ${qty(r.n, 'payout', 'payouts')}, ${m}`);
      }
      return body(`${win}: payout requests — ${parts.join('; ')}.`);
    }

    case 'reviews': {
      if (!isNum(f.count)) return null;
      if (f.count === 0) return body(`${win}: there were no reviews.`);
      // A non-zero count with no average cannot be rendered — inventing one is
      // exactly what this layer exists to prevent.
      if (!isNum(f.avg)) return null;
      // String() of a JS number is the shortest representation that round-trips,
      // so the "4.5000000000000000" padding of AVG(... )::text is already gone —
      // num() normalized it when the row was read. Printing it verbatim means
      // the figure is never rounded, which FACT_NARRATE_SYSTEM forbids.
      return body(`${win}: average rating ${String(f.avg)} from ${qty(f.count, 'review', 'reviews')}.`);
    }

    case 'topTours': {
      const rows = f.rows;
      if (!Array.isArray(rows)) return null;
      if (rows.length === 0) return body(`${win}: no tour had any qualifying revenue in that window.`);
      const lines = [];
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        if (!r || typeof r.title !== 'string' || !isNum(r.bookings)) return null;
        const m = cash(r.gross, r.currency);
        if (m === null) return null;
        const where = typeof r.city === 'string' && r.city ? ` (${r.city})` : '';
        lines.push(`${i + 1}. ${r.title}${where} — ${m} from ${qty(r.bookings, 'booking', 'bookings')}`);
      }
      return body(`${win}: top ${lines.length} tours by revenue.\n${lines.join('\n')}`);
    }

    default:
      // An unknown metric has no reviewed wording. Refusing is the safe
      // direction: the SQL agent answers it exactly as it did before Phase 3.
      return null;
  }
}

/**
 * The uncached pipeline: query → currency gate → integrity gate → narrate,
 * with the reviewed template as the narration fallback.
 *
 * Never throws. Every refusal carries a `stage` the caller reports on.
 *
 * @param {object} args see answerBusinessFact
 * @param {object} args.route a resolved route (already known non-null)
 * @param {number} args.t0 pipeline start, for timing
 * @param {Function|null} args.renderTemplate injectable so tests (and an
 *        operator wanting today's behaviour back) can disable the fallback.
 */
async function runFactPipeline({ question, route, pg, callMimo, maxTokens, t0, renderTemplate }) {
  const sqlMs0 = Date.now();
  // Captured via the callback rather than returned by each metric branch, so
  // every path out of this function reports the rows behind the answer.
  let factRowCount = 0;
  const fact = await getBusinessFacts(route.metric, {
    window: route.window,
    statusFilter: route.statusFilter,
    windowedCount: route.windowedCount,
    currencyFilter: route.currencyFilter,
    customerRole: route.customerRole,
    // "top 3 tours" must return three rows. Dropping this silently answered the
    // default five, which is how the harness and the router disagreed.
    topToursLimit: route.topToursLimit,
    pg,
    onRowCount: (n) => {
      factRowCount = n;
    },
  });
  const sqlMs = Date.now() - sqlMs0;
  const base = {
    route,
    fact,
    sql: fact.sql || '',
    facts: fact.facts,
    sqlMs,
    // Rows the generated SQL returned. The caller logs `sql=[...] rows=N`
    // together, so leaving this at 0 reported every successful fact query as
    // having matched nothing.
    rowCount: factRowCount,
    // Set false here; the wrapper marks a served-from-cache result.
    cacheHit: false,
    narrFallback: null,
  };

  if (!fact.ok) {
    return { ...base, ok: false, stage: 'query', reason: fact.reason, totalMs: Date.now() - t0 };
  }

  const currencyGate = currencyIsSatisfied(route, fact);
  if (!currencyGate.ok) {
    return { ...base, ok: false, stage: 'currency', reason: currencyGate.reason, currencyGate, totalMs: Date.now() - t0 };
  }

  const problems = factIntegrity(fact.facts);
  if (problems.length) {
    return {
      ...base, ok: false, stage: 'integrity', reason: problems[0],
      integrity: { ok: false, problems }, totalMs: Date.now() - t0,
    };
  }

  // Narration by the model — the fact layer supplies the numbers, MiMo supplies
  // the prose. This is a hard requirement: the facts path must not collapse into
  // a template-only responder, which is why the template below is unreachable
  // while this call succeeds.
  const tNarr = Date.now();
  let answer = null;
  let narrError = null;
  try {
    const raw = await callMimo({
      messages: [
        { role: 'system', content: FACT_NARRATE_SYSTEM },
        { role: 'user', content: JSON.stringify(buildNarrationPayload(question, fact), null, 1) },
      ],
      maxTokens,
      temperature: 0.1,
      reasoningEffort: 'low',
    });
    answer = String(raw || '').trim();
  } catch (e) {
    narrError = String(e.message || e);
  }
  const narrMs = Date.now() - tNarr;

  if (!narrError && answer) {
    return {
      ...base,
      ok: true,
      stage: 'answered',
      reason: null,
      answer,
      narrError: null,
      narrMs,
      totalMs: Date.now() - t0,
    };
  }

  // The narration call failed or came back empty. Posting nothing is not an
  // option (the caller would fall through to the SQL agent, the one path that
  // produced four different answers for the same question), so render the
  // reviewed template from facts that already cleared every gate. If that
  // cannot render the shape either, refuse — same behaviour as before Phase 3.
  //
  // Gated by AI_FACTS_TEMPLATE_ENABLED: with the flag off this line cannot run
  // at all, and a narration failure behaves exactly as it did in Phase 2.
  const render = renderTemplate || (factsTemplateEnabled() ? renderReviewedTemplate : null);
  let rendered = null;
  if (render) {
    try {
      rendered = render(route, fact);
    } catch (e) {
      // A template bug must degrade to a refusal, never to an exception that
      // escapes a pipeline documented as never throwing — and never to a
      // rejected promise, which would strand every single-flight waiter.
      rendered = null;
      console.warn(`[facts] template renderer threw for metric=${fact.metric}: ${e.message}`);
    }
  }
  if (rendered && String(rendered).trim()) {
    return {
      ...base,
      ok: true,
      stage: 'answered',
      reason: null,
      answer: String(rendered).trim(),
      narrError: narrError || 'narration returned an empty answer',
      narrMs,
      narrFallback: 'template',
      totalMs: Date.now() - t0,
    };
  }

  return {
    ...base,
    ok: false,
    stage: 'narrate',
    reason: narrError || 'narration returned an empty answer',
    answer: null,
    narrError,
    narrMs,
    totalMs: Date.now() - t0,
  };
}

/**
 * A result served from the shared cache: same object, but this call did no
 * work, so its timings are its own (0) rather than the original author's.
 */
function cacheHitResult(stored, t0) {
  return {
    ...stored,
    cacheHit: true,
    sqlMs: 0,
    narrMs: 0,
    totalMs: Date.now() - t0,
  };
}

/**
 * Answer one question end to end through the facts layer: route, compute, gate,
 * narrate — behind a shared cache.
 *
 * This is the ONLY implementation of the pipeline. bots/discord-bot/queryAgent.js
 * calls it from answerQuestion (behind factsEnabled()), and scripts/replayBot.js
 * calls the same function for its measurements. Keeping one copy is the point:
 * a replay that measures a parallel implementation of the fact path reports
 * numbers for code that never runs in production.
 *
 * ── Gate order, and why it is this order ───────────────────────────────────
 *   0. cache  — can only replay a result that already cleared gates 1–5.
 *   1. route   — a false negative here is harmless (the SQL agent answers).
 *   2. query   — a DB failure must refuse, never degrade to a zero.
 *   3. currency— answering "revenue in gbp" with USD data is a confident wrong
 *                answer, which is the one outcome worse than not answering.
 *   4. integrity — a malformed fact must never reach the narration.
 *   5. narrate— the model writes the prose. A failure falls back to the
 *                reviewed template; if that cannot render the shape either,
 *                it is a refusal and the caller uses the SQL agent rather
 *                than posting nothing.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {object} opts.pg       a pg-like client (only .query is used)
 * @param {Function} opts.callMimo  async ({messages, maxTokens, temperature,
 *        reasoningEffort}) => string
 * @param {Date}   [opts.now]     injectable clock, for deterministic tests
 * @param {number} [opts.maxTokens]
 * @param {boolean|null} [opts.cache] null (the default) defers to the
 *        AI_FACTS_CACHE_ENABLED gate. Pass false — as scripts/replayBot.js does
 *        — to measure the cold path, or true to force a cache test.
 * @param {number} [opts.cacheTtlMs]
 * @param {Function|null} [opts.renderTemplate] null (the default) defers to the
 *        AI_FACTS_TEMPLATE_ENABLED gate; pass a function to force the fallback
 *        on in a test, or `() => null` to force it off.
 * @returns {Promise<object>} `{ ok: false, stage, reason }` on any refusal — the
 *   caller MUST fall through. `{ ok: true, stage: 'answered', answer }` on
 *   success. Never throws.
 */
async function answerBusinessFact({
  question,
  pg,
  callMimo,
  now = null,
  maxTokens = NARRATE_MAX_TOKENS,
  cache = null,
  cacheTtlMs = FACT_CACHE_TTL_MS,
  renderTemplate = null,
}) {
  const useCache = cache === null ? factsCacheEnabled() : Boolean(cache);
  const t0 = Date.now();
  const route = routeToFact(question, now ? { now } : {});
  if (!route) {
    return {
      ok: false,
      stage: 'route',
      reason: 'router declined (falls through to the SQL agent)',
      route: null,
      cacheHit: false,
      narrFallback: null,
      totalMs: Date.now() - t0,
    };
  }

  const args = { question, route, pg, callMimo, maxTokens, t0, renderTemplate };

  if (!useCache) {
    const fresh = await runFactPipeline(args);
    return { ...fresh, cacheHit: false };
  }

  const key = factCacheKey(route);
  const entry = factCacheGet(key);
  if (entry) {
    if (entry.value) return cacheHitResult(entry.value, t0);
    if (entry.promise) {
      // Single-flight: wait for the caller who is already paying for this
      // narration instead of issuing a second model call for the same numbers.
      const settled = await entry.promise;
      return settled.ok ? cacheHitResult(settled, t0) : { ...settled, cacheHit: false, totalMs: Date.now() - t0 };
    }
  }

  // Only a SUCCESS is written back. A refusal is deleted, so a failed query or
  // a declined currency is retried on the next ask rather than pinned for a
  // minute — and no in-flight promise outlives a TTL of its own.
  const promise = runFactPipeline(args)
    .then((result) => {
      if (result.ok) {
        factCacheSet(key, { value: result, expiresAt: Date.now() + cacheTtlMs });
      } else {
        factCache.delete(key);
      }
      return result;
    })
    .catch((e) => {
      // Defence in depth. A rejection would otherwise escape to the caller —
      // the pipeline is documented as never throwing — and would leave this key
      // holding a promise nobody can settle, blocking every later single-flight
      // waiter. Convert it to the same refusal shape every other failure gives.
      factCache.delete(key);
      const reason = `unexpected fact pipeline error: ${String(e.message || e)}`;
      console.warn(`[facts] ${reason} metric=${route.metric}`);
      return {
        route,
        fact: {},
        sql: '',
        facts: undefined,
        sqlMs: 0,
        narrMs: 0,
        cacheHit: false,
        narrFallback: null,
        ok: false,
        stage: 'query',
        reason,
        totalMs: Date.now() - t0,
      };
    });
  factCacheSet(key, { promise, expiresAt: Date.now() + FACT_CACHE_PENDING_MS });

  const fresh = await promise;
  return { ...fresh, cacheHit: false, totalMs: Date.now() - t0 };
}

module.exports = {
  getBusinessFacts,
  answerBusinessFact,
  currencyIsSatisfied,
  buildNarrationPayload,
  factIntegrity,
  renderReviewedTemplate,
  // Shared-cache surface: exported for unit tests and for any future
  // invalidation hook. Nothing outside this module should reach into the Map.
  factCacheKey,
  clearFactCache,
  FACT_CACHE_TTL_MS,
  FACT_CACHE_MAX,
  FACT_NARRATE_SYSTEM,
  NARRATE_MAX_TOKENS,
  LIMITS,
};
