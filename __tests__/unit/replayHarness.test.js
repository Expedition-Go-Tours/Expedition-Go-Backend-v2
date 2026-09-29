/**
 * Tests for the replay harness itself.
 *
 * scripts/replayBot.js is the instrument the Phase 0 results were measured
 * with, so a bug in the harness silently corrupts every number it reports. The
 * harness needs a live database and model to run end to end, which CI does not
 * have — so its two pure units (the fact path and the revenue-definition audit)
 * are exercised here with a stub client and a stub model.
 *
 * These do NOT test the router or the fact SQL (businessFacts.test.js and
 * factRouterCorpus.test.js do that). They test that the harness wires the fact
 * layer together correctly: that it refuses to narrate a fact it could not
 * build, that it honours a refusal instead of inventing an answer, and that the
 * revenue audit reports all three candidate definitions.
 */

const {
  runFact,
  revenueDefinitionAudit,
  REVENUE_AUDIT_DEFINITIONS,
} = require('../../scripts/replayBot');

const USD_ROW = { currency: 'USD', bookings: 4, gross: '604.00' };

/** A pg stub: records queries, replies from a queue keyed by nothing in particular. */
function makePg(rowsByMatch = []) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      const hit = rowsByMatch.find((m) => sql.includes(m.contains));
      return { rows: hit ? hit.rows : [] };
    },
  };
}

const noModel = () => {
  throw new Error('the model must not be called for this case');
};

describe('replayBot runFact — wiring', () => {
  it('declines a question the router does not claim, and calls nothing', async () => {
    const pg = makePg();
    const rec = await runFact({ question: 'why did bookings drop last week' }, pg, { callMimo: noModel });
    expect(rec.routed).toBe(false);
    expect(rec.reason).toMatch(/router declined/);
    expect(pg.queries).toHaveLength(0);
  });

  it('returns the fact SQL, facts and narrated answer for a claimable question', async () => {
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    const rec = await runFact({ question: 'revenue this week' }, pg, {
      callMimo: async () => 'Revenue this week was **$604.00** across 4 bookings.',
    });
    expect(rec.routed).toBe(true);
    expect(rec.metric).toBe('revenue');
    expect(rec.declined).toBe(false);
    expect(rec.sql).toMatch(/FROM "Booking"/);
    expect(rec.facts.byCurrency[0].gross).toBe(604);
    expect(rec.answer).toMatch(/\$604\.00/);
    expect(rec.modelCalls).toBe(1);
    expect(rec.narrMs).toBeGreaterThanOrEqual(0);
  });

  it('narrates with the constrained fact prompt, never a free-form one', async () => {
    let sentSystem = null;
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    await runFact({ question: 'revenue this week' }, pg, {
      callMimo: async ({ messages }) => {
        sentSystem = messages[0].content;
        return 'ok';
      },
    });
    // The narration contract must forbid inventing figures.
    expect(sentSystem).toMatch(/Never invent/);
  });

  it('honours a currency refusal instead of answering in the wrong currency', async () => {
    // "what is the revenue in gbp" routes, but the data is USD only.
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    const rec = await runFact({ question: 'what is the revenue in gbp' }, pg, { callMimo: noModel });
    expect(rec.routed).toBe(true);
    expect(rec.declines).toBe(true);
    expect(rec.currencyGate.ok).toBe(false);
    expect(rec.currencyGate.reason).toMatch(/GBP/);
    // Critically: no answer was produced, so the caller falls through.
    expect(rec.answer).toBeUndefined();
  });

  it('treats a malformed fact as a failure rather than narrating it', async () => {
    // One row with a missing amount: the narration would otherwise call this
    // "no revenue" with full confidence.
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [{ currency: 'USD', bookings: 2, gross: null }] }]);
    const rec = await runFact({ question: 'revenue this week' }, pg, { callMimo: noModel });
    // gross: null is a legitimate zero, so this must still narrate...
    expect(rec.declined).toBe(false);

    // ...but an absent field must not be narrated as a real value.
    const bad = makePg([{ contains: 'FROM "Booking"', rows: [{ currency: 'USD', bookings: 2 }] }]);
    const rec2 = await runFact({ question: 'revenue this week' }, bad, { callMimo: noModel });
    expect(rec2.integrity.ok).toBe(false);
    expect(rec2.declines).toBe(true);
  });

  it('maps a query error to a refusal, not to zero revenue', async () => {
    const pg = {
      queries: [],
      async query() {
        throw new Error('relation "Booking" does not exist');
      },
    };
    const rec = await runFact({ question: 'revenue this week' }, pg, { callMimo: noModel });
    expect(rec.routed).toBe(true);
    expect(rec.declines).toBe(true);
    expect(rec.error).toMatch(/does not exist/);
  });

  it('reports a model failure without claiming an answer', async () => {
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    const rec = await runFact({ question: 'revenue this week' }, pg, {
      callMimo: async () => {
        throw new Error('model unavailable');
      },
    });
    expect(rec.answer).toBeNull();
    expect(rec.narrError).toMatch(/model unavailable/);
  });

  it('records the generated SQL so the report can show it', async () => {
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    const rec = await runFact({ question: 'revenue this week' }, pg, { callMimo: async () => 'ok' });
    expect(rec.sql).toContain('GROUP BY');
    expect(rec.sqlMs).toBeGreaterThanOrEqual(0);
  });
});

