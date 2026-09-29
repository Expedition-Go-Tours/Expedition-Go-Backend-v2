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
 *   answerBusinessFact() is the whole pipeline: route → query → currency gate
 *   → integrity gate → narrate. It returns
 *     { ok: true,  answer, fact, sql, facts, route, sqlMs, narrMs, totalMs }
 *     { ok: false, stage, reason }  — a refusal the caller MUST honour by
 *                                    falling through to the SQL agent.
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
const { routeToFact } = require('./factRouter');

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
  } = opts;
  const q = where();
  const run = async (sql, params) => (await pg.query(sql, params)).rows;
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

/**
 * Answer one question end to end through the facts layer: route, compute, gate,
 * narrate.
 *
 * This is the ONLY implementation of the pipeline. bots/discord-bot/queryAgent.js
 * calls it from answerQuestion (behind factsEnabled()), and scripts/replayBot.js
 * calls the same function for its measurements. Keeping one copy is the point:
 * a replay that measures a parallel implementation of the fact path reports
 * numbers for code that never runs in production.
 *
 * ── Gate order, and why it is this order ───────────────────────────────────
 *   1. route   — a false negative here is harmless (the SQL agent answers).
 *   2. query   — a DB failure must refuse, never degrade to a zero.
 *   3. currency— answering "revenue in gbp" with USD data is a confident wrong
 *                answer, which is the one outcome worse than not answering.
 *   4. integrity — a malformed fact must never reach the narration.
 *   5. narrate— the model writes the prose. A failure or an empty string is a
 *                refusal too, so the caller falls back to the SQL agent rather
 *                than posting nothing.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {object} opts.pg       a pg-like client (only .query is used)
 * @param {Function} opts.callMimo  async ({messages, maxTokens, temperature,
 *        reasoningEffort}) => string
 * @param {Date}   [opts.now]     injectable clock, for deterministic tests
 * @param {number} [opts.maxTokens]
 * @returns {Promise<object>} `{ ok: false, stage, reason }` on any refusal — the
 *   caller MUST fall through. `{ ok: true, stage: 'answered', answer }` on
 *   success. Never throws.
 */
async function answerBusinessFact({ question, pg, callMimo, now = null, maxTokens = NARRATE_MAX_TOKENS }) {
  const t0 = Date.now();
  const route = routeToFact(question, now ? { now } : {});
  if (!route) {
    return {
      ok: false,
      stage: 'route',
      reason: 'router declined (falls through to the SQL agent)',
      route: null,
      totalMs: Date.now() - t0,
    };
  }

  const sqlMs0 = Date.now();
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
  });
  const sqlMs = Date.now() - sqlMs0;
  const base = { route, fact, sql: fact.sql || '', facts: fact.facts, sqlMs };

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
  // a template-only responder.
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

  // An empty answer is a refusal, not a success. The caller has an
  // UNANSWERABLE_MESSAGE fallback and the SQL agent; posting "" is neither.
  if (narrError || !answer) {
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

module.exports = {
  getBusinessFacts,
  answerBusinessFact,
  currencyIsSatisfied,
  buildNarrationPayload,
  factIntegrity,
  FACT_NARRATE_SYSTEM,
  NARRATE_MAX_TOKENS,
  LIMITS,
};
