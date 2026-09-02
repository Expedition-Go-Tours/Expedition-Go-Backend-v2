const {
  runQueryAgent,
  runQueryFast,
  answerQuestion,
  parseAgentResponse,
  stripEmojis,
  normalizeQuestion,
  MAX_STEPS,
  resetSchemaCache,
} = require('../../bots/discord-bot/queryAgent');

beforeEach(() => resetSchemaCache());

function makePg({ tables = ['Booking'], describeRows = [], sqlRows = [], sqlError = null, schemaCols = [], schemaFks = [] } = {}) {
  let errored = false;
  return {
    async query(sql, params) {
      // buildCompactSchema: columns with enum values, keyed by table (ANY array param)
      if (/information_schema.columns/.test(sql) && /ANY\(/.test(sql)) {
        return { rows: schemaCols };
      }
      // buildCompactSchema: foreign keys for critical tables (ANY array param)
      if (/information_schema.table_constraints/.test(sql) && /ANY\(/.test(sql)) {
        return { rows: schemaFks };
      }
      if (/information_schema.tables/.test(sql)) {
        if (/table_name=lower/.test(sql) || params) {
          // describe_table case-insensitive lookup
          return {
            rows: tables.filter((t) => t.toLowerCase() === String(params && params[0]).toLowerCase()).map((t) => ({ table_name: t })),
          };
        }
        return { rows: tables.map((t) => ({ table_name: t })) };
      }
      if (/information_schema.columns/.test(sql)) return { rows: describeRows };
      if (/information_schema.table_constraints/.test(sql)) return { rows: [] };
      if (sqlError && !errored) {
        errored = true;
        return Promise.reject(new Error(sqlError));
      }
      return { rows: sqlRows };
    },
  };
}

describe('parseAgentResponse', () => {
  it('parses a plain JSON tool call', () => {
    expect(parseAgentResponse('{"tool":"list_tables"}')).toEqual({ tool: 'list_tables' });
  });

  it('strips markdown fences', () => {
    expect(parseAgentResponse('```json\n{"tool":"describe_table","name":"Booking"}\n```')).toEqual({
      tool: 'describe_table',
      name: 'Booking',
    });
  });

  it('handles prose before the JSON', () => {
    const out = parseAgentResponse('Sure, let me check.\n{"final":"There are 5 bookings."}');
    expect(out).toEqual({ final: 'There are 5 bookings.' });
  });

  it('rejects when no JSON object exists', () => {
    expect(() => parseAgentResponse('no json here')).toThrow(/No JSON object/);
  });
});

describe('runQueryAgent', () => {
  it('answers conversationally with no tool calls when final is returned immediately', async () => {
    const pg = makePg({});
    let calls = 0;
    const callMimo = async () => {
      calls++;
      return '{"final":"Hi there! How can I help?"}';
    };
    const r = await runQueryAgent({ question: 'hello', pg, callMimo });
    expect(r.final).toBe('Hi there! How can I help?');
    expect(calls).toBe(1);
    expect(r.sqlLogs).toEqual([]);
  });

  it('explores the DB before answering a data question', async () => {
    const pg = makePg({
      tables: ['Booking', 'User'],
      describeRows: [
        { column_name: 'bookingNumber', data_type: 'text', enum_values: null },
        { column_name: 'role', data_type: 'USER-DEFINED', enum_values: 'customer|supplier|admin' },
      ],
      sqlRows: [{ bookingNumber: 'BK-001', role: 'admin' }],
    });
    const answers = [
      '{"tool":"list_tables"}',
      '{"tool":"describe_table","name":"booking"}',
      '{"tool":"run_sql","sql":"SELECT \\"bookingNumber\\" FROM \\"Booking\\" LIMIT 10"}',
      '{"final":"Latest booking is BK-001."}',
    ];
    let i = 0;
    const callMimo = async ({ messages }) => {
      const idx = i++;
      const last = messages[messages.length - 1];
      if (last && last.content.startsWith('Tool result (run_sql)') && idx === 3) {
        return answers[3];
      }
      return answers[idx];
    };
    const r = await runQueryAgent({ question: 'what is the latest booking?', pg, callMimo });
    expect(r.final).toBe('Latest booking is BK-001.');
    expect(r.sqlLogs.length).toBe(1);
    expect(r.rowCount).toBe(1);
  });

  it('recovers from a SQL error by feeding the error back to the model', async () => {
    const pg = makePg({
      tables: ['Booking'],
      describeRows: [
        { column_name: 'bookingNumber', data_type: 'text', enum_values: null },
        { column_name: 'status', data_type: 'USER-DEFINED', enum_values: 'PENDING|CONFIRMED' },
      ],
      sqlError: 'invalid input value for enum',
      sqlRows: [{ bookingNumber: 'BK-002' }],
    });
    const answers = [
      '{"tool":"run_sql","sql":"SELECT * FROM \\"Booking\\" WHERE \\"status\\" = \'ADMIN\'"}',
      '{"tool":"run_sql","sql":"SELECT \\"bookingNumber\\" FROM \\"Booking\\" WHERE \\"status\\" = \'CONFIRMED\'"}',
      '{"final":"Found booking BK-002."}',
    ];
    let i = 0;
    const callMimo = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last && last.content.startsWith('Tool result (run_sql):\nERROR:')) {
        return answers[1];
      }
      if (last && last.content.startsWith('Tool result (run_sql):')) {
        return answers[2];
      }
      return answers[i++];
    };
    const r = await runQueryAgent({ question: 'latest confirmed booking?', pg, callMimo });
    expect(r.final).toBe('Found booking BK-002.');
    expect(r.sqlLogs.length).toBe(1);
  });

  it('enforces the read-only guard on run_sql', async () => {
    const pg = makePg({ tables: ['Booking'] });
    const answers = [
      '{"tool":"run_sql","sql":"DELETE FROM \\"Booking\\""}',
      '{"final":"I could not run that."}',
    ];
    let i = 0;
    const callMimo = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last && last.content.startsWith('Tool result (run_sql):\nERROR:')) return answers[1];
      return answers[i++];
    };
    const r = await runQueryAgent({ question: 'delete something', pg, callMimo });
    expect(r.final).toBe('I could not run that.');
    expect(r.sqlLogs).toEqual([]);
  });

  it('stops after MAX_STEPS without a final answer', async () => {
    const pg = makePg({ tables: ['Booking'] });
    const callMimo = async () => '{"tool":"list_tables"}';
    await expect(runQueryAgent({ question: 'spin', pg, callMimo })).rejects.toThrow(/maximum number of steps/);
    expect(MAX_STEPS).toBe(10);
  });

  it('forces a final answer when the step budget is exhausted', async () => {
    const pg = makePg({ tables: ['Booking'] });
    let toolCalls = 0;
    const callMimo = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last && last.content.startsWith('You have reached the step limit')) {
        return '{"final":"I gathered enough data to answer."}';
      }
      toolCalls++;
      return '{"tool":"list_tables"}';
    };
    const r = await runQueryAgent({ question: 'spin', pg, callMimo });
    expect(r.final).toBe('I gathered enough data to answer.');
    expect(toolCalls).toBe(MAX_STEPS);
  });

  it('recovers from malformed JSON by prompting the model to retry', async () => {
    const pg = makePg({ tables: ['Booking'] });
    const answers = [
      'not json at all',
      '{"final":"recovered"}',
    ];
    let i = 0;
    const callMimo = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last && last.content.startsWith('ERROR:')) return answers[1];
      return answers[i++];
    };
    const r = await runQueryAgent({ question: 'hi', pg, callMimo });
    expect(r.final).toBe('recovered');
  });

  it('preloads the compact schema into the system prompt', async () => {
    const pg = makePg({
      tables: ['Booking'],
      schemaCols: [
        { table_name: 'Booking', column_name: 'bookingNumber', enum_values: null },
        { table_name: 'Booking', column_name: 'status', enum_values: 'PENDING|CONFIRMED' },
      ],
      schemaFks: [{ table_name: 'Booking', col: 'customerId', ref_table: 'User' }],
    });
    let systemPrompt = '';
    const callMimo = async ({ messages }) => {
      systemPrompt = messages[0].content;
      return '{"final":"done"}';
    };
    await runQueryAgent({ question: 'hi', pg, callMimo });
    expect(systemPrompt).toContain('"Booking"');
    expect(systemPrompt).toContain('"status" enum(PENDING|CONFIRMED)');
    expect(systemPrompt).toContain('FK "customerId" -> "User"');
  });

  it('caches the compact schema across calls', async () => {
    let schemaQueries = 0;
    const pg = {
      async query(sql, params) {
        if (/information_schema.columns/.test(sql) && /ANY\(/.test(sql)) {
          schemaQueries++;
          return { rows: [{ table_name: 'Booking', column_name: 'bookingNumber', enum_values: null }] };
        }
        if (/information_schema.table_constraints/.test(sql) && /ANY\(/.test(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const callMimo = async () => '{"final":"ok"}';
    await runQueryAgent({ question: 'a', pg, callMimo });
    await runQueryAgent({ question: 'b', pg, callMimo });
    expect(schemaQueries).toBe(1);
  });

  it('falls back to describe_table when a table is not in the preloaded schema', async () => {
    const pg = makePg({
      tables: ['ObscureTable'],
      describeRows: [
        { column_name: 'id', data_type: 'text', enum_values: null },
        { column_name: 'note', data_type: 'text', enum_values: null },
      ],
    });
    const answers = [
      '{"tool":"describe_table","name":"ObscureTable"}',
      '{"final":"I found the obscure table."}',
    ];
    let i = 0;
    const callMimo = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last && last.content.startsWith('Tool result (describe_table)')) return answers[1];
      return answers[i++];
    };
    const r = await runQueryAgent({ question: 'about ObscureTable?', pg, callMimo });
    expect(r.final).toBe('I found the obscure table.');
  });

  it('passes reasoningEffort low on tool steps', async () => {
    const pg = makePg({});
    let seenEffort = null;
    const callMimo = async ({ messages, reasoningEffort }) => {
      seenEffort = reasoningEffort || seenEffort;
      return '{"final":"done"}';
    };
    await runQueryAgent({ question: 'hi', pg, callMimo });
    expect(seenEffort).toBe('low');
  });
});

describe('stripEmojis (deterministic no-emoji rule)', () => {
  it('removes emoji pictographs and emoticons but keeps allowed symbols', () => {
    const out = stripEmojis('Great! 😊 ✅ done :), keep ✓ ⚠ and — yes ▲');
    expect(out).toContain('Great!');
    expect(out).not.toContain('😊');
    expect(out).not.toContain('✅');
    expect(out).not.toContain(':)');
    expect(out).toContain('✓');
    expect(out).toContain('⚠');
    expect(out).toContain('—');
    expect(out).toContain('▲');
  });

  it('does not corrupt numbers, times, or ratios (protects "1:30" and "x:1")', () => {
    const out = stripEmojis('book at 1:30, ratio 2:1, ok.');
    expect(out).toContain('1:30');
    expect(out).toContain('2:1');
  });

  it('keeps markdown bold intact', () => {
    expect(stripEmojis('**bold** and *emph*')).toBe('**bold** and *emph*');
  });

  it('handles null/empty input', () => {
    expect(stripEmojis('')).toBe('');
    expect(stripEmojis(null)).toBe('');
    expect(stripEmojis(undefined)).toBe('');
  });
});

describe('normalizeQuestion', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeQuestion('  How   Many BOOKINGS?? ')).toBe('how many bookings');
  });
});

