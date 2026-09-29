/**
 * Regression gate for the deterministic fact router, driven by the Phase 0
 * replay corpus.
 *
 * The corpus in __tests__/replay/questions.json is the only record of the six
 * REAL production questions plus the coverage/edge cases written for Phase 0.
 * scripts/replayBot.js replays it against a live database and model — too heavy
 * and too non-deterministic for CI. This test replays the same corpus against
 * the router only, with no database and no model, so a change to the routing
 * rules that silently starts claiming analytical, contextual or place-qualified
 * questions fails the build.
 *
 * The failure mode this guards is ASYMMETRIC:
 *   - declining a question we could have answered is harmless (it falls through
 *     to the existing SQL agent);
 *   - claiming a question the fact layer does not actually cover hands the user
 *     a confident wrong number.
 * So the assertions here are strict about NOT claiming, and forgiving about
 * claiming (a deliberate corpus update is required to add a claim).
 *
 * When routing rules change on purpose, update expectRoute/expectOutcome in the
 * corpus rather than loosening this test.
 */

const fs = require('fs');
const path = require('path');

const { routeToFact } = require('../../bots/discord-bot/factRouter');
const { getBusinessFacts, currencyIsSatisfied } = require('../../bots/discord-bot/businessFacts');

const CORPUS_PATH = path.join(__dirname, '..', 'replay', 'questions.json');
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')).questions;

// Fixed so window resolution cannot make the test fail on a particular day.
const NOW = new Date('2026-09-29T12:00:00Z');

/** A pg stub that records queries and returns no rows. */
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

describe('factRouter corpus — routing matches the Phase 0 expectations', () => {
  it('loads a non-trivial corpus including the real production questions', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(20);
    expect(corpus.filter((q) => q.origin === 'real').length).toBeGreaterThanOrEqual(6);
  });

  it.each(corpus.map((q) => [q.id, q]))('%s — routes as expected', (_id, q) => {
    const route = routeToFact(q.question, { now: NOW });
    const got = route ? route.metric : null;
    expect(got).toBe(q.expectRoute);
  });

  it('never claims a question the corpus says must fall through', () => {
    // Stated separately from the route assertion so a regression reads clearly.
    const unsafe = corpus
      .filter((q) => q.expectRoute === null)
      .map((q) => ({ id: q.id, question: q.question, got: routeToFact(q.question, { now: NOW }) }))
      .filter((r) => r.got !== null);
    expect(unsafe.map((u) => `${u.id} "${u.question}" -> ${u.got.metric}`)).toEqual([]);
  });

  it.each(corpus.filter((q) => q.expectOutcome === 'decline').map((q) => [q.id, q]))(
    '%s — the claimed metric then refuses rather than answering wrongly',
    async (_id, q) => {
      const route = routeToFact(q.question, { now: NOW });
      expect(route).not.toBeNull();
      const res = await getBusinessFacts(route.metric, {
        window: route.window,
        statusFilter: route.statusFilter,
        windowedCount: route.windowedCount,
        currencyFilter: route.currencyFilter,
        customerRole: route.customerRole,
        pg: makePg([]),
      });
      // The currency gate is the important refusal: a question about GBP must
      // never be answered with USD numbers.
      expect(currencyIsSatisfied(route, res).ok).toBe(false);
    }
  );
});

describe('factRouter corpus — the two real conversational questions', () => {
  it('does not route "In usd" (a fragment that modifies the previous answer)', () => {
    const q = corpus.find((x) => x.question === 'In usd');
    expect(q).toBeDefined();
    expect(routeToFact(q.question, { now: NOW })).toBeNull();
  });

  it('does not route "I want details on the 4 bookings" (count comes from history)', () => {
    const q = corpus.find((x) => x.question === 'I want details on the 4 bookings');
    expect(q).toBeDefined();
    expect(routeToFact(q.question, { now: NOW })).toBeNull();
  });

  it('routes the three real self-contained revenue questions', () => {
    for (const question of [
      'whats the revenue for the past month',
      'total revenue in usd',
      'how about the total revenue for the past week',
    ]) {
      const route = routeToFact(question, { now: NOW });
      expect(route && route.metric).toBe('revenue');
    }
  });
});
