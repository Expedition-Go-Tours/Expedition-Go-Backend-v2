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
 * Production answering is two-tier:
 *   1. FAST PATH  — one MiMo call turns the question into SQL (or a direct
 *      conversational answer), the SQL runs read-only, then one MiMo call
 *      turns the rows into a final answer. Typical: 2 model calls.
 *   2. ESCALATION — if the fast path can't produce a valid query (parse
 *      failure, SQL error, ambiguous question), fall back to the full
 *      ReAct loop below, which can introspect any table and self-heal.
 *   Callers should use answerQuestion(); runQueryAgent remains exported for
 *   direct/legacy use and is the escalation engine.
 *
 * @version 1.1.0
 */

const { validateReadOnly } = require('../../utils/sqlGuard');

// Symbols the ops assistant is allowed to use. Emoji and pictographs that
// ARE NOT in this list are stripped deterministically from every answer, so
// the bot's text stays clean even if the model ignores the style rule.
const ALLOWED_SYMBOLS = '✓⚠▲▼▶◀•·—–✦✧★☆$%+#=';
const TEXT_EMOTICONS = [':)', ':-)', ':D', ':P', ':p', ':(', ':-(', ":'(", ';)', ';-)', ';D', ':O', ':o', ':/', ':\\', ':|', 'xD', 'XD', '^_^', '-_-', '>:(', '=(', '=)'];

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
// Real columns per table (from the compact-schema build + describe_table),
// used to suggest valid identifiers when the model hallucinates a column.
const schemaColumns = new Map(); // tableName -> Set(columnName)
// Enum values per column "Table"."column" -> ['A','B',...], for the same reason.
const schemaEnums = new Map(); // "Table.column" -> string[]

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

/** Extract table identifiers referenced by a SQL statement. */
function referencedTables(sql) {
  const tables = [];
  const re = /(?:from|join|update|into)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  let m;
  while ((m = re.exec(String(sql || '')))) tables.push(m[1]);
  return tables;
}

/**
 * Given a failed SQL and its PostgreSQL error, produce a deterministic
 * corrective hint so the model fixes it in one retry instead of guessing:
 *   - if the query references a known table, list that table's real columns
 *   - else fuzzy-match the hallucinated name against all indexed columns
 * @returns {string} '' when there is nothing useful to say.
 */
function suggestColumns(sql, errorMsg) {
  const m = String(errorMsg || '').match(/column\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+does not exist/i);
  if (!m) return '';
  const wanted = m[1].split('.').pop().toLowerCase();
  if (!wanted) return '';

  const tables = referencedTables(sql);
  // Prefer tables actually referenced by the query; fall back to every index.
  const order = tables.length ? tables : [...schemaColumns.keys()];

  const byTable = new Map();
  for (const tbl of order) {
    const set = schemaColumns.get(tbl);
    if (!set) continue;
    const cols = [...set].sort();
    if (cols.length) byTable.set(tbl, cols);
  }

  // Known table with real columns → hand them over verbatim.
  if (byTable.size) {
    const listed = [];
    for (const [tbl, cols] of byTable) {
      const names = cols.filter((c) => c.toLowerCase() !== wanted).slice(0, 12);
      listed.push(`table "${tbl}" columns: ${names.map((c) => `"${c}"`).join(', ')}`);
    }
    return ` Valid columns for ${listed.join('; ')}.`;
  }

  // Unknown table → fuzzy match the hallucinated name against all columns.
  const scored = [];
  for (const colSet of schemaColumns.values()) {
    for (const col of colSet) {
      const cl = col.toLowerCase();
      if (cl === wanted) continue;
      let d = levenshtein(cl, wanted);
      if (cl.includes(wanted) || wanted.includes(cl)) d = Math.min(d, 2);
      scored.push({ col, d });
    }
  }
  scored.sort((x, y) => x.d - y.d || x.col.localeCompare(y.col));
  const top = scored.slice(0, 5).filter((x) => x.d <= 3).map((x) => `"${x.col}"`);
  if (!top.length) return '';
  return ` Did you mean ${top.slice(0, -1).join(', ')}${top.length > 1 ? ' or ' : ' '}${top[top.length - 1]}?`;
}