describe('runQueryFast (fast path)', () => {
  it('answers conversationally with a single model call when final is returned', async () => {
    const pg = makePg({});
    let calls = 0;
    const callMimo = async () => {
      calls++;
      return '{"final":"Direct greeting."}';
    };
    const r = await runQueryFast({ question: 'hello', pg, callMimo });
    expect(r.escalated).toBe(false);
    expect(r.final).toBe('Direct greeting.');
    expect(calls).toBe(1);
  });

  it('runs a generated SQL query then summarizes rows (2 calls)', async () => {
    const pg = makePg({
      sqlRows: [{ bookingNumber: 'BK-9', status: 'CONFIRMED' }],
    });
    const answers = [
      '{"sql":"SELECT \\"bookingNumber\\", \\"status\\" FROM \\"Booking\\" LIMIT 5"}',
      '{"final":"Latest booking is BK-9 (CONFIRMED)."}',
    ];
    let i = 0;
    const callMimo = async () => answers[i++];
    const r = await runQueryFast({ question: 'latest booking?', pg, callMimo });
    expect(r.escalated).toBe(false);
    expect(r.final).toBe('Latest booking is BK-9 (CONFIRMED).');
    expect(r.sqlLogs.length).toBe(1);
    expect(r.rowCount).toBe(1);
  });

  it('escalates when the model asks for a table that is not in the schema', async () => {
    const pg = makePg({ tables: ['Booking'] });
    const callMimo = async () => '{"describe":"ObscureTable"}';
    const r = await runQueryFast({ question: 'about obscure?', pg, callMimo });
    expect(r.escalated).toBe(true);
    expect(r.final).toBe('');
  });

  it('escalates when the generated SQL is not read-only', async () => {
    const pg = makePg({});
    const callMimo = async () => '{"sql":"DELETE FROM \\"Booking\\""}';
    const r = await runQueryFast({ question: 'delete x', pg, callMimo });
    expect(r.escalated).toBe(true);
  });

  it('strips emojis from fast-path answers', async () => {
    const pg = makePg({});
    const callMimo = async () => '{"final":"All good 😊 ✅"}';
    const r = await runQueryFast({ question: 'hi', pg, callMimo });
    expect(r.final).not.toContain('😊');
    expect(r.final).not.toContain('✅');
  });
});

