/**
 * Agentic DB explorer for the TravioAfrica ops assistant.
 *
 * Replaces static text-to-SQL (a fixed schema dump in the prompt) with a
 * ReAct-style loop: the AI calls tools to introspect the LIVE database
 * (list_tables / describe_table), writes SQL with real identifiers it just
 * learned, runs it read-only, and iterates until it can produce a final
 * answer. Because every table/column/enum name comes from live
 * introspection instead of the model's memory, identifier hallucinations
 * (wrong casing, wrong enum values, guessed columns) are eliminated.
 *
 * Used by both the dedicated AI channel and the /ask / /chat slash commands.
 *
 * @version 1.0.0
 */

const { validateReadOnly } = require('../../utils/sqlGuard');

const MAX_STEPS = 10;
const MAX_ROWS = 50;
const MAX_CELL_CHARS = 200;
const MAX_RESULT_CHARS = 3000;
const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOOL_MAX_TOKENS = 768;   // tool-proposal steps only need short JSON
const FINAL_MAX_TOKENS = 1400; // roomier for the final business answer

// Tables whose schema is preloaded into the system prompt for speed.
// Anything not listed here is discovered on demand via describe_table.
const CRITICAL_TABLES = [
  'Booking',
  'Tour',
  'User',
  'SupplierProfile',
  'Payout',
  'PayoutRequest',
  'Dispute',
  'Review',
  'SpecialOffer',
  'Vehicle',
  'Guide',
  'SupplierDocument',
];

let schemaCache = null;
let schemaCacheTime = 0;

function stripFences(text) {
  return text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
}

/**
 * Extract the first JSON object from a model response.
 * Handles markdown fences and surrounding prose.
 * @throws {Error} if no valid JSON object can be found.
 */
function parseAgentResponse(text) {
  const cleaned = stripFences(String(text || ''));
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in response');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[truncated ${text.length - max} chars]`;
}

function cellStr(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  const s = String(v);
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + '...' : s;
}

async function listTables(pg) {
  const r = await pg.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
  );
  return r.rows.map((x) => x.table_name).join('\n');
}