/**
 * Given an enum mismatch error ("invalid input value for enum \"X\": \"bad\""),
 * hand back the valid values for the enum column(s) the query touched.
 * Deterministic — no extra model call. @returns {string} '' if nothing useful.
 */
function suggestEnumValues(sql, errorMsg) {
  const m = String(errorMsg || '').match(/invalid input value for enum\s+"([^"]+)":\s+"([^"]+)"/i);
  if (!m) return '';
  const badValue = m[2];
  const tables = referencedTables(sql);
  const order = tables.length ? tables : [...schemaEnums.keys()].map((k) => k.split('.')[0]);

  const hints = [];
  for (const tbl of order) {
    const cols = [];
    for (const [key, values] of schemaEnums) {
      const [t, c] = key.split('.');
      if (t !== tbl) continue;
      const quoted = values.map((v) => `'${v}'`).join(', ');
      cols.push({ column: c, values, quoted });
    }
    if (!cols.length) continue;
    for (const col of cols) {
      const validUpper = col.values.some((v) => v === String(badValue).toUpperCase());
      hints.push(
        `"${tbl}"."${col.column}" accepts: ${col.quoted}${validUpper ? ` (note: uppercase, e.g. '${String(badValue).toUpperCase()}', not '${badValue}')` : ''}`
      );
    }
  }
  if (!hints.length) return '';
  return ` Valid enum values — ${hints.join('; ')}.`;
}

function stripFences(text) {
  return text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
}

/**
 * Extract the first complete JSON object from a model response.
 *
 * Robust to reasoning prose BEFORE the JSON, markdown fences, and content
 * AFTER the object (another tool call, a trailing thought, stray braces).
 * Scans character-by-character, tracking brace depth and skipping JSON
 * strings (so a '}' inside a string value is not mistaken for a close).
 * @returns {string} the raw JSON substring.
 * @throws {Error} if no balanced object is found.
 */
function extractFirstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error('No JSON object found in response');
}

/**
 * Parse the first JSON object from a model response.
 * @throws {Error} on malformed JSON or when none exists.
 */
