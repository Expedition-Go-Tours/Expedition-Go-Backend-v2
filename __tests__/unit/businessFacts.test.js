/**
 * Unit tests for the deterministic business-facts layer.
 *
 * These pin the APPROVED business definitions (metricDefinitions.js) and the
 * safety behaviour of the fact layer. Two rules matter most:
 *
 *  1. A refusal must be a refusal. The currency gate in particular must never
 *     let a question about GBP be answered with USD numbers.
 *  2. A malformed fact must fail loudly. Empty/undefined fields once produced
 *     a confident "no data is available", which is a wrong answer dressed as a
 *     right one.
 */

const { routeToFact, factsEnabled } = require('../../bots/discord-bot/factRouter');
const {
  getBusinessFacts,
  answerBusinessFact,
  currencyIsSatisfied,
  buildNarrationPayload,
  factIntegrity,
  FACT_NARRATE_SYSTEM,
  NARRATE_MAX_TOKENS,
} = require('../../bots/discord-bot/businessFacts');
const {
  REVENUE_STATUSES,
  TOP_TOURS_DATE_COLUMN,
  CUSTOMER_ROLE,
  resolveWindow,
  money,
  describeWindow,
  revenueClauses,
  utcWeekStart,
  utcMonthStart,
  utcDayStart,
} = require('../../src/core/services/metricDefinitions');

// ── helpers ────────────────────────────────────────────────────────────────

/** Records every query and replies with the supplied rows. */
function makePg(rows = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows };
    },
  };
}

/**
 * Models Postgres' real rule: an unreferenced $N has no inferable type and the
 * whole statement fails. Guards against the placeholder-numbering bug.
 */
function makeStrictPg(rows = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params: params || [] });
      if (params && params.length) {
        const used = new Set([...String(sql).matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        for (let i = 1; i <= params.length; i++) {
          if (!used.has(i)) throw new Error(`could not determine data type of parameter $${i}`);
        }
      }
      return { rows };
    },
  };
}

const NOW = new Date('2026-09-29T12:00:00Z');
const win = (question) => resolveWindow(question, NOW);

const lastSql = (pg) => pg.queries[pg.queries.length - 1].sql;

// ── metric definitions ─────────────────────────────────────────────────────