async function describeTable(pg, name) {
  const t = await pg.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND lower(table_name)=lower($1)`,
    [name]
  );
  if (!t.rows.length) return `Table not found. Use list_tables to see available tables.`;
  const table = t.rows[0].table_name;

  const cols = await pg.query(
    `SELECT c.column_name, c.data_type,
        (SELECT string_agg(e.enumlabel, '|' ORDER BY e.enumsortorder)
         FROM pg_type ty JOIN pg_enum e ON e.enumtypid = ty.oid
         WHERE ty.typname = c.udt_name) AS enum_values
     FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = $1
     ORDER BY c.ordinal_position`,
    [table]
  );
  const lines = [];
  for (const c of cols.rows) {
    if (c.enum_values) {
      lines.push(`  "${c.column_name}" enum(${c.enum_values})`);
    } else {
      lines.push(`  "${c.column_name}" ${c.data_type}`);
    }
  }

  const fks = await pg.query(
    `SELECT kcu.column_name AS col, ccu.table_name AS ref_table, ccu.column_name AS ref_col
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1`,
    [table]
  );
  const fkLines = fks.rows.map((f) => `  FK: "${f.col}" -> "${f.ref_table}"."${f.ref_col}"`);

  return `Table "${table}":\n${lines.join('\n')}${fkLines.length ? '\n' + fkLines.join('\n') : ''}`;
}

/**
 * Build a compact, cached schema block for the critical tables so the
 * agent can go straight to run_sql instead of introspecting first.
 * Falls back to '' on any failure (agent then uses describe_table).
 */
async function buildCompactSchema(pg) {
  const now = Date.now();
  if (schemaCache && now - schemaCacheTime < SCHEMA_CACHE_TTL_MS) return schemaCache;
  try {
    const placeholders = CRITICAL_TABLES.map((_, i) => `$${i + 1}`).join(', ');

    // Columns + enum values for the critical tables
    const cols = await pg.query(
      `SELECT c.table_name, c.column_name,
              (SELECT string_agg(e.enumlabel, '|' ORDER BY e.enumsortorder)
               FROM pg_type ty JOIN pg_enum e ON e.enumtypid = ty.oid
               WHERE ty.typname = c.udt_name) AS enum_values
       FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = ANY($${CRITICAL_TABLES.length + 1}::text[])
       ORDER BY c.table_name, c.ordinal_position`,
      [...CRITICAL_TABLES, CRITICAL_TABLES]
    );

    const byTable = {};
    for (const t of CRITICAL_TABLES) byTable[t] = [];
    for (const c of cols.rows) {
      if (!byTable[c.table_name]) byTable[c.table_name] = [];
      byTable[c.table_name].push(
        c.enum_values ? `"${c.column_name}" enum(${c.enum_values})` : `"${c.column_name}"`
      );
    }

    // Foreign keys for the critical tables
    const fks = await pg.query(
      `SELECT tc.table_name, kcu.column_name AS col, ccu.table_name AS ref_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
         AND tc.table_name = ANY($1::text[])`,
      [CRITICAL_TABLES]
    );
    const fkByTable = {};
    for (const f of fks.rows) {
      if (!fkByTable[f.table_name]) fkByTable[f.table_name] = [];
      fkByTable[f.table_name].push(`"${f.col}" -> "${f.ref_table}"`);
    }

    const lines = CRITICAL_TABLES
      .filter((t) => byTable[t] && byTable[t].length)
      .map((t) => {
        const fks = (fkByTable[t] || []).map((f) => `FK ${f}`).join(', ');
        return `"${t}"(${byTable[t].join(', ')})${fks ? `; ${fks}` : ''}`;
      });

    schemaCache = lines.join('\n');
    schemaCacheTime = now;
    return schemaCache;
  } catch {
    return '';
  }
}

async function runSql(pg, sql) {
  const guard = validateReadOnly(sql);
  if (!guard.ok) return { error: guard.error };
  try {
    const res = await pg.query(guard.safeSql);
    const rows = (res.rows || []).slice(0, MAX_ROWS);
    const formatted = rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cellStr(v)]))
    );
    return {
      text: truncate(JSON.stringify(formatted), MAX_RESULT_CHARS),
      sql: guard.safeSql,
      rows: rows.length,
    };
  } catch (e) {
    return { error: e.message };
  }
}

function buildSystem(schemaBlock, historyText) {
  return `You are TravioAfrica's ops assistant. You answer business questions about the TravioAfrica platform by exploring the live PostgreSQL database with tools, or conversationally.

TOOLS — respond with EXACTLY ONE JSON object, no markdown fences, no extra text:
- {"tool":"list_tables"} — list all table names.
- {"tool":"describe_table","name":"<Table>"} — get a table's real columns, types, enum values, and foreign keys.
- {"tool":"run_sql","sql":"SELECT ..."} — run a read-only query. Results are capped at 50 rows.
- {"final":"<answer>"} — give the final answer to the user and stop.

WORKFLOW:
1. Greeting / opinion / non-data question? Reply immediately with {"final":"..."}.
2. For data questions, use the SCHEMA below directly — it already lists the real columns and enum values for the main tables. Go STRAIGHT to run_sql; do NOT waste steps calling list_tables or describe_table for tables already in the schema.
3. Only call describe_table (or list_tables) for a table NOT in the schema below. NEVER guess identifiers.
4. Always double-quote identifiers, e.g. "Booking"."bookingNumber".
5. If run_sql returns an ERROR, read the error, inspect the schema, fix the SQL, and retry (a few times).
6. When you have the data, reply with {"final":"<concise business answer>"} — max ~6 sentences, cite key numbers.

SQL RULES:
- SELECT or WITH only (read-only). ALWAYS double-quote ALL identifiers — PostgreSQL folds unquoted names to lowercase and many identifiers are camelCase.
- Enum columns show enum(value1|value2|...) — match values EXACTLY, case-sensitive (e.g. 'admin' not 'ADMIN').
- JSONB columns: use ->> for text fields, e.g. "businessInfo"->>'legalBusinessName'.
- Fuzzy name searches: ILIKE '%term%' across ALL name-like keys (e.g. "legalBusinessName", "displayName", "businessName").
- Use JOINs, GROUP BY, aggregates as needed. Order by recency ("createdAt" DESC) when relevant.

SCHEMA:
${schemaBlock || '(none preloaded — call list_tables / describe_table to discover)'}
${historyText ? `\nPREVIOUS CONVERSATION:\n${historyText}` : ''}`;
}

/**
 * Run the agentic exploration loop.
 *
 * @param {Object} opts
 * @param {string} opts.question    - The user's question.
 * @param {string} [opts.userId]    - Discord user id (for audit logging).
 * @param {string} [opts.historyText] - Prior conversation as one text block ('' if none).
 * @param {Array}  [opts.history]   - Prior turns as [{role:'user'|'assistant', content}].
 * @param {Object} opts.pg          - pg client with .query().
 * @param {Function} opts.callMimo  - callMimo({ messages, maxTokens, temperature }).
 * @returns {Promise<{ final: string, sqlLogs: string[], rowCount: number }>}
 */
async function runQueryAgent({ question, userId = '?', historyText = '', history = [], pg, callMimo }) {
  const schemaBlock = await buildCompactSchema(pg);
  const system = buildSystem(schemaBlock, historyText);

  const messages = [{ role: 'system', content: system }];
  for (const turn of history) {
    if (turn && turn.role && typeof turn.content === 'string' && turn.content.trim()) {
      messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.content.slice(0, 1500) });
    }
  }
  messages.push({ role: 'user', content: question });

  const sqlLogs = [];
  let rowCount = 0;
  let final = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const out = await callMimo({ messages, maxTokens: TOOL_MAX_TOKENS, temperature: 0.1, reasoningEffort: 'low' });
    let parsed;
    try {
      parsed = parseAgentResponse(out);
      console.log(`[agent:${userId}] step=${step + 1} raw=${out.slice(0, 200)}`);
    } catch (e) {
      console.log(`[agent:${userId}] step=${step + 1} PARSE_ERR=${e.message} raw=${out.slice(0, 300)}`);
      messages.push({ role: 'assistant', content: out.slice(0, 800) });
      messages.push({
        role: 'user',
        content: `ERROR: could not parse your response as JSON (${e.message}). Output ONLY a JSON object: {"tool":"...","..."} or {"final":"..."}.`,
      });
      continue;
    }

    if (parsed.final !== undefined) {
      final = String(parsed.final);
      console.log(`[agent:${userId}] final=${final.slice(0, 300)}`);
      break;
    }

    if (!parsed.tool) {
      console.log(`[agent:${userId}] step=${step + 1} no_tool`);
      messages.push({ role: 'assistant', content: out.slice(0, 800) });
      messages.push({ role: 'user', content: 'ERROR: response must contain "tool" or "final". Retry.' });
      continue;
    }

    let resultText = '';
    if (parsed.tool === 'list_tables') {
      resultText = await listTables(pg);
    } else if (parsed.tool === 'describe_table') {
      resultText = await describeTable(pg, parsed.name);
    } else if (parsed.tool === 'run_sql') {
      const r = await runSql(pg, parsed.sql);
      if (r.error) {
        resultText = `ERROR: ${r.error}`;
      } else {
        resultText = r.text;
        sqlLogs.push(r.sql);
        rowCount += r.rows;
      }
    } else {
      console.log(`[agent:${userId}] step=${step + 1} unknown_tool=${parsed.tool}`);
      messages.push({ role: 'assistant', content: out.slice(0, 800) });
      messages.push({
        role: 'user',
        content: `ERROR: unknown tool "${parsed.tool}". Valid tools: list_tables, describe_table, run_sql, final_answer.`,
      });
      continue;
    }

    console.log(`[agent:${userId}] step=${step + 1} tool=${parsed.tool} result=${resultText.slice(0, 200)}`);
    messages.push({ role: 'assistant', content: out.slice(0, 800) });
    messages.push({ role: 'user', content: `Tool result (${parsed.tool}):\n${resultText}` });
  }

  if (!final) {
    // Step budget exhausted: force the model to answer with what it has learned.
    messages.push({
      role: 'user',
      content: 'You have reached the step limit. Stop exploring. Using ONLY the information already gathered in this conversation, produce your best final answer now. Output ONLY a JSON object: {"final":"<answer>"}.',
    });
    try {
      const out = await callMimo({ messages, maxTokens: FINAL_MAX_TOKENS, temperature: 0.1, reasoningEffort: 'low' });
      const parsed = parseAgentResponse(out);
      final = parsed.final !== undefined ? String(parsed.final) : null;
    } catch {
      final = null;
    }
  }

  if (!final) {
    throw new Error('Agent exceeded the maximum number of steps without producing a final answer.');
  }

  return { final, sqlLogs, rowCount };
}

module.exports = { runQueryAgent, parseAgentResponse, MAX_STEPS, CRITICAL_TABLES, resetSchemaCache };

function resetSchemaCache() {
  schemaCache = null;
  schemaCacheTime = 0;
}
