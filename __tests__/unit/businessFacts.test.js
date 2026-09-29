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

const { routeToFact, factsEnabled, factsCacheEnabled, factsTemplateEnabled } = require('../../bots/discord-bot/factRouter');
const {
  getBusinessFacts,
  answerBusinessFact,
  currencyIsSatisfied,
  buildNarrationPayload,
  factIntegrity,
  renderReviewedTemplate,
  factCacheKey,
  clearFactCache,
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

// ── "past" is rolling, "last" is calendar ─────────────────────────────────
//
// These two were previously the SAME regex, so "whats the revenue for the past
// month" — a real question from the production logs — resolved to the previous
// calendar month and reported $90.89 where the operator meant the last 30 days
// ($4,995.14). A 55x divergence from one word. Both reads are defensible; only
// one matches how an operator speaks, so the split is pinned here.
describe('metricDefinitions — "past" is rolling, "last" is calendar', () => {
  it('reads the real production question "whats the revenue for the past month" as rolling 30 days', () => {
    const w = resolveWindow('whats the revenue for the past month', NOW);
    expect(w.isAllTime).toBe(false);
    expect(w.to.toISOString()).toBe(NOW.toISOString());
    expect(w.from.toISOString()).toBe(new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
    // ...and crucially NOT the previous calendar month (2026-08-01).
    expect(w.from.toISOString()).not.toBe('2026-08-01T00:00:00.000Z');
    expect(w.label).toContain('rolling 30 days');
  });

  it('reads the real production question "how about the total revenue for the past week" as rolling 7 days', () => {
    const w = resolveWindow('how about the total revenue for the past week', NOW);
    expect(w.to.toISOString()).toBe(NOW.toISOString());
    expect(w.from.toISOString()).toBe(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
    // Not the previous calendar week (Mon 2026-09-21).
    expect(w.from.toISOString()).not.toBe('2026-09-21T00:00:00.000Z');
    expect(w.label).toContain('rolling 7 days');
  });

  it('reads past quarter and past year as rolling 90 and 365 days', () => {
    const q = resolveWindow('revenue past quarter', NOW);
    expect(q.to.toISOString()).toBe(NOW.toISOString());
    expect(q.from.toISOString()).toBe(new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString());

    const y = resolveWindow('revenue past year', NOW);
    expect(y.to.toISOString()).toBe(NOW.toISOString());
    expect(y.from.toISOString()).toBe(new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString());
  });

  it('keeps "last X" calendar-anchored to UTC midnight', () => {
    expect(resolveWindow('revenue last week', NOW).from.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(resolveWindow('revenue last month', NOW).from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(resolveWindow('revenue last quarter', NOW).from.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(resolveWindow('revenue last year', NOW).from.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    // Calendar windows end at a midnight, never at the reference instant.
    expect(resolveWindow('revenue last month', NOW).to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps "this X" as the calendar period in progress', () => {
    expect(resolveWindow('revenue this month', NOW).from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(resolveWindow('revenue this quarter', NOW).from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(resolveWindow('revenue this week', NOW).from.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('still reads an explicit numeral as rolling, whichever preposition it carries', () => {
    // "last 30 days" is an explicit count, not a calendar month.
    expect(resolveWindow('revenue last 30 days', NOW).to.toISOString()).toBe(NOW.toISOString());
    expect(resolveWindow('revenue last 30 days', NOW).from.toISOString())
      .toBe(new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
    expect(resolveWindow('revenue last 3 days', NOW).from.toISOString())
      .toBe(new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString());
    expect(resolveWindow('revenue last 2 weeks', NOW).from.toISOString())
      .toBe(new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString());
  });

  it('never lets a rolling window end at a value other than the reference instant', () => {
    for (const phrase of ['past week', 'past month', 'past quarter', 'past year', 'past 7 days', 'past 30 days']) {
      expect(resolveWindow(`revenue ${phrase}`, NOW).to.toISOString()).toBe(NOW.toISOString());
    }
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

// ── Phase 3 ────────────────────────────────────────────────────────────────
//
// The shared cache and the reviewed template ship on SEPARATE gates because
// they are separate risks: serving a stale number and answering when the model
// is down have different blast radii, and an operator must be able to turn
// one off without losing the other. Both default OFF, so the first two tests
// in each block below pin the shipped behaviour — Phase 2, unchanged.

describe('Phase 3 — shared answer cache (AI_FACTS_CACHE_ENABLED)', () => {
  const revenueRows = [{ currency: 'USD', bookings: 4, gross: '604.00' }];
  const countedModel = () => {
    let calls = 0;
    return {
      get calls() { return calls; },
      callMimo: async () => { calls += 1; return 'narrated'; },
    };
  };

  beforeEach(() => clearFactCache());

  it('is off unless the flag is exactly "true"', () => {
    // A typo can only disable the cache, never enable it.
    expect(factsCacheEnabled({})).toBe(false);
    expect(factsCacheEnabled({ AI_FACTS_CACHE_ENABLED: '' })).toBe(false);
    expect(factsCacheEnabled({ AI_FACTS_CACHE_ENABLED: 'false' })).toBe(false);
    expect(factsCacheEnabled({ AI_FACTS_CACHE_ENABLED: '1' })).toBe(false);
    expect(factsCacheEnabled({ AI_FACTS_CACHE_ENABLED: 'yes' })).toBe(false);
    expect(factsCacheEnabled({ AI_FACTS_CACHE_ENABLED: 'true' })).toBe(true);
    expect(factsCacheEnabled({ AI_FACTS_CACHE_ENABLED: 'TRUE' })).toBe(true);
  });

  it('does not cache at all when the flag is unset (the shipped default)', async () => {
    const m = countedModel();
    await answerBusinessFact({ question: 'total revenue this week', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo });
    const pg = makePg(revenueRows);
    const again = await answerBusinessFact({ question: 'total revenue this week', pg, now: NOW, callMimo: m.callMimo });
    expect(m.calls).toBe(2);
    expect(pg.queries).toHaveLength(1);
    expect(again.cacheHit).toBe(false);
  });

  it('keys on the ROUTE, not on the wording of the question', () => {
    const k = (q) => factCacheKey(routeToFact(q, { now: NOW }));
    // Same metric + window + filters, different wording → one entry.
    expect(k('whats the revenue for the past month')).toBe(k('show revenue by currency for the past month'));
    // Anything that changes the numbers changes the key.
    expect(k('revenue in gbp for the past month')).not.toBe(k('whats the revenue for the past month'));
    expect(k('top 3 tours by revenue this month')).not.toBe(k('top tours by revenue this month'));
    expect(k('total revenue this week')).not.toBe(k('total revenue this month'));
    expect(k('total revenue this week')).not.toBe(k('total revenue last month'));
    expect(k('how many customers do we have in total')).not.toBe(k('total revenue this week'));
    expect(factCacheKey(routeToFact('why did bookings drop last week', { now: NOW }))).toBeNull();
  });

  it('answers a differently worded question with the same route from cache, doing no work', async () => {
    const m = countedModel();
    const first = await answerBusinessFact({
      question: 'whats the revenue for the past month',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: m.callMimo,
      cache: true,
    });
    expect(first.ok).toBe(true);
    expect(first.cacheHit).toBe(false);
    expect(m.calls).toBe(1);

    const pg = makePg(revenueRows);
    const second = await answerBusinessFact({
      question: 'show revenue by currency for the past month',
      pg,
      now: NOW,
      callMimo: m.callMimo,
      cache: true,
    });
    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(m.calls).toBe(1);              // no second narration
    expect(pg.queries).toHaveLength(0);   // no second query
    expect(second.answer).toBe(first.answer);
    // The audit trail survives a hit: the SQL that produced it is still there.
    expect(second.sql).toBe(first.sql);
    expect(second.facts).toEqual(first.facts);
    expect(second.narrMs).toBe(0);
    expect(second.sqlMs).toBe(0);
  });

  it('never shares an answer across routes whose numbers differ', async () => {
    const m = countedModel();
    await answerBusinessFact({ question: 'total revenue this week', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo, cache: true });
    await answerBusinessFact({ question: 'total revenue this month', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo, cache: true });
    await answerBusinessFact({ question: 'how many customers do we have in total', pg: makePg([{ n: 52 }]), now: NOW, callMimo: m.callMimo, cache: true });

    // "revenue in gbp" against USD data must still reach the currency gate —
    // a cached USD entry must never answer it.
    const gbp = await answerBusinessFact({ question: 'revenue in gbp for the past month', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo, cache: true });
    expect(gbp.ok).toBe(false);
    expect(gbp.stage).toBe('currency');

    expect(m.calls).toBe(3); // three distinct routes narrated, one refused
  });

  it('never caches a refusal, so the next ask retries instead of pinning a failure', async () => {
    const m = countedModel();
    const refused = await answerBusinessFact({ question: 'revenue in gbp for the past month', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo, cache: true });
    expect(refused.ok).toBe(false);
    expect(refused.stage).toBe('currency');

    // The data now HAS gbp. If the refusal had been stored this would answer
    // from it and still say "no gbp data".
    const pg = makePg([{ currency: 'GBP', bookings: 2, gross: '100.00' }]);
    const retried = await answerBusinessFact({ question: 'revenue in gbp for the past month', pg, now: NOW, callMimo: m.callMimo, cache: true });
    expect(pg.queries.length).toBeGreaterThan(0);
    expect(retried.ok).toBe(true);
    expect(retried.cacheHit).toBe(false);
    expect(m.calls).toBe(1);
  });

  it('shares ONE in-flight narration between two simultaneous askers', async () => {
    const pg = makePg(revenueRows);
    let calls = 0;
    const callMimo = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return 'narrated';
    };

    const [a, b] = await Promise.all([
      answerBusinessFact({ question: 'total revenue this week', pg, now: NOW, callMimo, cache: true }),
      answerBusinessFact({ question: 'total revenue this week', pg, now: NOW, callMimo, cache: true }),
    ]);

    expect(calls).toBe(1);
    expect(pg.queries).toHaveLength(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.answer).toBe(b.answer);
    // Exactly one of them did the work; the other waited on it.
    expect([a.cacheHit, b.cacheHit].filter(Boolean)).toHaveLength(1);
  });

  it('expires an entry instead of serving it forever', async () => {
    const m = countedModel();
    await answerBusinessFact({ question: 'total revenue this week', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo, cache: true, cacheTtlMs: -1 });
    const pg = makePg(revenueRows);
    const again = await answerBusinessFact({ question: 'total revenue this week', pg, now: NOW, callMimo: m.callMimo, cache: true });
    expect(again.cacheHit).toBe(false);
    expect(pg.queries.length).toBeGreaterThan(0);
    expect(m.calls).toBe(2);
  });

  it('honours the env flag when the caller passes no override', async () => {
    const prev = process.env.AI_FACTS_CACHE_ENABLED;
    process.env.AI_FACTS_CACHE_ENABLED = 'true';
    clearFactCache();
    try {
      const m = countedModel();
      await answerBusinessFact({ question: 'total revenue this week', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo });
      const again = await answerBusinessFact({ question: 'total revenue this week', pg: makePg(revenueRows), now: NOW, callMimo: m.callMimo });
      expect(m.calls).toBe(1);
      expect(again.cacheHit).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AI_FACTS_CACHE_ENABLED;
      else process.env.AI_FACTS_CACHE_ENABLED = prev;
      clearFactCache();
    }
  });
});

describe('Phase 3 — reviewed template fallback (AI_FACTS_TEMPLATE_ENABLED)', () => {
  const revenueRows = [{ currency: 'USD', bookings: 4, gross: '604.00' }];

  it('is off unless the flag is exactly "true"', () => {
    expect(factsTemplateEnabled({})).toBe(false);
    expect(factsTemplateEnabled({ AI_FACTS_TEMPLATE_ENABLED: 'false' })).toBe(false);
    expect(factsTemplateEnabled({ AI_FACTS_TEMPLATE_ENABLED: 'yes' })).toBe(false);
    expect(factsTemplateEnabled({ AI_FACTS_TEMPLATE_ENABLED: 'true' })).toBe(true);
  });

  it('keeps Phase 2 behaviour when off: a failed narration still falls through', async () => {
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async () => { throw new Error('model unavailable'); },
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('narrate');
    expect(r.answer).toBeNull();
    expect(r.narrFallback).toBeNull();
  });

  it('answers from the reviewed template when the narration call fails', async () => {
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async () => { throw new Error('model unavailable'); },
      renderTemplate: renderReviewedTemplate,
    });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('answered');
    expect(r.narrFallback).toBe('template');
    expect(r.narrError).toMatch(/model unavailable/);
    expect(r.answer).toMatch(/\$604\.00 USD/);
    expect(r.answer).toMatch(/4 bookings/);
    expect(r.answer).toMatch(/This week/);
    expect(r.answer).toMatch(/Definition: revenue/);
  });

  it('answers from the template when the narration comes back empty', async () => {
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async () => '   ',
      renderTemplate: renderReviewedTemplate,
    });
    expect(r.ok).toBe(true);
    expect(r.narrFallback).toBe('template');
    expect(r.narrError).toMatch(/empty/);
  });

  it('never replaces a successful narration with template text', async () => {
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async () => 'MiMo wrote this sentence.',
      renderTemplate: renderReviewedTemplate,
    });
    expect(r.answer).toBe('MiMo wrote this sentence.');
    expect(r.narrFallback).toBeNull();
    expect(r.narrError).toBeNull();
  });

  it('still refuses when the template cannot render the fact shape', async () => {
    // The template is a fallback, never a second guess: an unrecognised shape
    // degrades to exactly the behaviour Phase 2 shipped with.
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async () => { throw new Error('model unavailable'); },
      renderTemplate: () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('narrate');
    expect(r.answer).toBeNull();
  });

  it('treats a throwing renderer as a refusal, not as an exception', async () => {
    // The pipeline is documented as never throwing, and a rejected promise
    // would strand every single-flight waiter behind it.
    const r = await answerBusinessFact({
      question: 'total revenue this week',
      pg: makePg(revenueRows),
      now: NOW,
      callMimo: async () => { throw new Error('model unavailable'); },
      renderTemplate: () => { throw new Error('renderer bug'); },
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('narrate');
    expect(r.reason).toMatch(/model unavailable/);
  });

  it('honours the env flag when the caller passes no override', async () => {
    const prev = process.env.AI_FACTS_TEMPLATE_ENABLED;
    process.env.AI_FACTS_TEMPLATE_ENABLED = 'true';
    try {
      const r = await answerBusinessFact({
        question: 'total revenue this week',
        pg: makePg(revenueRows),
        now: NOW,
        callMimo: async () => { throw new Error('model unavailable'); },
      });
      expect(r.ok).toBe(true);
      expect(r.narrFallback).toBe('template');
    } finally {
      if (prev === undefined) delete process.env.AI_FACTS_TEMPLATE_ENABLED;
      else process.env.AI_FACTS_TEMPLATE_ENABLED = prev;
    }
  });
});

describe('renderReviewedTemplate — prints only what it was given', () => {
  const revFact = (facts) => ({
    ok: true,
    metric: 'revenue',
    window: 'The past month (rolling 30 days)',
    definition: 'revenue = status IN (CONFIRMED, COMPLETED) and isSimulated = false',
    facts,
  });

  it('states the window, keeps currencies apart and never invents a number', () => {
    const out = renderReviewedTemplate(null, revFact({
      currencyCount: 2,
      byCurrency: [
        { currency: 'USD', bookings: 28, gross: 4995.14 },
        { currency: 'GHS', bookings: 1, gross: 50 },
      ],
    }));
    expect(out).toContain('The past month (rolling 30 days)');
    expect(out).toContain('$4995.14 USD from 28 bookings');
    expect(out).toContain('GHS 50.00 from 1 booking');
    expect(out).toContain('Definition: revenue = status IN (CONFIRMED, COMPLETED) and isSimulated = false.');
    // 4995.14 + 50 = 5045.14 — summing across currencies is the one thing the
    // currency-grouping rule exists to prevent.
    expect(out).not.toContain('5045.14');
  });

  it('renders an empty result as an empty result, not as a figure', () => {
    const out = renderReviewedTemplate(null, revFact({ currencyCount: 0, byCurrency: [] }));
    expect(out).toContain('there were no qualifying bookings');
    expect(out).not.toMatch(/\$\d/);
  });

  it('refuses when a figure is missing rather than printing a guess', () => {
    // No gross at all — what a SELECT that forgot its AS alias produces.
    expect(renderReviewedTemplate(null, revFact({
      currencyCount: 1, byCurrency: [{ currency: 'USD', bookings: 4 }],
    }))).toBeNull();
    // No currency: must not let money() default to "$".
    expect(renderReviewedTemplate(null, revFact({
      byCurrency: [{ bookings: 4, gross: 10 }],
    }))).toBeNull();
    expect(renderReviewedTemplate(null, revFact({ byCurrency: 'not-an-array' }))).toBeNull();
    expect(renderReviewedTemplate(null, { ok: true, metric: 'revenue', window: 'All time' })).toBeNull();
    expect(renderReviewedTemplate(null, null)).toBeNull();
  });

  it('refuses an unknown metric instead of guessing at its wording', () => {
    expect(renderReviewedTemplate(
      { metric: 'brandNewMetric' },
      { ok: true, metric: 'brandNewMetric', window: 'All time', facts: { n: 3 } },
    )).toBeNull();
  });

  it('spells out which customer population it counted (52 vs 26 vs 91)', () => {
    const pop = (metric, n, population) => renderReviewedTemplate(null, {
      ok: true, metric, window: 'Current snapshot', facts: { n, population },
    });
    expect(pop('customers', 52, "users with the 'customer' role")).toContain("52 (users with the 'customer' role)");
    expect(pop('bookingCustomers', 26, 'distinct booking customers')).toContain('26 (distinct booking customers)');
    expect(pop('users', 91, 'all users')).toContain('91 (all users)');
  });

  it('renders an average without rounding it', () => {
    const reviews = (count, avg) => renderReviewedTemplate(null, {
      ok: true, metric: 'reviews', window: 'This week', facts: { count, avg },
    });
    // num() normalized AVG(... )::text to a JS number when the row was read, so
    // the padded "4.5000000000000000" arrives as 4.5 and prints as "4.5".
    expect(reviews(7, 4.5)).toContain('average rating 4.5 from 7 reviews');
    // A JS number prints shortest-round-trip, so nothing here is rounded to
    // 4.67 or 4.7 — FACT_NARRATE_SYSTEM forbids it.
    expect(reviews(7, 4.666666666666667)).toContain('average rating 4.666666666666667');
    expect(reviews(7, 4)).toContain('average rating 4 from 7 reviews');
    expect(reviews(0, null)).toContain('there were no reviews');
    // A non-zero count with no average cannot be rendered at all.
    expect(reviews(7, null)).toBeNull();
    // A raw string means the column was never normalized — refuse rather than
    // print whatever a mis-aliased column happened to hold.
    expect(reviews(7, '4.5')).toBeNull();
  });

  it('ranks tours in the order given, and says so when there are none', () => {
    const out = renderReviewedTemplate(null, {
      ok: true,
      metric: 'topTours',
      window: 'This month',
      definition: 'top tours by revenue using paidAt (when payment was taken)',
      facts: {
        dateColumn: 'paidAt',
        limit: 3,
        rows: [
          { title: 'Cape Coast Day Trip', city: 'Cape Coast', currency: 'USD', bookings: 9, gross: 1335.6 },
          { title: 'Kakum Walk', city: 'Accra', currency: 'USD', bookings: 4, gross: 392 },
        ],
      },
    });
    expect(out).toContain('top 2 tours by revenue');
    expect(out.indexOf('Cape Coast Day Trip')).toBeLessThan(out.indexOf('Kakum Walk'));
    expect(out).toContain('1. Cape Coast Day Trip (Cape Coast) — $1335.60 USD from 9 bookings');
    expect(out).toContain('paidAt');
    expect(renderReviewedTemplate(null, {
      ok: true, metric: 'topTours', window: 'This month', facts: { rows: [] },
    })).toContain('no tour had any qualifying revenue');
  });

  it('renders the three-shape metrics (tours/suppliers/disputes) by shape', () => {
    const three = (metric, facts) => renderReviewedTemplate(null, {
      ok: true, metric, window: 'Current snapshot', facts,
    });
    expect(three('tours', { n: 32, status: 'ACTIVE' })).toContain('32 tours with status ACTIVE');
    expect(three('suppliers', { n: 42, status: 'ACTIVE' })).toContain('42 supplier profiles with status ACTIVE');
    expect(three('disputes', { rows: [{ status: 'OPEN', n: 2 }, { status: 'WON', n: 1 }] }))
      .toContain('OPEN: 2; WON: 1');
    expect(three('tours', { created: 3 })).toContain('3 tours were created');
    expect(three('tours', { created: 1 })).toContain('1 tour was created');
    expect(three('tours', { unexpected: true })).toBeNull();
  });

  it('renders a scalar count, singular and plural, and refuses a non-number', () => {
    const signups = (facts) => renderReviewedTemplate(null, {
      ok: true, metric: 'signups', window: 'This week', facts,
    });
    expect(signups({ newUsers: 4 })).toContain('4 new user accounts were created');
    expect(signups({ newUsers: 1 })).toContain('1 new user account was created');
    expect(signups({ newUsers: 'four' })).toBeNull();
    expect(signups({})).toBeNull();
  });
});
