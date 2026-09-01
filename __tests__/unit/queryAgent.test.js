const { runQueryAgent, parseAgentResponse, MAX_STEPS } = require('../../bots/discord-bot/queryAgent');

function makePg({ tables = ['Booking'], describeRows = [], sqlRows = [], sqlError = null } = {}) {
  let errored = false;
  return {
    async query(sql, params) {
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
    expect(MAX_STEPS).toBe(6);
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
});
