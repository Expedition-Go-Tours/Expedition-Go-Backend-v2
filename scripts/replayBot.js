#!/usr/bin/env node
/**
 * replayBot.js — Phase 0 replay + baseline harness.
 *
 * READ-ONLY. This script never posts to Discord, never writes to the
 * database, and never changes production configuration. It exists to answer one
 * question with evidence before anything is built:
 *
 *   "If common questions were answered by deterministic SQL facts instead of
 *    by the model writing its own SQL, would we get the same numbers, in less
 *    time, with no quality loss?"
 *
 * For every corpus question it runs BOTH paths:
 *   CURRENT : bots/discord-bot/queryAgent.js answerQuestion() — the exact code
 *             the live bot runs today (fast path → ReAct escalation).
 *   FACT    : the deterministic prototype (test fixture) → SQL → MiMo
 *             narration. Narration is kept, per the Phase 0 constraints.
 *
 * Usage:
 *   node scripts/replayBot.js                    # full corpus
 *   node scripts/replayBot.js --only real-02,real-05
 *   node scripts/replayBot.js --skip-current     # fact path only (cheap)
 *   node scripts/replayBot.js --out /tmp/x.json
 *
 * Requires a reachable DATABASE_URL and MIMO_API_KEY. Run it from the repo
 * root or anywhere; REPO_ROOT is resolved from this file's location.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// REPO_ROOT may be overridden so the harness can run from a scratch directory
// (e.g. /tmp) against a real checkout on the server, without writing anything
// into that checkout.
const REPO_ROOT = process.env.REPLAY_REPO_ROOT
  ? path.resolve(process.env.REPLAY_REPO_ROOT)
  : path.resolve(__dirname, '..');
// dotenv is optional: env may already be in the process, and its absence must
// not stop the harness from loading.
try {
  require(path.join(REPO_ROOT, 'node_modules/dotenv')).config({ path: path.join(REPO_ROOT, '.env') });
} catch {
  /* no dotenv available — rely on the ambient environment */
}

// The corpus lives next to the repo by default, but may be supplied separately
// (e.g. when the harness runs from /tmp). Only the corpus is a fixture now — the
// fact path under test is the REAL production module set, so a replay result
// describes the code that would actually ship.
const FIXTURES = process.env.REPLAY_FIXTURES || path.join(REPO_ROOT, '__tests__/replay');

const { callMimo: realCallMimo } = require(path.join(REPO_ROOT, 'src/core/services/mimoClient'));
const { answerQuestion } = require(path.join(REPO_ROOT, 'bots/discord-bot/queryAgent'));
const { factsEnabled } = require(path.join(REPO_ROOT, 'bots/discord-bot/factRouter'));
const { answerBusinessFact } = require(path.join(REPO_ROOT, 'bots/discord-bot/businessFacts'));
const { resolveWindow, REVENUE_STATUSES } = require(path.join(REPO_ROOT, 'src/core/services/metricDefinitions'));

/**
 * pg is loaded lazily, only when a connection is actually opened.
 *
 * It is installed under bots/discord-bot/node_modules on the server but is not a
 * root dependency, so requiring it here would make the whole module (including
 * the exported helpers) unimportable anywhere pg is absent. Keeping it inside
 * this function means the fact-path helpers can be unit-tested with an injected
 * stub client and no driver at all.
 */