describe('metricDefinitions — approved revenue semantics', () => {
  it('counts CONFIRMED and COMPLETED as revenue', () => {
    expect(REVENUE_STATUSES).toEqual(['CONFIRMED', 'COMPLETED']);
  });

  it('excludes simulated bookings from every revenue window', () => {
    // Seed bookings are excluded from EVERY window. Restricting it to all-time
    // made "revenue for the past month" (which contains the 2026-08-26 seed day)
    // report a figure that was 99.2% simulated while "past 30 days" did not.
    const { clauses } = revenueClauses();
    expect(clauses[0]).toMatch(/status" IN \('CONFIRMED','COMPLETED'\)/);
    expect(clauses.join(' ')).toMatch(/isSimulated" = false/);
  });

  it('never uses the digest revenue definition (which drops COMPLETED)', () => {
    const { clauses } = revenueClauses(resolveWindow('revenue this month', NOW));
    // dailyDigest filters status = 'CONFIRMED' alone, which made completed
    // revenue vanish from period totals. That must not reappear here.
    expect(clauses.join(' ')).not.toMatch(/status" = 'CONFIRMED' AND/);
    expect(clauses.join(' ')).toContain("'COMPLETED'");
  });

  it('reads top tours by paidAt, never createdAt', () => {
    expect(TOP_TOURS_DATE_COLUMN).toBe('paidAt');
  });

  it('defines customers as customer-role users', () => {
    expect(CUSTOMER_ROLE).toBe('customer');
  });
});

describe('metricDefinitions — window resolution', () => {
  it('defaults a question with no window to all time', () => {
    const w = resolveWindow('total revenue in usd', NOW);
    expect(w.isAllTime).toBe(true);
    expect(w.from).toBeNull();
    expect(describeWindow(w)).toBe('All time');
  });

  it('aligns calendar windows to UTC midnight', () => {
    expect(resolveWindow('yesterday', NOW).from).toEqual(utcDayStart(-1));
    expect(resolveWindow('this week', NOW).from).toEqual(utcWeekStart(NOW));
    expect(resolveWindow('this month', NOW).from).toEqual(utcMonthStart(NOW));
  });

  it('uses an exclusive end boundary', () => {
    const w = resolveWindow('yesterday', NOW);
    expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
    expect(w.to.getTime() - w.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // Approved window semantics are mixed: NAMED periods are calendar-anchored so
  // a quoted figure can be re-derived, but an explicit count is a ROLLING
  // duration ending now — "the last 30 days" is not a calendar month.
  it('reads "the past 7 days" as a rolling 7x24h ending now', () => {
    const w = resolveWindow('revenue for the past 7 days', NOW);
    expect(w.isAllTime).toBe(false);
    expect(w.to.toISOString()).toBe(NOW.toISOString());
    expect(w.from.toISOString()).toBe(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
  });

  it('reads "the past 2 weeks" as a rolling 14x24h', () => {
    const w = resolveWindow('revenue for the past 2 weeks', NOW);
    expect(w.to.toISOString()).toBe(NOW.toISOString());
    expect(w.to.getTime() - w.from.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('resolves "this week" to the calendar week, and "last week" to the one before', () => {
    // NOW is Tuesday 2026-09-29, so this week starts Monday 2026-09-28.
    const thisWeek = resolveWindow('revenue this week', NOW);
    expect(thisWeek.from.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(thisWeek.to.toISOString()).toBe('2026-09-30T00:00:00.000Z');

    const lastWeek = resolveWindow('revenue last week', NOW);
    expect(lastWeek.from.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(lastWeek.to.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(lastWeek.label).toBe('the previous week');
  });

  it('resolves calendar months, quarters and years', () => {
    expect(resolveWindow('revenue this month', NOW).from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(resolveWindow('revenue last month', NOW).from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(resolveWindow('revenue last month', NOW).to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(resolveWindow('revenue this quarter', NOW).from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(resolveWindow('revenue this year', NOW).from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(resolveWindow('revenue last year', NOW).from.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('honours the injected reference date rather than the wall clock', () => {
    // Guards the bug where resolveWindow accepted `now` and ignored it, so
    // every window silently resolved against the real current date.
    const w = resolveWindow('revenue today', new Date('2020-03-15T23:00:00Z'));
    expect(w.from.toISOString()).toBe('2020-03-15T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2020-03-16T00:00:00.000Z');
  });

  it('formats money, and does not label a non-USD total as dollars', () => {
    expect(money(1234.5)).toBe('$1234.50');
    expect(money(null)).toBe('$0.00');
    expect(money(50, 'GHS')).toBe('GHS 50.00');
  });
});

// ── fact router ────────────────────────────────────────────────────────────

describe('factRouter — claims only what it can answer correctly', () => {
  it('routes common business questions', () => {
    const cases = [
      ['whats the revenue for the past month', 'revenue'],
      ['total revenue in usd', 'revenue'],
      ['how many tours are live right now', 'tours'],
      ['how many new signups this week', 'signups'],
      ['how many active suppliers do we have', 'suppliers'],
      ['how many new suppliers signed up this month', 'suppliers'],
      ['what are the top tours by revenue this month', 'topTours'],
      ['how many refunds did we issue this week', 'refunds'],
      ['how many disputes are open right now', 'disputes'],
      ['how many payouts are pending this week', 'payouts'],
      ['what is the average review rating this week', 'reviews'],
      ['how many customers do we have in total', 'customers'],
      ['how many users do we have', 'users'],
      ['how many customers have booked', 'bookingCustomers'],
    ];
    for (const [q, want] of cases) {
      const r = routeToFact(q, { now: NOW });
      expect(r ? r.metric : null).toBe(want);
    }
  });

  it('never answers a ranking with the underlying total or count', () => {
    // "top 3 tours" otherwise matches only the generic `tours` rule and is
    // answered with the platform-wide tour total — a confident wrong answer.
    // All of these must fall through to the SQL agent, which can rank properly.
    expect(routeToFact('show me the top 3 tours', { now: NOW })).toBeNull();
    expect(routeToFact('which is our most booked experience', { now: NOW })).toBeNull();
    expect(routeToFact('what is our top selling supplier this month', { now: NOW })).toBeNull();
    expect(routeToFact('highest earning customer', { now: NOW })).toBeNull();
    // Entity-agnostic "top selling" must not be ranked as tours either.
    expect(routeToFact('who are our best selling partners', { now: NOW })).toBeNull();
  });

  it('routes an explicit-count revenue ranking of tours with that count', () => {
    const ten = routeToFact('top 10 tours by revenue this month', { now: NOW });
    expect(ten.metric).toBe('topTours');
    expect(ten.topToursLimit).toBe(10);

    const three = routeToFact('top 3 tours by revenue', { now: NOW });
    expect(three.metric).toBe('topTours');
    expect(three.topToursLimit).toBe(3);

    // No stated count -> the layer's default, not a guess.
    const dflt = routeToFact('what are the top tours by revenue this month', { now: NOW });
    expect(dflt.metric).toBe('topTours');
    expect(dflt.topToursLimit).toBeNull();
  });

  it('declines context-dependent questions', () => {
    // These are the two real conversational questions from production logs.
    expect(routeToFact('In usd', { now: NOW })).toBeNull();
    expect(routeToFact('I want details on the 4 bookings', { now: NOW })).toBeNull();
    expect(routeToFact('what about those bookings', { now: NOW })).toBeNull();
    expect(routeToFact('show me those tours again', { now: NOW })).toBeNull();
  });

  it('declines analytical questions even with a metric keyword', () => {
    expect(routeToFact('why did bookings drop last week', { now: NOW })).toBeNull();
    expect(routeToFact('compare revenue this week to last week and explain the difference', { now: NOW })).toBeNull();
    expect(routeToFact('which supplier made the most money and why', { now: NOW })).toBeNull();
  });

  it('declines place-qualified questions (city vs region is not modelled)', () => {
    // Routing this to a global tour count would answer a different question.
    expect(routeToFact('how many tours are in Accra', { now: NOW })).toBeNull();
    expect(routeToFact('revenue in Ghana', { now: NOW })).toBeNull();
  });

  it('does not confuse a lowercase qualifier with a place', () => {
    // "in usd" is a currency, not a city.
    expect(routeToFact('total revenue in usd', { now: NOW }).metric).toBe('revenue');
    expect(routeToFact('bookings in the past 7 days', { now: NOW }).metric).toBe('bookings');
  });

  it('declines multi-metric and time-series questions', () => {
    expect(routeToFact('show me revenue and bookings for this week', { now: NOW })).toBeNull();
    expect(routeToFact('show me revenue by month for the last 6 months', { now: NOW })).toBeNull();
  });

  it('declines small talk and identity questions', () => {
    expect(routeToFact('hi', { now: NOW })).toBeNull();
    expect(routeToFact('who are you', { now: NOW })).toBeNull();
    expect(routeToFact('what is the new update', { now: NOW })).toBeNull();
  });

  it('extracts status filters deterministically', () => {
    expect(routeToFact('how many tours are live right now', { now: NOW }).statusFilter).toBe('ACTIVE');
    expect(routeToFact('how many active suppliers do we have', { now: NOW }).statusFilter).toBe('ACTIVE');
    expect(routeToFact('how many disputes are open right now', { now: NOW }).statusFilter).toBe('OPEN');
  });

  it('treats "new X" as a created-in-window count, not a status count', () => {
    const r = routeToFact('how many new signups this week', { now: NOW });
    expect(r.metric).toBe('signups');
    expect(r.windowedCount).toBe(true);
    expect(r.statusFilter).toBeNull();
  });

  it('keeps the three customer populations distinct', () => {
    const customers = routeToFact('how many customers do we have in total', { now: NOW });
    expect(customers.metric).toBe('customers');
    expect(customers.customerRole).toBe(CUSTOMER_ROLE);

    expect(routeToFact('how many users do we have', { now: NOW }).metric).toBe('users');
    expect(routeToFact('how many customers have booked', { now: NOW }).metric).toBe('bookingCustomers');
  });

  it('normalises currency words to ISO codes', () => {
    expect(routeToFact('total revenue in usd', { now: NOW }).currencyFilter).toBe('USD');
    expect(routeToFact('what is the revenue in gbp', { now: NOW }).currencyFilter).toBe('GBP');
    expect(routeToFact('revenue in ghana cedis', { now: NOW }).currencyFilter).toBe('GHS');
  });

  it('marks every routed question self-contained', () => {
    for (const q of ['total revenue in usd', 'how many tours are live', 'how many disputes are open right now']) {
      expect(routeToFact(q, { now: NOW }).selfContained).toBe(true);
    }
  });
});

describe('factRouter — feature gate defaults to OFF', () => {
  it('is off when AI_FACTS_ENABLED is unset', () => {
    expect(factsEnabled({})).toBe(false);
  });

  it('is off for every value that is not exactly "true"', () => {
    // A typo must only ever disable the new path, never enable it.
    for (const v of ['', 'false', '0', 'no', 'on', 'TRUE ', 'yes', '1']) {
      expect(factsEnabled({ AI_FACTS_ENABLED: v })).toBe(false);
    }
  });

  it('is on only for exactly "true" (case-insensitive)', () => {
    expect(factsEnabled({ AI_FACTS_ENABLED: 'true' })).toBe(true);
    expect(factsEnabled({ AI_FACTS_ENABLED: 'TRUE' })).toBe(true);
    expect(factsEnabled({ AI_FACTS_ENABLED: 'True' })).toBe(true);
  });
});

// ── fact queries ───────────────────────────────────────────────────────────

describe('businessFacts — revenue', () => {
  it('groups by currency and never sums across currencies', async () => {
    const pg = makePg([
      { currency: 'USD', bookings: 4, gross: '604.00' },
      { currency: 'GHS', bookings: 2, gross: '1200.00' },
    ]);
    const res = await getBusinessFacts('revenue', { window: win('revenue this week'), pg });
    expect(res.ok).toBe(true);
    expect(res.sql).toMatch(/GROUP BY "b"\."currency"/);
    expect(res.facts.currencyCount).toBe(2);
    // Two currencies stay two separate figures.
    expect(res.facts.byCurrency[0].grossFormatted).toBe('$604.00');
    expect(res.facts.byCurrency[1].grossFormatted).toBe('GHS 1200.00');
  });

  it('applies the approved statuses and reports the definition it used', async () => {
    const pg = makePg([]);
    const res = await getBusinessFacts('revenue', { window: win('revenue this week'), pg });
    expect(res.sql).toContain("'CONFIRMED','COMPLETED'");
    expect(res.definition).toMatch(/CONFIRMED, COMPLETED/);
  });

  it('excludes simulated bookings for an all-time question', async () => {
    const pg = makePg([]);
    await getBusinessFacts('revenue', { window: win('total revenue in usd'), pg });
    expect(lastSql(pg)).toMatch(/isSimulated" = false/);
  });

  it('excludes simulated bookings from a period question too', async () => {
    const pg = makePg([]);
    await getBusinessFacts('revenue', { window: win('revenue this week'), pg });
    expect(lastSql(pg)).toMatch(/isSimulated" = false/);
  });

  it('excludes simulated bookings from every Booking-derived metric', async () => {
    // A count that included seed rows beside a total that did not would be the
    // same incoherence the all-time/period split caused, in a new place.
    for (const [metric, question] of [
      ['revenue', 'revenue this week'],
      ['bookings', 'bookings this week'],
      ['bookingCustomers', 'how many customers have booked'],
      ['topTours', 'top tours by revenue this month'],
    ]) {
      const pg = makePg([]);
      const res = await getBusinessFacts(metric, { window: win(question), pg });
      expect(res.ok).toBe(true);
      expect(pg.queries[0].sql).toMatch(/isSimulated" = false/);
    }
  });

  it('applies no date bound for an all-time question', async () => {
    const pg = makePg([]);
    await getBusinessFacts('revenue', { window: win('total revenue in usd'), pg });
    expect(lastSql(pg)).not.toMatch(/createdAt" >= \$1/);
  });
});

describe('businessFacts — customers populations stay separate', () => {
  it('counts customer-role users for the customers metric', async () => {
    const pg = makePg([{ n: 52 }]);
    const res = await getBusinessFacts('customers', { window: win('how many customers do we have in total'), customerRole: CUSTOMER_ROLE, pg });
    expect(res.ok).toBe(true);
    expect(res.sql).toMatch(/"roles"/);
    expect(res.sql).toMatch(/customer/);
    expect(res.facts.n).toBe(52);
    expect(res.facts.population).toMatch(/customer/);
  });

  it('refuses the customers metric without an explicit role', async () => {
    const res = await getBusinessFacts('customers', { window: win('how many customers'), pg: makePg([]) });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/customer role/);
  });

  it('counts distinct booking customers for bookingCustomers', async () => {
    const pg = makePg([{ n: 26 }]);
    const res = await getBusinessFacts('bookingCustomers', { window: win('how many customers have booked'), pg });
    expect(res.sql).toMatch(/COUNT\(DISTINCT "customerId"\)/);
    expect(res.facts.n).toBe(26);
  });

  it('counts every row for the users metric', async () => {
    const pg = makePg([{ n: 91 }]);
    const res = await getBusinessFacts('users', { window: win('how many users do we have'), pg });
    expect(res.sql).toMatch(/COUNT\(\*\)::int AS n FROM "User"/);
    expect(res.facts.n).toBe(91);
  });
});

describe('businessFacts — top tours', () => {
  it('ranks by paidAt and never by createdAt', async () => {
    const pg = makePg([]);
    const res = await getBusinessFacts('topTours', { window: win('top tours by revenue this month'), pg });
    expect(res.sql).toMatch(/"b"\."paidAt"/);
    expect(res.sql).not.toMatch(/"b"\."createdAt"/);
    expect(res.definition).toMatch(/paidAt/);
  });

  it('uses the approved revenue statuses', async () => {
    const pg = makePg([]);
    const res = await getBusinessFacts('topTours', { window: win('top tours by revenue'), pg });
    expect(res.sql).toContain("'CONFIRMED','COMPLETED'");
  });

  it('orders by the numeric sum, never the text alias', async () => {
    // `gross` is COALESCE(...)::text. Ordering by that alias sorts
    // lexicographically, so "60" outranked "475" and the real top tour
    // ($1,335.60) was missing. The ordering key must be the numeric expression.
    const pg = makePg([]);
    const res = await getBusinessFacts('topTours', { window: win('top tours by revenue this month'), pg });
    expect(res.sql).toMatch(/ORDER BY COALESCE\(SUM\("b"\."total"\),0\) DESC/);
    expect(res.sql).not.toMatch(/ORDER BY gross/);
  });

  it('returns the default row count when no count is asked for', async () => {
    const pg = makePg([]);
    const res = await getBusinessFacts('topTours', { window: win('top tours by revenue this month'), pg });
    expect(res.sql).toMatch(/LIMIT 5$/);
    expect(res.facts.limit).toBe(5);
  });

  it('honours an explicit count up to the cap', async () => {
    const pg = makePg([]);
    const res = await getBusinessFacts('topTours', { window: win('top 10 tours by revenue'), topToursLimit: 10, pg });
    expect(res.sql).toMatch(/LIMIT 10$/);
    expect(res.facts.limit).toBe(10);
  });

  it('refuses a count it cannot serve instead of silently truncating it', async () => {
    const pg = makePg([]);
    const res = await getBusinessFacts('topTours', { window: win('top 15 tours by revenue'), topToursLimit: 15, pg });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/15/);
    expect(pg.queries).toHaveLength(0);
  });
});

describe('businessFacts — window and status handling', () => {
  it('applies the status filter in SQL rather than leaving it to narration', async () => {
    const pg = makePg([{ n: 32 }]);
    const res = await getBusinessFacts('tours', { window: win('how many tours are live right now'), statusFilter: 'ACTIVE', pg });
    expect(res.sql).toMatch(/"status"::text = \$1/);
    expect(res.facts.n).toBe(32);
  });

  it('counts rows created in the window for a "new X" question', async () => {
    const pg = makePg([{ n: 43 }]);
    const res = await getBusinessFacts('signups', { window: win('how many new signups this week'), windowedCount: true, pg });
    expect(res.sql).toMatch(/"createdAt" >= \$1/);
    expect(res.facts.newUsers).toBe(43);
  });

  it('returns an empty result set honestly when there is no data', async () => {
    const pg = makePg([]);
    const res = await getBusinessFacts('refunds', { window: win('how many refunds this week'), pg });
    expect(res.ok).toBe(true);
    expect(res.facts.byCurrency).toEqual([]);
  });

  it('reports a query error as a refusal, never as zero', async () => {
    const pg = {
      queries: [],
      async query() {
        throw new Error('relation "Booking" does not exist');
      },
    };
    const res = await getBusinessFacts('revenue', { window: win('revenue this week'), pg });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/does not exist/);
  });
});

describe('businessFacts — parameter numbering', () => {
  it('numbers every placeholder distinctly (Postgres rejects $1,$1)', async () => {
    const metrics = [
      ['revenue', 'revenue this week', { currencyFilter: 'USD' }],
      ['bookings', 'bookings this week', { statusFilter: 'CONFIRMED' }],
      ['tours', 'tours this week', { windowedCount: true }],
      ['suppliers', 'suppliers this month', { windowedCount: true }],
      ['signups', 'signups this week', {}],
      ['refunds', 'refunds this week', {}],
      ['disputes', 'disputes today', { statusFilter: 'OPEN' }],
      ['payouts', 'payouts this week', { statusFilter: 'PENDING' }],
      ['reviews', 'reviews this week', {}],
      ['topTours', 'top tours this month', { currencyFilter: 'USD' }],
    ];
    for (const [metric, question, extra] of metrics) {
      const pg = makeStrictPg([]);
      const res = await getBusinessFacts(metric, { window: win(question), pg, ...extra });
      // If a placeholder were unreferenced, makeStrictPg would have thrown and
      // the result would be a refusal.
      expect(res.ok).toBe(true);
      const q = pg.queries[0];
      const used = [...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

      // Postgres requires placeholders to be $1..$N with no gaps and no
      // repeats. A repeat ($1,$1) is unreferenced-parameter territory; a gap
      // means a bound value has no placeholder at all. Both fail at runtime.
      const expected = Array.from({ length: q.params.length }, (_, i) => i + 1);
      expect(used).toEqual(expected);
    }
  });
});

describe('businessFacts — currency gate', () => {
  it('refuses a question about a currency the data does not contain', async () => {
    const question = 'what is the revenue in gbp';
    const route = routeToFact(question, { now: NOW });
    const pg = makePg([{ currency: 'USD', bookings: 4, gross: '604.00' }]);
    const res = await getBusinessFacts(route.metric, { window: route.window, currencyFilter: route.currencyFilter, pg });
    const gate = currencyIsSatisfied(route, res);
    // The whole point: do NOT answer a GBP question with USD numbers.
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/GBP/);
  });

  it('passes the gate when the requested currency is present', async () => {
    const route = routeToFact('total revenue in usd', { now: NOW });
    const pg = makePg([{ currency: 'USD', bookings: 116, gross: '17067.42' }]);
    const res = await getBusinessFacts(route.metric, { window: route.window, currencyFilter: route.currencyFilter, pg });
    expect(currencyIsSatisfied(route, res).ok).toBe(true);
  });

  it('refuses when the query returned nothing in any currency', async () => {
    const route = routeToFact('what is the revenue in gbp', { now: NOW });
    const res = await getBusinessFacts(route.metric, { window: route.window, currencyFilter: route.currencyFilter, pg: makePg([]) });
    expect(currencyIsSatisfied(route, res).ok).toBe(false);
  });

  it('is a no-op when the question named no currency', async () => {
    const route = routeToFact('revenue this week', { now: NOW });
    const res = await getBusinessFacts('revenue', { window: route.window, pg: makePg([]) });
    expect(currencyIsSatisfied(route, res).ok).toBe(true);
  });
});

// ── narration contract ─────────────────────────────────────────────────────

describe('businessFacts — narration payload', () => {
  it('hands the model the window, definition and facts, and nothing to invent from', async () => {
    const pg = makePg([{ currency: 'USD', bookings: 4, gross: '604.00' }]);
    const res = await getBusinessFacts('revenue', { window: win('revenue this week'), pg });
    const payload = buildNarrationPayload('revenue this week', res);
    expect(payload.window).toBe('This week');
    expect(payload.definition).toMatch(/CONFIRMED, COMPLETED/);
    expect(payload.facts.byCurrency[0].gross).toBe(604);
  });

  it('requires the narration to state the window explicitly', () => {
    expect(FACT_NARRATE_SYSTEM).toMatch(/name the time window/i);
    expect(FACT_NARRATE_SYSTEM).toMatch(/All time/);
  });

  it('forbids inventing numbers and summing across currencies', () => {
    expect(FACT_NARRATE_SYSTEM).toMatch(/Never invent/);
    expect(FACT_NARRATE_SYSTEM).toMatch(/NEVER sum across currencies/);
  });
});

describe('factIntegrity', () => {
  it('accepts a well-formed payload', () => {
    expect(factIntegrity({ byCurrency: [{ currency: 'USD', bookings: 1, gross: 2 }] })).toEqual([]);
  });

  it('flags an empty row object (the Phase 0 silent-wrong-answer bug)', () => {
    const problems = factIntegrity({ rows: [{}] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/empty object/);
  });

  it('flags an explicitly undefined field', () => {
    const problems = factIntegrity({ n: undefined });
    expect(problems[0]).toMatch(/undefined/);
  });

  it('allows an empty array — genuinely no rows is valid', () => {
    expect(factIntegrity({ byCurrency: [] })).toEqual([]);
  });
});

describe('businessFacts — a missing column must never read as a zero', () => {
  // pg returns rows keyed by column NAME. A SELECT with no alias (or a wrong
  // one) yields `undefined` for that field rather than throwing, so the danger
  // is not a crash — it is a confident "$0.00" / "no revenue". These pin the
  // conversion that stands between a mis-aliased column and the narration.
  it('surfaces an unaliased gross as undefined, which factIntegrity rejects', async () => {
    // The row has no `gross` key at all, as if the SQL said SUM("total") with
    // no AS alias.
    const pg = { async query() { return { rows: [{ currency: 'USD', bookings: 4 }] }; } };
    const res = await getBusinessFacts('revenue', { window: resolveWindow('total revenue', NOW), pg });
    expect(res.ok).toBe(true);
    expect(res.facts.byCurrency[0].gross).toBeUndefined();
    expect(res.facts.byCurrency[0].grossFormatted).toBeNull();
    expect(factIntegrity(res.facts).length).toBeGreaterThan(0);
  });

  it('still treats a genuine SQL NULL as null, not as a refusal', async () => {
    const pg = { async query() { return { rows: [{ currency: 'USD', bookings: 0, gross: null }] }; } };
    const res = await getBusinessFacts('revenue', { window: resolveWindow('total revenue', NOW), pg });
    expect(res.facts.byCurrency[0].gross).toBeNull();
    expect(res.facts.byCurrency[0].grossFormatted).toBe('$0.00');
    expect(factIntegrity(res.facts)).toEqual([]);
  });

  it('never formats an undefined amount as dollars', () => {
    expect(money(undefined)).toBeNull();
    expect(money(NaN)).toBeNull();
    // A real zero is still a zero.
    expect(money(0)).toBe('$0.00');
    expect(money('604.00')).toBe('$604.00');
  });
});

// ── answerBusinessFact: the one pipeline production and the replay share ───
//
// This function is what queryAgent.answerQuestion calls and what
// scripts/replayBot.js measures. Its refusals are the safety property of the
// whole layer, so each gate is pinned here rather than only at the SQL step.

describe('answerBusinessFact — refusals, and the one success shape', () => {
  const revenueRows = [{ currency: 'USD', bookings: 4, gross: '604.00' }];
  const noModel = () => {
    throw new Error('the model must not be called');
  };

  it('declines without touching the database when the router does not claim', async () => {
    const pg = makePg(revenueRows);
    const r = await answerBusinessFact({ question: 'why did bookings drop last week', pg, callMimo: noModel });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('route');
    expect(r.route).toBeNull();
    expect(pg.queries).toHaveLength(0);
  });

  it('answers with the narrated text, the SQL and the facts', async () => {
    const pg = makePg(revenueRows);
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg,
      now: NOW,
      callMimo: async () => 'Revenue this week was **$604.00** across 4 bookings.',
    });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('answered');
    expect(r.route.metric).toBe('revenue');
    expect(r.answer).toMatch(/\$604\.00/);
    expect(r.sql).toMatch(/FROM "Booking"/);
    expect(r.facts.byCurrency[0].gross).toBe(604);
    expect(r.sqlMs).toBeGreaterThanOrEqual(0);
    expect(r.narrMs).toBeGreaterThanOrEqual(0);
  });

  it('narrates under the constrained prompt with the definition attached', async () => {
    let seen = null;
    await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async (opts) => {
        seen = opts;
        return 'ok';
      },
    });
    expect(seen.messages[0].content).toBe(FACT_NARRATE_SYSTEM);
    expect(seen.maxTokens).toBe(NARRATE_MAX_TOKENS);
    // The narration payload must carry the filter definition, so the model
    // cannot restate "revenue" differently from the way it was computed.
    const payload = JSON.parse(seen.messages[1].content);
    expect(payload.definition).toMatch(/CONFIRMED/);
    expect(payload.window).toBeTruthy();
    expect(payload.facts.byCurrency[0].gross).toBe(604);
  });

  it('honours the injectable clock', async () => {
    const pg = makePg(revenueRows);
    const r = await answerBusinessFact({
      question: 'revenue in the past 7 days',
      pg,
      now: NOW,
      callMimo: async () => 'ok',
    });
    // Rolling window ends at the reference instant, not at wall-clock now.
    expect(r.sql).toMatch(/\$1/);
    expect(r.route.window.to.toISOString()).toBe(NOW.toISOString());
  });

  it('refuses a currency the data does not contain', async () => {
    const r = await answerBusinessFact({
      question: 'what is the revenue in gbp',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: noModel,
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('currency');
    expect(r.reason).toMatch(/GBP/);
  });

  it('refuses to narrate a fact with an undefined field', async () => {
    // No `gross` key at all — what a SELECT missing its AS alias produces.
    const pg = makePg([{ currency: 'USD', bookings: 4 }]);
    const r = await answerBusinessFact({ question: 'total revenue this week', pg, now: NOW, callMimo: noModel });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('integrity');
    expect(r.integrity.problems.length).toBeGreaterThan(0);
  });

  it('maps a query error to a refusal, not to zero revenue', async () => {
    const pg = { async query() { throw new Error('relation "Booking" does not exist'); } };
    const r = await answerBusinessFact({ question: 'total revenue this week', pg, now: NOW, callMimo: noModel });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('query');
    expect(r.reason).toMatch(/does not exist/);
  });

  it('refuses when the model fails, so the caller falls back to the SQL agent', async () => {
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async () => { throw new Error('model unavailable'); },
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('narrate');
    expect(r.answer).toBeNull();
    expect(r.reason).toMatch(/model unavailable/);
  });

  it('refuses an empty narration instead of reporting an answered question', async () => {
    const r = await answerBusinessFact({ question: 'total revenue this week', pg: makePg(revenueRows), now: NOW, callMimo: async () => '   ' });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('narrate');
    expect(r.reason).toMatch(/empty/);
  });

  it('passes an explicit top-N count through to the ranking query', async () => {
    const pg = makePg([]);
    const r = await answerBusinessFact({
      question: 'top 3 tours by revenue',
      pg,
      now: NOW,
      callMimo: async () => 'ok',
    });
    expect(r.ok).toBe(true);
    expect(r.route.topToursLimit).toBe(3);
    expect(r.sql).toMatch(/LIMIT 3\b/);
  });

  it('never throws, whatever the inputs are', async () => {
    await expect(answerBusinessFact({ question: '', pg: makePg([]), callMimo: noModel })).resolves.toMatchObject({ ok: false, stage: 'route' });
  });
});