function parseAgentResponse(text) {
  const raw = extractFirstJsonObject(text);
  return JSON.parse(raw);
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[truncated ${text.length - max} chars]`;
}

/**
 * Deterministically remove emoji and emoticons from bot text while keeping
 * allowed business symbols (✓ ⚠ ▲ ▼ • · — $ % etc.) intact.
 *
 * Strategy: temporarily hide allowed symbols behind private-use placeholders
 * (so an emoji-strip regex can't remove them), strip real emoji pictographs
 * + variation/skin-tone/ZWJ sequences + text emoticons, then restore the
 * hidden symbols.
 */
function stripEmojis(text) {
  if (!text) return String(text || '');
  const s = String(text);
  const unique = [...new Set(ALLOWED_SYMBOLS)].join('');
  const map = {};
  let i = 0;
  for (const ch of unique) map[ch] = String.fromCodePoint(0xE000 + i++);

  // 1) Hide allowed symbols.
  let hidden = s;
  for (const [ch, code] of Object.entries(map)) hidden = hidden.split(ch).join(code);

  // 2) Remove emoji + emoji modifiers/joiners/variation selectors + keycaps.
  hidden = hidden.replace(/\p{Extended_Pictographic}/gu, '');
  // Skin-tone modifiers (U+1F3FB..1F3FF), VS16, ZWJ and keycap marks.
  hidden = hidden.replace(/\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu, '');
  hidden = hidden.replace(/\uFE0F/g, '').replace(/\u200D/g, '').replace(/\u20E3/g, '');

  // 3) Remove ASCII/kaomoji emoticons (word-boundary guarded).
  for (const emo of TEXT_EMOTICONS) {
    hidden = hidden.replace(
      new RegExp(`(^|[\\s])(${emo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[\\s.,!?;:])`, 'gu'),
      '$1'
    );
  }
  hidden = hidden.replace(/(?<![A-Za-z0-9])(?:o_O|O_o|>_<|>\.<|;D|:-\||:-&)(?![A-Za-z0-9])/g, '');

  // 4) Restore allowed symbols.
  let restored = hidden;
  for (const [ch, code] of Object.entries(map)) {
    restored = restored.split(code).join(ch);
  }

  // 5) Collapse doubled spaces left by removals (keep newlines).
  return restored.replace(/ {2,}/g, ' ').trim();
}

/**
 * Make a question collision-resistant for caching / history: lowercase,
 * strip punctuation (keep letters/digits/spaces), collapse whitespace.
 */
function normalizeQuestion(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    // Index real columns for deterministic identifier suggestions.
    if (!schemaColumns.has(table)) schemaColumns.set(table, new Set());
    schemaColumns.get(table).add(c.column_name);
    if (c.enum_values) {
      schemaEnums.set(
        `${table}.${c.column_name}`,
        String(c.enum_values).split('|').map((v) => v.trim()).filter(Boolean)
      );
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
      // Index real column names for deterministic suggestions.
      if (!schemaColumns.has(c.table_name)) schemaColumns.set(c.table_name, new Set());
      schemaColumns.get(c.table_name).add(c.column_name);
      // Index enum values for deterministic enum-hint suggestions.
      if (c.enum_values) {
        schemaEnums.set(
          `${c.table_name}.${c.column_name}`,
          String(c.enum_values).split('|').map((v) => v.trim()).filter(Boolean)
        );
      }
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
    const msg = String(e.message || '');
    if (/does not exist/i.test(msg)) {
      // Hallucinated column → hand over the real columns.
      return { error: `${msg}${suggestColumns(guard.safeSql, msg)}` };
    }
    if (/invalid input value for enum/i.test(msg)) {
      // Wrong enum casing/value → hand over the valid values.
      return { error: `${msg}${suggestEnumValues(guard.safeSql, msg)}` };
    }
    return { error: msg };
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
2. For data questions, use the SCHEMA below directly — it already lists the real columns and enum values for the main tables. Go STRAIGHT to run_sql; do NOT call list_tables or describe_table for tables already listed in SCHEMA (their columns are complete). Only describe a table that is NOT in the SCHEMA.
3. NEVER guess identifiers. Use exactly the names in SCHEMA.
4. Always double-quote identifiers, e.g. "Booking"."bookingNumber".
5. If run_sql returns an ERROR, read the error, fix the SQL, and retry (a few times). Do not call describe_table for a table already in SCHEMA just to retry — the columns are already available.
6. When you have the data, reply with {"final":"<concise answer>"}.

STYLE:
- No emojis, emoji characters, or emoticons anywhere (e.g. 😊, 😄, ✅, :), :-), ^_^). Symbols such as ✓ ⚠ ▲ ▼ • · — $ % are allowed. Use plain text and **bold** only.
- FORMAT: ANY final answer — however long, lists included — is EXACTLY ONE JSON object {"final":"..."}. Put newlines and numbered lists INSIDE the JSON string value (as \n). Never emit the answer as plain prose outside JSON; if you start writing prose, stop and wrap it.
- Be concise and professional. Do not use cheery filler like "Great question!" or "That said". Answer the substance directly.
- If the user asks why you are slow: explain it honestly — each answer is produced by several sequential model calls that inspect the live schema, run queries, and verify results, so complex questions take longer than a quick count; it is the model round-trips, not the database, that add time. Keep it short.

SQL RULES:
- SELECT or WITH only (read-only). ALWAYS double-quote ALL identifiers — PostgreSQL folds unquoted names to lowercase and many identifiers are camelCase.
- Enum columns show enum(value1|value2|...) — match values EXACTLY, case-sensitive (e.g. 'admin' not 'ADMIN').
- JSONB columns: use ->> for text fields, e.g. "businessInfo"->>'legalBusinessName'.
- Fuzzy name searches: ILIKE '%term%' across ALL name-like keys (e.g. "legalBusinessName", "displayName", "businessName").
- Use JOINs, GROUP BY, aggregates as needed. Order by recency ("createdAt" DESC) when relevant.
- PLACE SEMANTICS: A bare place name ("Accra", "Kumasi", "Cape Coast") means the CITY — match "Tour"."city" (case-insensitive) or the tour title. Do NOT use "Tour"."region" as the primary match unless the user explicitly says a region word ("region", "Greater Accra", "Eastern Region") or names a district outside the city (e.g. "Ada Foah", "Dedenya"). For a bare-city COUNT, produce ONE query that returns BOTH scopes so the answer is honest, e.g.:
  SELECT COUNT(*) FILTER (WHERE lower("city") ILIKE '%accra%' OR lower("title") ILIKE '%accra%') AS city_count,
         COUNT(*) FILTER (WHERE lower("region") ILIKE '%accra%') AS region_count
  FROM "Tour" WHERE "status" = 'ACTIVE';
  Then answer city-first with the region note when they differ, e.g. "7 in Accra (13 including the Greater Accra Region)". For a bare-city LIST, filter by city/title (not region).

  SCHEMA:
${schemaBlock || '(none preloaded — call list_tables / describe_table to discover)'}
${historyText ? `\nPREVIOUS CONVERSATION:\n${historyText}` : ''}`;
}

/**
 * Fast-path system prompt. The model must produce ONE JSON object with
 * exactly one key: "sql", "final", or "describe".
 *  - {"sql":"..."}      → a read-only query to run (preferred for data Qs)
 *  - {"final":"..."}    → direct answer when the DB isn't needed
 *  - {"describe":"T"}   → escalation signal: table not in SCHEMA
 */
function buildFastSystem(schemaBlock, historyText) {
  return `You are TravioAfrica's ops assistant. Decide in ONE step what a user question needs.

Output EXACTLY ONE JSON object, no markdown fences, no extra text:
- {"sql":"SELECT ..."} — if the question needs live data. Write ONE valid read-only query using the SCHEMA below.
- {"final":"<answer>"} — if the question does NOT need the database (greeting, opinion, general knowledge, small talk, "who are you", thanks). Answer directly.
- {"describe":"<TableName>"} — ONLY if you need a table that is NOT listed in SCHEMA below. Never for tables in SCHEMA.

You are not allowed to write any other tool calls — this is a single-step responder.

SQL RULES (when you output "sql"):
- SELECT or WITH only (read-only). ALWAYS double-quote ALL identifiers — PostgreSQL folds unquoted names to lowercase and many identifiers are camelCase.
- Enum columns show enum(value1|value2|...) — match values EXACTLY, case-sensitive (e.g. 'admin' not 'ADMIN').
- JSONB columns: use ->> for text fields, e.g. "businessInfo"->>'legalBusinessName'.
- Fuzzy name searches: ILIKE '%term%' across ALL name-like keys (e.g. "legalBusinessName", "displayName", "businessName").
- Use JOINs, GROUP BY, aggregates as needed. Order by recency ("createdAt" DESC) when relevant.
- Never guess identifiers — use exactly the names in SCHEMA. Do NOT call describe_table for tables already in SCHEMA.
- PLACE SEMANTICS: A bare place name ("Accra", "Kumasi", "Cape Coast") means the CITY — match "Tour"."city" (case-insensitive) or the tour title. Do NOT use "Tour"."region" as the primary match unless the user explicitly says a region word ("region", "Greater Accra", "Eastern Region") or names a district outside the city (e.g. "Ada Foah", "Dedenya"). For a bare-city COUNT, produce ONE query that returns BOTH scopes so the answer is honest, e.g.:
  SELECT COUNT(*) FILTER (WHERE lower("city") ILIKE '%accra%' OR lower("title") ILIKE '%accra%') AS city_count,
         COUNT(*) FILTER (WHERE lower("region") ILIKE '%accra%') AS region_count
  FROM "Tour" WHERE "status" = 'ACTIVE';
  Then answer city-first with the region note when they differ, e.g. "7 in Accra (13 including the Greater Accra Region)". For a bare-city LIST, filter by city/title (not region).

STYLE (for "final"):
- No emojis, emoji characters, or emoticons (😊, ✅, :), :-), ^_^). Symbols such as ✓ ⚠ ▲ ▼ • · — $ % are allowed. Use plain text and **bold** only.
- FORMAT: ANY final answer — however long, lists included — is EXACTLY ONE JSON object {"final":"..."}. Put newlines and numbered lists INSIDE the JSON string value (as \n). Never emit the answer as plain prose outside JSON; if you start writing prose, stop and wrap it.
- Be concise and professional. No cheery filler ("Great question!", "Absolutely!"). If asked why you are slow, explain it honestly: answers come from several sequential model calls that inspect the live database, run and verify queries, so complex questions take longer than a quick count — the model round-trips, not the database, are what add time.

SCHEMA:
${schemaBlock || '(none preloaded)'}
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
 * @param {Object} [opts.seed]      - Warm-escalation context from the fast path:
 *   { sql, error } — a SQL attempt that already failed plus its (hint-rich)
 *   error. When present the agent starts from that knowledge instead of cold
 *   list_tables/describe exploration.
 * @returns {Promise<{ final: string, sqlLogs: string[], rowCount: number }>}
 */
async function runQueryAgent({ question, userId = '?', historyText = '', history = [], pg, callMimo, seed }) {
  const schemaBlock = await buildCompactSchema(pg);
  const system = buildSystem(schemaBlock, historyText);

  const messages = [{ role: 'system', content: system }];
  for (const turn of history) {
    if (turn && turn.role && typeof turn.content === 'string' && turn.content.trim()) {
      messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.content.slice(0, 1500) });
    }
  }
  if (seed && (seed.sql || seed.error)) {
    // Warm escalation: the fast path already tried SQL and learned the schema.
    // Give the agent that attempt so it fixes the query instead of re-deriving.
    messages.push({
      role: 'user',
      content:
        `[Warm context from an earlier attempt] A first query was tried and failed. ` +
        `Failed SQL:\n${String(seed.sql || '(none)').slice(0, 1000)}\n\n` +
        `Error:\n${String(seed.error || '').slice(0, 1200)}\n\n` +
        `The SCHEMA above lists the real identifiers. Write a corrected read-only query and run it, then answer.`,
    });
  }
  messages.push({ role: 'user', content: question });

  const sqlLogs = [];
  let rowCount = 0;
  let final = null;
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;

  for (let step = 0; step < MAX_STEPS; step++) {
    const tStep = Date.now();
    const out = await callMimo({ messages, maxTokens: TOOL_MAX_TOKENS, temperature: 0.1, reasoningEffort: 'low' });
    const stepMs = Date.now() - tStep;
    let parsed;
    try {
      parsed = parseAgentResponse(out);
      console.log(`[agent:${userId}] step=${step + 1} call=${stepMs}ms total=${ms()} raw=${out.slice(0, 200)}`);
    } catch (e) {
      console.log(`[agent:${userId}] step=${step + 1} call=${stepMs}ms total=${ms()} PARSE_ERR=${e.message} raw=${out.slice(0, 300)}`);
      messages.push({ role: 'assistant', content: out.slice(0, 800) });
      messages.push({
        role: 'user',
        content: `ERROR: could not parse your response as JSON (${e.message}). Output ONLY a JSON object: {"tool":"...","..."} or {"final":"..."}.`,
      });
      continue;
    }

    if (parsed.final !== undefined) {
      final = String(parsed.final);
      console.log(`[agent:${userId}] final total=${ms()} final=${final.slice(0, 300)}`);
      break;
    }

    if (!parsed.tool) {
      console.log(`[agent:${userId}] step=${step + 1} total=${ms()} no_tool`);
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
      console.log(`[agent:${userId}] step=${step + 1} total=${ms()} unknown_tool=${parsed.tool}`);
      messages.push({ role: 'assistant', content: out.slice(0, 800) });
      messages.push({
        role: 'user',
        content: `ERROR: unknown tool "${parsed.tool}". Valid tools: list_tables, describe_table, run_sql, final_answer.`,
      });
      continue;
    }

    console.log(`[agent:${userId}] step=${step + 1} total=${ms()} tool=${parsed.tool} result=${resultText.slice(0, 200)}`);
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

/**
 * Fast path: answer a question in as few model calls as possible.
 *
 * Round 1 — one MiMo call via buildFastSystem returns {"sql":...},
 * {"final":...}, or {"describe":...}.
 *   * "final"  → done (conversational: 1 model call).
 *   * "sql"    → run it read-only. On SQL error, retry ONCE with the error
 *                fed back (2 model calls worst case). On success, run
 *                Round 2 to turn the rows into an answer.
 *   * "describe" or anything else → escalate (caller runs the ReAct loop).
 * Round 2 — one MiMo call summarizes the result rows into the final answer.
 *
 * @returns {Promise<{ final: string, sqlLogs: string[], rowCount: number, escalated: boolean }>}
 *          `final` is '' when escalation is required.
 */
async function runQueryFast({ question, userId = '?', historyText = '', pg, callMimo }) {
  const schemaBlock = await buildCompactSchema(pg);
  const system = buildFastSystem(schemaBlock, historyText);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: question }];

  const escalate = (ctx = {}) => ({ final: '', sqlLogs: [], rowCount: 0, escalated: true, ...ctx });
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;

  // Round 1: decide sql / final / describe.
  let out1;
  let parsed1;
  const parseRound1 = async () => {
    const tStep = Date.now();
    out1 = await callMimo({ messages, maxTokens: TOOL_MAX_TOKENS, temperature: 0.1, reasoningEffort: 'low' });
    const callMs = Date.now() - tStep;
    try {
      parsed1 = parseAgentResponse(out1);
      console.log(`[fast:${userId}] round1 call=${callMs}ms total=${ms()} parsed=${JSON.stringify(parsed1).slice(0, 200)}`);
    } catch (e) {
      console.log(`[fast:${userId}] round1 call=${callMs}ms total=${ms()} PARSE_ERR=${e.message} raw=${out1.slice(0, 200)}`);
      parsed1 = null;
    }
  };
  await parseRound1();

  if (!parsed1) {
    // A prose/garbled answer must not immediately drop into the slow loop.
    // One corrective retry — same strict format — before escalation.
    messages.push({ role: 'assistant', content: out1.slice(0, 800) });
    messages.push({
      role: 'user',
      content:
        'Your previous response was not valid. Output EXACTLY ONE JSON object, no markdown, no prose: {"sql":"SELECT ..."} or {"final":"<answer>"} or {"describe":"<Table>"}.',
    });
    await parseRound1();
    if (!parsed1) return escalate();
  }

  if (parsed1.final !== undefined) {
    const final = stripEmojis(String(parsed1.final));
    console.log(`[fast:${userId}] final total=${ms()}`);
    return { final, sqlLogs: [], rowCount: 0, escalated: false };
  }
  if (parsed1.describe !== undefined || parsed1.sql === undefined) {
    return escalate();
  }

  // Execute the generated SQL.
  let sql = parsed1.sql;
  let run = await runSql(pg, sql);
  if (run.error) {
    // One self-heal retry feeding the (now suggestion-rich) error back.
    messages.push({ role: 'assistant', content: out1.slice(0, 800) });
    messages.push({ role: 'user', content: `Your SQL failed: ${run.error.slice(0, 500)}. Fix it and answer again with the same format.` });
    try {
      const tRetry = Date.now();
      const out2 = await callMimo({ messages, maxTokens: TOOL_MAX_TOKENS, temperature: 0.1, reasoningEffort: 'low' });
      console.log(`[fast:${userId}] round1.retry call=${Date.now() - tRetry}ms total=${ms()}`);
      const parsed2 = parseAgentResponse(out2);
      if (parsed2.final !== undefined) {
        const final = stripEmojis(String(parsed2.final));
        console.log(`[fast:${userId}] final total=${ms()}`);
        return { final, sqlLogs: [], rowCount: 0, escalated: false };
      }
      if (parsed2.sql !== undefined) {
        sql = parsed2.sql;
        run = await runSql(pg, sql);
      }
    } catch {
      // ignore retry parse failure; escalate below if still broken
    }
    if (run.error) {
      console.log(`[fast:${userId}] round1 sql still failing total=${ms()}: ${run.error.slice(0, 200)}`);
      // Warm-escalate: hand the failed SQL + hint-rich error to the agent loop.
      return escalate({ seed: { sql: sql.slice(0, 1500), error: run.error.slice(0, 1500) } });
    }
  }

  // Round 2: summarize the rows into an answer.
  const summaryMessages = [
    {
      role: 'system',
      content:
        'You convert a database query result into a concise, accurate business answer. No emojis or emoticons (symbols like ✓ ⚠ ▲ ▼ • · — $ % are fine). Use **bold** for key numbers. If rows are empty, say so plainly. Output ONLY the answer text.',
    },
    { role: 'user', content: `Question: ${question}\n\nSQL:\n${sql}\n\nResult:\n${run.text}` },
  ];
  const tSum = Date.now();
  const out3 = await callMimo({ messages: summaryMessages, maxTokens: FINAL_MAX_TOKENS, temperature: 0.1, reasoningEffort: 'low' });
  console.log(`[fast:${userId}] summarize call=${Date.now() - tSum}ms total=${ms()}`);
  let final;
  try {
    const p3 = parseAgentResponse(out3);
    final = String(p3.final !== undefined ? p3.final : out3);
  } catch {
    final = stripFences(out3);
  }
  final = stripEmojis(final);
  console.log(`[fast:${userId}] done total=${ms()}`);
  return { final, sqlLogs: [run.sql], rowCount: run.rows, escalated: false };
}

/**
 * Production entry point: fast path first, ReAct escalation as a fallback,
 * deterministic no-emoji cleanup on whatever text comes back.
 *
 * Accepts the same options as runQueryAgent. Optionally `cache = { get, set }`
 * (Redis-backed) keyed by userId + normalized question; `cacheTtlSec` applies
 * when the orchestrator writes new entries.
 */
async function answerQuestion({ question, userId = '?', historyText = '', history = [], pg, callMimo, cache, cacheTtlSec = 60 }) {
  const key = cache ? `ai:ans:${userId}:${normalizeQuestion(question).slice(0, 120)}` : null;

  if (cache && key) {
    try {
      const hit = await cache.get(key);
      if (hit) {
        console.log(`[answer:${userId}] cache_hit question="${question.slice(0, 80)}"`);
        return { final: hit, sqlLogs: [], rowCount: 0, cached: true };
      }
    } catch {
      // cache errors must never break answering
    }
  }

  let result;
  try {
    result = await runQueryFast({ question, userId, historyText, pg, callMimo });
  } catch (e) {
    console.log(`[answer:${userId}] fast_path error → escalate: ${e.message}`);
    result = { escalated: true };
  }

  if (result.escalated) {
    console.log(`[answer:${userId}] escalating to agent loop${result.seed ? ' (warm: seeded with failed SQL + hint)' : ''}`);
    const agent = await runQueryAgent({
      question,
      userId,
      historyText,
      history,
      pg,
      callMimo,
      seed: result.seed, // warm escalation context (may be undefined → cold start)
    });
    result = { final: agent.final, sqlLogs: agent.sqlLogs, rowCount: agent.rowCount };
  }

  result.final = stripEmojis(result.final);
  if (key && result.final && !/^AI error/.test(result.final)) {
    try {
      await cache.set(key, result.final, cacheTtlSec);
    } catch {
      // ignore cache write failures
    }
  }
  return result;
}

function resetSchemaCache() {
  schemaCache = null;
  schemaCacheTime = 0;
  schemaColumns.clear();
  schemaEnums.clear();
}

module.exports = {
  runQueryAgent,
  runQueryFast,
  answerQuestion,
  parseAgentResponse,
  stripEmojis,
  normalizeQuestion,
  suggestColumns,
  suggestEnumValues,
  MAX_STEPS,
  CRITICAL_TABLES,
  resetSchemaCache,
};