function loadPgClient() {
  const candidates = [
    path.join(REPO_ROOT, 'bots/discord-bot/node_modules/pg'),
    path.join(REPO_ROOT, 'node_modules/pg'),
    'pg',
  ];
  for (const c of candidates) {
    try {
      return require(c).Client;
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error(
    'pg is not installed. The bot carries its own copy at bots/discord-bot/node_modules/pg; run the harness from a checkout that has it.'
  );
}

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const flag = (name) => argv.includes(name);
const ONLY = argOf('--only') ? argOf('--only').split(',').map((s) => s.trim()) : null;
const LIMIT = argOf('--limit') ? Number(argOf('--limit')) : null;
const SKIP_CURRENT = flag('--skip-current');
const OUT = argOf('--out') || path.join(os.tmpdir(), `replay-${Date.now()}.json`);

const say = (s = '') => fs.writeSync(1, `${s}\n`);
const hr = (t) => say(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);
const ms = (n) => `${String(n).padStart(7)}ms`;

// ── instrumentation ────────────────────────────────────────────────────────
/** Wrap callMimo so every model round-trip is counted and timed. */
function instrumentMimo(inner) {
  const calls = [];
  const wrapped = async (opts) => {
    const t = Date.now();
    try {
      const out = await inner(opts);
      calls.push({ ms: Date.now() - t, maxTokens: opts.maxTokens, ok: true, chars: (out || '').length });
      return out;
    } catch (e) {
      calls.push({ ms: Date.now() - t, maxTokens: opts.maxTokens, ok: false, error: String(e.message || e) });
      throw e;
    }
  };
  wrapped.calls = calls;
  return wrapped;
}

/** Count the retries/escalations queryAgent reports through console.log. */
function instrumentConsole() {
  const stats = { parseErrors: 0, sqlRetries: 0, sqlStillFailing: 0, escalations: 0, steps: 0, templateEcho: 0 };
  const original = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    if (/round1.*PARSE_ERR/.test(line)) stats.parseErrors++;
    if (/round1\.retry/.test(line)) stats.sqlRetries++;
    if (/round1 sql still failing/.test(line)) stats.sqlStillFailing++;
    if (/escalating to agent loop/.test(line)) stats.escalations++;
    if (/\[agent:.*\] step=/.test(line)) stats.steps++;
    if (/TEMPLATE_ECHO/.test(line)) stats.templateEcho++;
  };
  return { stats, restore: () => { console.log = original; } };
}

// ── path: CURRENT (production code, unmodified) ────────────────────────────
async function runCurrent(q, pg) {
  const probe = instrumentConsole();
  const callMimo = instrumentMimo(realCallMimo);
  const historyText = (q.history || []).map((t) => `${t.role}: ${t.content}`).join('\n');
  const t0 = Date.now();
  let result = null;
  let error = null;
  try {
    result = await answerQuestion({
      question: q.question,
      userId: 'replay',
      historyText,
      history: q.history || [],
      pg,
      callMimo,
      cache: null, // never share answers between corpus entries
    });
  } catch (e) {
    error = String(e.message || e);
  }
  const totalMs = Date.now() - t0;
  const { restore } = probe;
  restore();
  return {
    totalMs,
    modelCalls: callMimo.calls.length,
    modelMs: callMimo.calls.reduce((a, c) => a + c.ms, 0),
    maxTokens: callMimo.calls.map((c) => c.maxTokens),
    failed: callMimo.calls.some((c) => !c.ok),
    sql: (result && result.sqlLogs) || [],
    rowCount: (result && result.rowCount) || 0,
    answer: (result && result.final) || null,
    error,
    ...probe.stats,
  };
}

// ── path: FACT (deterministic fact layer + MiMo narration) ─────────────────
/**
 * Measure the fact path by running the PRODUCTION pipeline.
 *
 * This used to re-implement route → getBusinessFacts → currency gate →
 * integrity gate → narrate locally, which meant the replay measured code that
 * never ran in the bot — it even disagreed with it (the local copy dropped
 * route.topToursLimit, so "top 3 tours" was measured at five rows). It now
 * delegates to answerBusinessFact() and only reshapes the result into the record
 * shape the report below consumes.
 *
 * @param {object} q a corpus entry
 * @param {object} pg a pg-like client
 * @param {{callMimo?: Function}} [opts] injected so tests can run with no model
 */
async function runFact(q, pg, opts = {}) {
  const callMimo = instrumentMimo(opts.callMimo || realCallMimo);
  const r = await answerBusinessFact({ question: q.question, pg, callMimo });

  if (!r.route) {
    return { routed: false, reason: r.reason, totalMs: r.totalMs };
  }

  const modelCalls = callMimo.calls.length;
  const modelMs = callMimo.calls.reduce((a, c) => a + c.ms, 0);
  // The record used to spell this two ways — `declines: true` on refusals and
  // `declined: false` on successes — so the report (which reads `.declines`) and
  // the tests (which read `.declined`) could disagree about the same run. Both
  // keys now carry one value on every branch.
  const claimed = (declined) => ({
    routed: true,
    metric: r.route.metric,
    window: r.route.window.label,
    stage: r.stage,
    modelCalls,
    modelMs,
    sqlMs: r.sqlMs,
    fact: r.fact,
    declines: declined,
    declined,
    // The reason a refusal happened, for the report's "claimed then declined"
    // table. currencyGate and integrity keep their own fields too.
    error: r.reason,
  });

  if (r.stage === 'query') {
    return claimed(true);
  }
  if (r.stage === 'currency') {
    return { ...claimed(true), currencyGate: r.currencyGate };
  }
  if (r.stage === 'integrity') {
    return { ...claimed(true), integrity: r.integrity };
  }

  return {
    ...claimed(!r.ok),
    definition: r.fact.definition || null,
    sql: r.sql,
    facts: r.facts,
    narrMs: r.narrMs,
    totalMs: r.totalMs,
    answer: r.answer,
    narrError: r.narrError,
  };
}

// ── revenue definition comparison (constraint 4) ───────────────────────────
/**
 * The three candidate revenue definitions, as raw WHERE fragments.
 *
 * These live in the harness, not in production: this is an AUDIT of competing
 * definitions, and only the approved one exists in metricDefinitions.js. Keeping
 * the rejected variants here means the report can always show what was rejected
 * and by how much.
 */
const REVENUE_AUDIT_DEFINITIONS = {
  approved: {
    label: 'status IN (CONFIRMED,COMPLETED) + isSimulated = false; EVERY window',
    where: () =>
      `"status" IN (${REVENUE_STATUSES.map((s) => `'${s}'`).join(',')}) AND "isSimulated" = false`,
  },
  'status-only': {
    label: 'status IN (CONFIRMED,COMPLETED); simulated INCLUDED',
    where: () => `"status" IN (${REVENUE_STATUSES.map((s) => `'${s}'`).join(',')})`,
  },
  digest: {
    label: "status = 'CONFIRMED' AND isSimulated = false",
    where: () => `"status" = 'CONFIRMED' AND "isSimulated" = false`,
  },
};

async function revenueDefinitionAudit(pg) {
  // The third entry deliberately says "last month", not "past month": "past
  // month" now means a rolling 30 days, which would duplicate the second row
  // and lose the calendar-month comparison — the row where approved and
  // status-only diverge most ($90.89 vs $12,072.28).
  const WINDOWS = [
    { phrase: 'revenue for the past 7 days', label: 'the past 7 days (rolling)' },
    { phrase: 'revenue for the past 30 days', label: 'the past 30 days (rolling)' },
    { phrase: 'revenue for the last month', label: 'the previous month (calendar)' },
    { phrase: 'total revenue', label: 'all time' },
  ];
  const out = [];
  for (const w of WINDOWS) {
    const window = resolveWindow(w.phrase);
    for (const [defName, def] of Object.entries(REVENUE_AUDIT_DEFINITIONS)) {
      const params = [];
      let dateClause = '';
      if (window.from) {
        dateClause = ' AND "createdAt" >= $1 AND "createdAt" < $2';
        params.push(window.from, window.to);
      }
      const sql =
        'SELECT "currency", COUNT(*)::int AS bookings, COALESCE(SUM("total"),0)::text AS gross ' +
        `FROM "Booking" WHERE ${def.where(window.isAllTime)}${dateClause} GROUP BY 1 ORDER BY 2 DESC`;
      let row = { ok: false, error: null, byCurrency: null };
      try {
        const r = await pg.query(sql, params);
        row = {
          ok: true,
          byCurrency: r.rows.map((x) => ({ currency: x.currency, bookings: x.bookings, gross: Number(x.gross) })),
        };
      } catch (e) {
        row.error = String(e.message || e);
      }
      out.push({
        window: w.label,
        definition: defName,
        label: def.label,
        ok: row.ok,
        error: row.error,
        byCurrency: row.byCurrency,
        total: row.ok ? row.byCurrency.reduce((a, c) => a + c.gross, 0) : null,
        bookings: row.ok ? row.byCurrency.reduce((a, c) => a + c.bookings, 0) : null,
      });
    }
  }
  return out;
}

// ── currency audit (constraint 5) ──────────────────────────────────────────
async function currencyAudit(pg) {
  const r = await pg.query(
    `SELECT "currency", COUNT(*)::int AS n, COALESCE(SUM("total"),0)::text AS gross,
            MIN("createdAt")::date AS first, MAX("createdAt")::date AS last
     FROM "Booking" GROUP BY "currency" ORDER BY n DESC`
  );
  const sim = await pg.query(
    `SELECT "isSimulated", COUNT(*)::int AS n, COALESCE(SUM("total"),0)::text AS gross
     FROM "Booking" GROUP BY "isSimulated" ORDER BY "isSimulated"`
  );
  return { byCurrency: r.rows, bySimulated: sim.rows };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const corpus = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'questions.json'), 'utf8')).questions;
  let questions = corpus;
  if (ONLY) questions = questions.filter((q) => ONLY.includes(q.id));
  if (LIMIT) questions = questions.slice(0, LIMIT);

  const Client = loadPgClient();
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  say(`replayBot — ${questions.length} question(s)${SKIP_CURRENT ? '  [CURRENT path skipped]' : ''}`);
  say(`corpus: ${corpus.length} total, ${corpus.filter((q) => q.origin === 'real').length} from production logs`);
  say(`AI_FACTS_ENABLED=${factsEnabled() ? 'true' : 'false'}  (the harness always runs the fact path regardless; this reports the production gate)`);

  // ── audits first (cheap, and they gate the revenue decision) ──
  hr('AUDIT 1 — currency reality (constraint 5)');
  const cur = await currencyAudit(pg);
  say('bookings by currency, all time:');
  for (const c of cur.byCurrency) {
    say(`  ${String(c.currency).padEnd(6)} n=${String(c.n).padStart(4)}  gross=$${Number(c.gross).toFixed(2)}  ${String(c.first).slice(0, 10)}..${String(c.last).slice(0, 10)}`);
  }
  say(cur.byCurrency.length > 1
    ? '  => MULTIPLE CURRENCIES. Grouping is mandatory; a flat sum would be misleading.'
    : '  => single currency today. Grouping is still mandatory, so a second currency cannot silently corrupt a total.');
  say('\nbookings by isSimulated, all time:');
  for (const s of cur.bySimulated) {
    say(`  isSimulated=${String(s.isSimulated).padEnd(6)} n=${String(s.n).padStart(4)}  gross=$${Number(s.gross).toFixed(2)}`);
  }
  const simRecent = await pg.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM("total"),0)::text AS g FROM "Booking"
     WHERE "createdAt" >= $1 AND "isSimulated" = true`,
    [new Date(Date.now() - 30 * 864e5)]
  );
  say(`  simulated bookings in the last 30 days: n=${simRecent.rows[0].n} gross=$${Number(simRecent.rows[0].g).toFixed(2)}`);

  hr('AUDIT 2 — competing revenue definitions (constraint 4)');
  say('The digest and the bot do not agree, and the bot did not agree with itself.\n');
  const revAudit = await revenueDefinitionAudit(pg);
  const usd = (n) => (n === null || n === undefined ? 'ERROR' : `$${Number(n).toFixed(2)}`);
  for (const row of revAudit) {
    const cur0 = row.byCurrency ? row.byCurrency.map((c) => `${c.currency}:$${c.gross.toFixed(2)}(${c.bookings})`).join(' ') : `ERROR ${row.error}`;
    say(`  ${row.window.padEnd(30)} ${row.definition.padEnd(12)} n=${String(row.bookings).padStart(3)} total=${usd(row.total).padStart(12)}   ${cur0}`);
  }
  say('\n  approved     = status IN (CONFIRMED, COMPLETED) AND isSimulated = false — in EVERY window');
  say('  status-only  = the same statuses with simulated INCLUDED (isolates the simulated effect)');
  say('  digest       = status = CONFIRMED AND isSimulated = false (dailyDigest.js)');
  say('\n  Windows: "past X" is ROLLING and ends at the reference instant ("past month"');
  say('  = last 30 days); "last X" is a complete CALENDAR period; an explicit count');
  say('  ("past 7 days") is rolling. The third row says "last month" for that reason.');

  // Per-window comparison, grouped so adding a definition cannot mis-pair rows.
  for (const w of [...new Set(revAudit.map((r) => r.window))]) {
    const rows = revAudit.filter((r) => r.window === w && r.total !== null);
    const approved = rows.find((r) => r.definition === 'approved');
    if (!approved) continue;
    say(`\n  "${w}": approved ${usd(approved.total)} (n=${approved.bookings})`);
    for (const other of rows.filter((r) => r.definition !== 'approved')) {
      const delta = approved.total - other.total;
      const ratio = other.total > 0 ? (approved.total / other.total).toFixed(1) : 'n/a';
      say(`    vs ${other.definition.padEnd(12)} ${usd(other.total).padStart(12)} (n=${String(other.bookings).padStart(3)})   difference ${usd(delta)}  —  approved is ${ratio}x`);
    }
  }
  say('\n  The approved definition was reviewed and signed off before revenue routing was enabled.');

  // ── per-question replay ──
  hr('REPLAY');
  const results = [];
  for (const [i, q] of questions.entries()) {
    say(`\n[${i + 1}/${questions.length}] ${q.id}  "${q.question}"`);
    say(`      origin=${q.origin}  selfContained=${q.selfContained}  expectRoute=${q.expectRoute || 'null'}`);

    const rec = { id: q.id, question: q.question, origin: q.origin, selfContained: q.selfContained, expectRoute: q.expectRoute, expectMustNotRoute: q.expectMustNotRoute };

    if (!SKIP_CURRENT) {
      process.stdout.write('      CURRENT ...');
      rec.current = await runCurrent(q, pg);
      say('');
      say(`        total=${ms(rec.current.totalMs)}  modelCalls=${rec.current.modelCalls}  modelMs=${ms(rec.current.modelMs)}  rows=${rec.current.rowCount}`);
      say(`        retries(parse/sql) = ${rec.current.parseErrors}/${rec.current.sqlRetries}   escalations=${rec.current.escalations}  agentSteps=${rec.current.steps}`);
      if (rec.current.sql.length) rec.current.sql.forEach((s) => say(`        SQL: ${s}`));
      say(`        ANSWER: ${(rec.current.answer || rec.current.error || '(none)').replace(/\s+/g, ' ').slice(0, 300)}`);
    }

    rec.fact = await runFact(q, pg);
    if (!rec.fact.routed) {
      say(`        FACT    : declined — ${rec.fact.reason}`);
    } else if (rec.fact.integrity && !rec.fact.integrity.ok) {
      say(`        FACT    : ${rec.fact.metric} — MALFORMED FACTS (would have produced a wrong answer)`);
      for (const p of rec.fact.integrity.problems) say(`                   ! ${p}`);
    } else if (rec.fact.declines) {
      say(`        FACT    : ${rec.fact.metric} — DECLINED (${rec.fact.currencyGate ? rec.fact.currencyGate.reason : rec.fact.error})`);
    } else {
      say(`        FACT    : ${rec.fact.metric}  sql=${ms(rec.fact.sqlMs)}  narr=${ms(rec.fact.narrMs)}  total=${ms(rec.fact.totalMs)}  modelCalls=${rec.fact.modelCalls}`);
      say(`        SQL: ${String(rec.fact.sql).replace(/\s+/g, ' ').slice(0, 220)}`);
      say(`        FACTS: ${JSON.stringify(rec.fact.facts)}`);
      say(`        ANSWER: ${(rec.fact.answer || rec.fact.narrError || '(none)').replace(/\s+/g, ' ').slice(0, 300)}`);
    }

    // Routing verdict, scored against expectOutcome rather than expectRoute:
    //   fallthrough -> router must decline
    //   decline     -> router may claim it, but the fact layer must refuse
    //   answer      -> router must claim it AND the fact must produce a number
    const claimed = !!rec.fact.routed;
    const declined = !!(rec.fact.declines);
    const malformed = !!(rec.fact.integrity && !rec.fact.integrity.ok);
    // A model failure is not a routing error: the facts were sound, the narration
    // round-trip did not come back. Scoring it as UNSAFE would accuse the router
    // of a false positive it did not commit.
    const narrateFail = rec.fact.stage === 'narrate';
    const expected = q.expectOutcome || (q.expectRoute ? 'answer' : 'fallthrough');
    let verdict;
    if (malformed) {
      verdict = `MALFORMED (fact layer would have answered with wrong data: ${rec.fact.integrity.problems[0]})`;
    } else if (expected === 'fallthrough') {
      verdict = !claimed ? 'correct (falls through)' : 'UNSAFE (routed a question that must fall through)';
    } else if (expected === 'decline') {
      verdict = claimed && declined ? 'correct (claimed, then declined)' : !claimed ? 'MISS (never claimed; harmless)' : 'UNSAFE (claimed but answered)';
    } else if (narrateFail) {
      verdict = 'NARRATE_FAIL (facts were well-formed; the narration call failed — rerun)';
    } else {
      verdict = claimed && !declined ? 'correct (routed and answered)' : claimed ? 'UNSAFE (claimed but declined)' : 'MISS (not claimed; harmless)';
    }
    rec.routingVerdict = `${verdict}  [expected=${expected}]`;
    rec.claimed = claimed;
    rec.declined = declined;
    rec.malformed = malformed;
    if (!SKIP_CURRENT) {
      if (rec.current && rec.fact && rec.fact.answer) {
        rec.latencyDeltaMs = rec.current.totalMs - rec.fact.totalMs;
        rec.answerSimilar =
          rec.current.answer && rec.fact.answer
            ? rec.current.answer.replace(/\s+/g, ' ').trim() === rec.fact.answer.replace(/\s+/g, ' ').trim()
            : false;
      }
    }
    say(`        VERDICT: ${rec.routingVerdict}`);
    results.push(rec);
  }

  await pg.end();

  // ── summary ──
  hr('SUMMARY');
  const curRows = results.filter((r) => r.current);
  if (curRows.length) {
    const totalLat = curRows.reduce((a, r) => a + r.current.totalMs, 0);
    const totalCalls = curRows.reduce((a, r) => a + r.current.modelCalls, 0);
    const totalRetries = curRows.reduce((a, r) => a + r.current.parseErrors + r.current.sqlRetries, 0);
    const esc = curRows.reduce((a, r) => a + r.current.escalations, 0);
    say(`baseline latency  : total ${(totalLat / 1000).toFixed(1)}s over ${curRows.length} questions, mean ${(totalLat / curRows.length / 1000).toFixed(1)}s, max ${(Math.max(...curRows.map((r) => r.current.totalMs)) / 1000).toFixed(1)}s`);
    say(`model calls       : ${totalCalls} total, ${(totalCalls / curRows.length).toFixed(2)} per question`);
    say(`SQL retries       : ${totalRetries} total (parse-format ${curRows.reduce((a, r) => a + r.current.parseErrors, 0)}, sql-failure ${curRows.reduce((a, r) => a + r.current.sqlRetries, 0)})`);
    say(`agent escalations : ${esc}`);
    say(`\nper-question:`);
    for (const r of curRows) {
      say(`  ${r.id.padEnd(22)} ${ms(r.current.totalMs)}  calls=${String(r.current.modelCalls).padStart(2)}  retries=${String(r.current.parseErrors + r.current.sqlRetries).padStart(2)}  esc=${r.current.escalations}  ${r.question.slice(0, 44)}`);
    }
  }

  const both = results.filter((r) => r.current && r.fact && r.fact.answer);
  if (both.length) {
    const c = both.reduce((a, r) => a + r.current.totalMs, 0);
    const f = both.reduce((a, r) => a + r.fact.totalMs, 0);
    const cc = both.reduce((a, r) => a + r.current.modelCalls, 0);
    const fc = both.reduce((a, r) => a + r.fact.modelCalls, 0);
    say(`\nold vs new, on the ${both.length} question(s) the router claims:`);
    say(`  current path : ${(c / 1000).toFixed(1)}s total, ${cc} model calls, ${(cc / both.length).toFixed(2)}/question`);
    say(`  fact path    : ${(f / 1000).toFixed(1)}s total, ${fc} model calls, ${(fc / both.length).toFixed(2)}/question`);
    say(`  saving       : ${(100 - (f / c) * 100).toFixed(0)}% wall-clock, ${(100 - (fc / cc) * 100).toFixed(0)}% fewer model calls`);
    say(`  identical answer text: ${both.filter((r) => r.answerSimilar).length}/${both.length} (wording will differ; NUMBERS must be compared by hand)`);
  }

  say(`\nrouting verdicts (expected: answer | decline | fallthrough):`);
  const miss = (r) => r.routingVerdict.startsWith('MISS');
  const unsafe = (r) => r.routingVerdict.startsWith('UNSAFE');
  const bad = (r) => r.routingVerdict.startsWith('MALFORMED');
  const narrateFailed = (r) => r.routingVerdict.startsWith('NARRATE_FAIL');
  const missed = results.filter(miss);
  const unsafeRows = results.filter(unsafe);
  const malformedRows = results.filter(bad);
  const narrateFailRows = results.filter(narrateFailed);
  const clean = results.length - missed.length - unsafeRows.length - malformedRows.length - narrateFailRows.length;
  say(`  correct      : ${clean}/${results.length}`);
  say(`  NARRATE_FAIL (facts fine, model call failed): ${narrateFailRows.length}${narrateFailRows.length ? ' → ' + narrateFailRows.map((r) => `${r.id} (${r.fact.error})`).join(', ') : ''}`);
  say(`  MISS (false negative — falls through to the SQL agent, harmless): ${missed.length}${missed.length ? ' → ' + missed.map((r) => r.id).join(', ') : ''}`);
  say(`  UNSAFE (false positive — a question that must fall through was claimed): ${unsafeRows.length}${unsafeRows.length ? '\n      → ' + unsafeRows.map((r) => `${r.id} "${r.question}" [expected ${r.expectOutcome || r.expectRoute}]`).join('\n      → ') : ''}`);
  say(`  MALFORMED (fact layer returned undefined fields — would answer wrongly): ${malformedRows.length}${malformedRows.length ? '\n      → ' + malformedRows.map((r) => `${r.id} "${r.question}" — ${r.fact.integrity.problems[0]}`).join('\n      → ') : ''}`);

  say(`\nsafe to route deterministically (claimed + answered + facts well-formed):`);
  for (const r of results.filter((x) => x.claimed && !x.declined)) {
    const lat = r.current && r.fact ? `${r.fact.totalMs}ms (was ${r.current.totalMs}ms)` : `${r.fact.totalMs}ms`;
    say(`  ${r.id.padEnd(24)} ${String(r.fact.metric).padEnd(10)} ${lat.padEnd(24)} ${r.question.slice(0, 46)}`);
  }
  say(`\nclaimed then declined at the fact layer (correct refusal):`);
  for (const r of results.filter((x) => x.claimed && x.declined)) {
    const why = r.malformed
      ? `MALFORMED FACTS: ${r.fact.integrity.problems.join('; ')}`
      : (r.fact.currencyGate && r.fact.currencyGate.reason) || r.fact.error || '—';
    say(`  ${r.id.padEnd(24)} ${String(why).slice(0, 90)}`);
  }
  say(`\nnever claimed — these keep going to the existing MiMo SQL agent:`);
  for (const r of results.filter((x) => !x.claimed)) {
    const why = r.expectMustNotRoute || r.fact.reason || '—';
    say(`  ${r.id.padEnd(24)} ${String(why).slice(0, 78)}`);
  }

  say(`\nnumber agreement (old path answer vs fact layer) — read these by hand:`);
  for (const r of results.filter((x) => x.current && x.fact && x.fact.answer)) {
    const nums = (s) => (String(s || '').match(/\$?[\d,]+\.?\d*/g) || []).map((n) => n.replace(/[$,]/g, '')).filter((n) => n && n !== '0');
    const a = nums(r.current.answer);
    const b = nums(r.fact.answer);
    const shared = a.filter((n) => b.includes(n));
    const agree = a.length > 0 && a.length === b.length && shared.length === a.length;
    say(`  ${agree ? 'AGREE  ' : 'DIFFER '} ${r.id.padEnd(24)} old=[${a.join(' ')}]  fact=[${b.join(' ')}]`);
    if (!agree) {
      say(`         old  : ${String(r.current.answer).replace(/\s+/g, ' ').slice(0, 150)}`);
      say(`         fact : ${String(r.fact.answer).replace(/\s+/g, ' ').slice(0, 150)}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), currencyAudit: cur, revenueAudit: revAudit, results }, null, 2));
  say(`\nJSON artifact: ${OUT}`);
  return results;
}

// Exported so the harness's own logic can be regression-tested without a
// database or a model (see __tests__/unit/replayHarness.test.js). The script
// only runs its main flow when executed directly.
module.exports = { runFact, runCurrent, revenueDefinitionAudit, currencyAudit, REVENUE_AUDIT_DEFINITIONS };

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      fs.writeSync(1, `\nFATAL: ${e && e.stack ? e.stack : e}\n`);
      process.exit(1);
    });
}