describe('replayBot revenueDefinitionAudit — reports all candidates', () => {
  it('evaluates the approved, status-only and digest definitions for each window', async () => {
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    const out = await revenueDefinitionAudit(pg);

    const windows = [...new Set(out.map((r) => r.window))];
    expect(windows).toEqual([
      'the past 7 days (rolling)',
      'the past 30 days (rolling)',
      'the previous month (calendar)',
      'all time',
    ]);
    expect(Object.keys(REVENUE_AUDIT_DEFINITIONS)).toEqual(['approved', 'status-only', 'digest']);

    for (const w of windows) {
      for (const def of Object.keys(REVENUE_AUDIT_DEFINITIONS)) {
        expect(out.some((r) => r.window === w && r.definition === def)).toBe(true);
      }
    }
    expect(out.every((r) => r.ok && r.total === 604)).toBe(true);
  });

  it('applies the simulated filter to the approved figure in EVERY window', async () => {
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    await revenueDefinitionAudit(pg);

    const all = pg.queries.filter((q) => q.sql.includes('FROM "Booking"'));
    // 3 candidate definitions x 4 windows.
    expect(all).toHaveLength(12);

    // The rejected digest definition is always identifiable by its single
    // status equality, and it always excludes simulated rows.
    const digest = all.filter((q) => q.sql.includes(`"status" = 'CONFIRMED'`));
    expect(digest).toHaveLength(4);
    expect(digest.every((q) => q.sql.includes('isSimulated'))).toBe(true);

    // The approved and "status-only" candidates share the same status list, so
    // between them there are 8 queries: 4 approved + 4 status-only.
    const statusList = all.filter((q) => q.sql.includes(`"status" IN ('CONFIRMED','COMPLETED')`));
    expect(statusList).toHaveLength(8);

    // The approved definition drops simulated rows in EVERY window. Restricting
    // that to all-time is what let the previous calendar month report a figure
    // that was 99.2% seed data.
    const approved = statusList.filter((q) => q.sql.includes('isSimulated'));
    expect(approved).toHaveLength(4);
    expect(approved.filter((q) => q.sql.includes('"createdAt"'))).toHaveLength(3);

    // The status-only candidate keeps every simulated row, isolating the effect.
    expect(statusList.filter((q) => !q.sql.includes('isSimulated'))).toHaveLength(4);
  });

  it('carries the window bounds as parameters for period windows only', async () => {
    const pg = makePg([{ contains: 'FROM "Booking"', rows: [USD_ROW] }]);
    await revenueDefinitionAudit(pg);
    const all = pg.queries.filter((q) => q.sql.includes('FROM "Booking"'));
    for (const q of all) {
      if (q.sql.includes('"createdAt"')) {
        expect(q.params).toHaveLength(2);
        expect(q.params[0]).toBeInstanceOf(Date);
      } else {
        expect(q.params).toHaveLength(0);
      }
    }
  });
});
