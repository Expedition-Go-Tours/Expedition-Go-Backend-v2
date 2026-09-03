const { buildActivityReport } = require('../../bots/discord-bot/activityEngine');
const { detectActivityIntent, answerQuestion } = require('../../bots/discord-bot/queryAgent');

function mockPg(handlers) {
  return {
    async query(sql) {
      const h = handlers.find((fn) => fn.re.test(sql));
      if (h) return { rows: h.rows(sql) };
      return { rows: [] };
    },
  };
}

// Fresh module state for each test.
jest.resetModules();
beforeEach(() => {
  const m = require('../../bots/discord-bot/queryAgent');
  if (m.resetSchemaCache) m.resetSchemaCache();
});

describe('detectActivityIntent (deterministic router)', () => {
  it('detects audit/activity questions with a default 2h window', () => {
    expect(detectActivityIntent('check activity logs')).toEqual({ hours: 2 });
    expect(detectActivityIntent('any errors recently?')).toEqual({ hours: 2 });
    expect(detectActivityIntent('who logged in')).toEqual({ hours: 2 });
  });

  it('parses an explicit window from the question', () => {
    expect(detectActivityIntent('check activity logs from the last 6 hours')).toEqual({ hours: 6 });
    expect(detectActivityIntent('what happened in the last 24 hours')).toEqual({ hours: 24 });
  });

  it('does not fire for ordinary data questions', () => {
    expect(detectActivityIntent('how many accra tours do we have')).toBeNull();
    expect(detectActivityIntent('list bookings for today')).toBeNull();
    expect(detectActivityIntent('hi')).toBeNull();
  });
});

describe('buildActivityReport (structured facts)', () => {
  it('groups real/auth errors, logs exact logins, and ignores nothing silently', async () => {
    const pg = mockPg([
      {
        re: /errorName' AS name/,
        rows: () => [
          { endpoint: '/api/bookings', status: '500', name: 'Error', count: 4, users: ['(anonymous)'], first_at: '2026-09-02 19:00:00', last_at: '2026-09-02 19:01:00' },
          { endpoint: '/api/auth/refresh', status: '401', name: 'TokenExpiredError', count: 6, users: ['(anonymous)'], first_at: '2026-09-02 18:53:00', last_at: '2026-09-02 18:53:05' },
        ],
      },
      {
        re: /classification' = 'business'/,
        rows: () => [
          { endpoint: '/api/suppliers/application/status', status: '404', message: 'No supplier application found', count: 17, users: ['richiebgitcall94@gmail.com'] },
        ],
      },
      {
        re: /AS probes/,
        rows: () => [{ probes: 6 }],
      },
      {
        re: /action = 'auth\.login'/,
        rows: () => [
          { email: 'richiebgitcall94@gmail.com', at: '2026-09-02 18:33:03.891' },
          { email: 'guyritchie94@gmail.com', at: '2026-09-02 18:56:17.349' },
        ],
      },
      {
        re: /"User" WHERE|"SupplierProfile" WHERE/,
        rows: () => [{ users: 0, suppliers: 0 }],
      },
      {
        re: /WITH bursts AS|HAVING count\(\*\) >= 5/,
        rows: () => [{ email: '(anonymous)', endpoint: '/api/bookings', peak: 8, seconds: 1 }],
      },
    ]);

    const report = await buildActivityReport({ pg, hours: 2 });

    // Real vs auth separated
    expect(report.errors.real).toHaveLength(1);
    expect(report.errors.real[0]).toMatchObject({ endpoint: '/api/bookings', status: '500', count: 4 });
    expect(report.errors.auth).toHaveLength(1);
    expect(report.errors.auth[0]).toMatchObject({ status: '401', count: 6 });

    // Business 4xx separated (never counted as real errors)
    expect(report.errors.business).toHaveLength(1);
    expect(report.errors.business[0]).toMatchObject({ status: '404', count: 17 });

    // Exact logins
    expect(report.logins).toEqual([
      { email: 'richiebgitcall94@gmail.com', at: expect.stringMatching(/2026-09-02 18:33:03 UTC/) },
      { email: 'guyritchie94@gmail.com', at: expect.stringMatching(/2026-09-02 18:56:17 UTC/) },
    ]);

    expect(report.noise.probes).toBe(6);
    expect(report.anomalies).toEqual([
      { type: 'error_burst', email: '(anonymous)', endpoint: '/api/bookings', peakPerSecond: 8, seconds: 1 },
    ]);
    expect(report.window.hours).toBe(2);
  });

  it('returns a well-formed empty report when nothing matches', async () => {
    const pg = mockPg([]);
    const report = await buildActivityReport({ pg, hours: 2 });
    expect(report.errors.real).toEqual([]);
    expect(report.errors.auth).toEqual([]);
    expect(report.errors.business).toEqual([]);
    expect(report.logins).toEqual([]);
    expect(report.signups).toEqual({ users: 0, suppliers: 0 });
    expect(report.noise.probes).toBe(0);
  });
});

describe('answerQuestion routes activity questions to the deterministic path', () => {
  it('returns narration over engine facts, never free-form SQL', async () => {
    const pg = mockPg([]);
    let calls = 0;
    const callMimo = async ({ messages }) => {
      calls++;
      const userMsg = String(messages[messages.length - 1].content);
      if (userMsg.includes('Activity report')) {
        return '{"final":"In the last 2 hours: no real errors, no logins."}';
      }
      throw new Error('free-form path must not run for activity questions');
    };
    const r = await answerQuestion({ question: 'check activity logs', userId: 'u', pg, callMimo });
    expect(r.final).toContain('no real errors');
    expect(calls).toBe(1); // only narration; no SQL-generation round trips
    expect(r.sqlLogs).toEqual([]);
  });

  it('falls through to the normal agent when the engine fails', async () => {
    const pg = mockPg([]);
    pg.query = async () => {
      throw new Error('db down');
    };
    const callMimo = async () => '{"final":"generic fallback"}';
    const r = await answerQuestion({ question: 'check activity logs please', userId: 'u', pg, callMimo });
    expect(r.final).toContain('generic fallback');
  });
});