describe('answerQuestion (production orchestrator)', () => {
  it('returns the fast-path answer without a DB round trip for conversational asks', async () => {
    const pg = makePg({});
    const callMimo = async () => '{"final":"Hello!"}';
    const r = await answerQuestion({ question: 'hi', pg, callMimo });
    expect(r.final).toBe('Hello!');
    expect(r.sqlLogs).toEqual([]);
  });

  it('caches an identical repeat question (no second model call)', async () => {
    const pg = makePg({});
    const store = {};
    const cache = {
      async get(k) { return store[k] || null; },
      async set(k, v) { store[k] = v; },
    };
    let calls = 0;
    const callMimo = async () => {
      calls++;
      return '{"final":"cached answer"}';
    };
    const first = await answerQuestion({ question: 'status please', userId: 'u1', pg, callMimo, cache });
    expect(first.final).toBe('cached answer');
    expect(first.cached).toBeUndefined();
    expect(calls).toBe(1);

    const second = await answerQuestion({ question: 'status please', userId: 'u1', pg, callMimo, cache });
    expect(second.final).toBe('cached answer');
    expect(second.cached).toBe(true);
    expect(calls).toBe(1); // served from cache — no extra model call
  });

  it('escalates to the agent loop when the fast path needs describe', async () => {
    const pg = makePg({
      tables: ['Booking'],
      schemaCols: [{ table_name: 'Booking', column_name: 'id', enum_values: null }],
      describeRows: [{ column_name: 'secret', data_type: 'text', enum_values: null }],
      sqlRows: [],
    });
    const answers = [
      '{"describe":"BookingExtra"}', // fast path wants a non-preloaded table
      '{"tool":"describe_table","name":"BookingExtra"}',
      '{"final":"Escalated and answered."}',
    ];
    let i = 0;
    const callMimo = async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last && last.content.startsWith('Tool result (describe_table)')) return answers[2];
      return answers[i++];
    };
    const r = await answerQuestion({ question: 'explore extra table', pg, callMimo });
    expect(r.final).toBe('Escalated and answered.');
  });

  it('strips emojis from the final orchestrator output', async () => {
    const pg = makePg({});
    const callMimo = async () => '{"final":"done ✅ with emoji 😊"}';
    const r = await answerQuestion({ question: 'go', pg, callMimo });
    expect(r.final).toBe('done with emoji');
  });

  it('never writes AI errors into the cache', async () => {
    const pg = makePg({});
    const store = {};
    const cache = {
      async get() { return null; },
      async set(k, v) { store[k] = v; },
    };
    const callMimo = async () => {
      throw new Error('boom');
    };
    await expect(answerQuestion({ question: 'x', userId: 'u', pg, callMimo, cache })).rejects.toThrow('boom');
    expect(Object.keys(store)).toHaveLength(0);
  });
});
