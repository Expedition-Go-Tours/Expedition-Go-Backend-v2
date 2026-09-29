/**
 * metricDefinitions.js — authoritative business-metric semantics.
 *
 * Single source of truth for what the numbers the Discord bot reports actually
 * mean. Every definition here was reviewed and approved by the business owner;
 * none of them may be changed silently, and none may be copied from another
 * subsystem's assumptions.
 *
 * Why this file exists: the Phase 0 replay showed the bot answering the SAME
 * question two different ways across two runs — "total revenue for the past
 * week" returned $604.00 and then $105.00, because the model picked a different
 * status filter each time. The digest and the bot also disagreed, and the
 * digest's own definition silently dropped completed revenue from period
 * totals. Definitions that live inside a prompt cannot be enforced. These live
 * in code instead.
 *
 * ── Approved definitions (do not re-derive) ──────────────────────────────
 *
 * 1. REVENUE
 *    Revenue = SUM(Booking.total) WHERE status IN ('CONFIRMED','COMPLETED')
 *              AND isSimulated = false      (EVERY window, period included)
 *    Rationale: 71% of all bookings (87 of 122, $11,981.39) are seed data from
 *    a single day (2026-08-26) and are flagged isSimulated. They are not real
 *    demand and must never enter a business figure. Restricting the filter to
 *    all-time made the SAME intent inconsistent across wording: "revenue for the
 *    past month" (the previous calendar month, which contains the seed day)
 *    reported $12,072.28 of which 99.2% was simulated, while "revenue for the
 *    past 30 days" reported $4,995.14. Excluding simulated from every window
 *    makes those agree, and matches how the rest of the platform already reads
 *    Booking (financeController, adminController and the analytics controllers
 *    all set isSimulated = false unconditionally).
 *    REJECTED: dailyDigest's `status = 'CONFIRMED' AND isSimulated = false`.
 *    That excludes COMPLETED bookings, so revenue disappears from a period
 *    total once a tour is fulfilled. Measured cost: it reports $105.00 for the
 *    last 30 days where the approved definition reports $4,995.14.
 *
 *    The same exclusion applies to every Booking-derived fact (revenue, top
 *    tours, booking counts, booking customers): a count that includes seed rows
 *    next to a total that does not would be the same incoherence in a new place.
 *
 * 2. CUSTOMERS
 *    customers         = users holding the `customer` role
 *    bookingCustomers  = distinct users who have at least one Booking
 *    users             = all User rows
 *    Measured on 2026-09-29: 52 / 26 / 91. These are three different, equally
 *    defensible numbers. The facts layer must not substitute one for another,
 *    so each has its own metric id.
 *
 * 3. TOP TOURS
 *    Revenue-oriented tour rankings read Booking.paidAt (when money was actually
 *    taken) with calendar-month semantics, never createdAt. "Tours created" is a
 *    separate future metric with its own id; the two are never mixed in one
 *    query.
 *
 * 4. WINDOWS
 *    A question naming no window is an ALL-TIME question, and the answer must
 *    say so explicitly ("All-time revenue is ..."). The narration system prompt
 *    in businessFacts.js enforces that.
 *
 * ── Currency ─────────────────────────────────────────────────────────────
 * Every money metric is grouped by currency and never summed across currencies.
 * Today only USD exists, but a single flat total would silently corrupt itself
 * the moment a second currency is added.
 *
 * @module services/metricDefinitions
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Booking statuses that count as recognised revenue. */
const REVENUE_STATUSES = Object.freeze(['CONFIRMED', 'COMPLETED']);

/** Seed bookings are excluded from every Booking-derived figure (note 1). */
const EXCLUDE_SIMULATED = true;

/**
 * The WHERE fragment that drops seed bookings.
 *
 * Booking rows are always aliased `b` in the fact queries, so this fragment is
 * reusable and cannot drift between metrics.
 */
const SIMULATED_BOOKING_CLAUSE = '"b"."isSimulated" = false';

/** The `UserRole` value that makes a user a "customer". */
const CUSTOMER_ROLE = 'customer';

/**
 * Top-tour revenue rankings read when the money was taken, not when the order
 * was created. Mixing the two was the defect found in Phase 0.
 */
const TOP_TOURS_DATE_COLUMN = 'paidAt';

/** Format a monetary amount the same way the daily digest does. */
function money(n, currency = 'USD') {
  // undefined or a non-numeric value means the figure was never there (a
  // missing or mis-aliased column). It must not be formatted as "$0.00".
  if (n === undefined) return null;
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  const amount = value.toFixed(2);
  // USD is the default and the only currency in use; anything else is prefixed
  // rather than assumed, so a non-USD total can never read as dollars.
  return currency && currency !== 'USD' ? `${currency} ${amount}` : `$${amount}`;
}

// ── Time windows ───────────────────────────────────────────────────────────
// Two semantics, chosen by how the operator words the window (approved):
//   - NAMED periods ("this week", "last month", "this quarter", "yesterday")
//     are CALENDAR-ALIGNED to UTC midnight, matching dailyDigest.js's
//     utcDayStart(), so a figure reported today can be re-derived tomorrow.
//   - EXPLICIT counts ("the past 7 days", "last 3 weeks") are ROLLING: N×24h
//     ending now. "the last 30 days" is a duration, not a calendar month, and an
//     operator saying it means a moving 30-day window.
// Mixing the two is what produced "$4,995.14 for the past 30 days" next to
// "$12,072.28 for the past month" in the Phase 1 review.

/** Midnight UTC of the day offsetDays from today. */
function utcDayStart(offsetDaysFromToday = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDaysFromToday);
  return d;
}

/** Midnight UTC on the given date. */
function utcDateStart(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Midnight UTC of the Monday starting the week containing `date`. */
function utcWeekStart(date = new Date()) {
  const d = utcDateStart(date);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

/** Midnight UTC on the 1st of the month containing `date`. */
function utcMonthStart(date = new Date()) {
  const d = utcDateStart(date);
  d.setUTCDate(1);
  return d;
}

/** Midnight UTC on the 1st of the calendar quarter containing `date`. */
function utcQuarterStart(date = new Date()) {
  const d = utcMonthStart(date);
  d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3);
  return d;
}

/** Midnight UTC on 1 January of the year containing `date`. */
function utcYearStart(date = new Date()) {
  return utcDateStart(new Date(Date.UTC(date.getUTCFullYear(), 0, 1)));
}

/**
 * Phrases ordered most-specific first. Each entry returns an absolute
 * {from, to} window rather than a day count, so calendar semantics are explicit
 * and testable instead of being recomputed ad hoc by every caller.
 *
 * The convention throughout:
 *   - "this X"  = the calendar period in progress, from its first day up to
 *                 and including today (exclusive end at tomorrow's midnight).
 *   - "last X" / "past X" (named) = the immediately PRECEDING complete calendar
 *                 period, which is what an operator comparing period-on-period
 *                 means. Anchored, so a quoted figure can be re-derived exactly.
 *   - "past N days" / "past N weeks" = a ROLLING N×24h / N×7×24h ending now.
 *
 * Each factory receives (match, ref) where `ref` is the injected reference
 * date, so tests are deterministic.
 */
const WINDOW_PHRASES = [
  // ── days ──
  [/\btoday\b/, (_m, ref) => ({ from: utcDayStartOf(ref, 0), to: utcDayStartOf(ref, 1), label: 'today' })],
  [/\byesterday\b/, (_m, ref) => ({ from: utcDayStartOf(ref, -1), to: utcDayStartOf(ref, 0), label: 'yesterday' })],
  // "the past 3 days" is a ROLLING 3×24h ending now, not a calendar span.
  // Ordered BEFORE the named week/month entries so "the past 30 days" is not
  // captured by "past month".
  [/\b(?:past|last)\s+(\d+)\s*days?\b/, (m, ref) => {
    const n = Math.max(Number(m[1]), 1);
    return { from: new Date(ref.getTime() - n * DAY_MS), to: new Date(ref), label: `the past ${n} day${n === 1 ? '' : 's'}` };
  }],
  [/\b(?:past|last)\s+(\d+)\s*weeks?\b/, (m, ref) => {
    const n = Math.max(Number(m[1]), 1);
    return { from: new Date(ref.getTime() - n * 7 * DAY_MS), to: new Date(ref), label: `the past ${n} week${n === 1 ? '' : 's'}` };
  }],

  // ── weeks ──
  [/\bthis\s+week\b/, (_m, ref) => ({ from: utcWeekStart(ref), to: utcDayStartOf(ref, 1), label: 'this week' })],
  [/\b(?:past|last)\s+week\b/, (_m, ref) => ({
    from: utcWeekStart(utcDayStartOf(ref, -7)),
    to: utcWeekStart(ref),
    label: 'the previous week',
  })],

  // ── months ──
  [/\bthis\s+month\b/, (_m, ref) => ({ from: utcMonthStart(ref), to: utcDayStartOf(ref, 1), label: 'this month' })],
  [/\b(?:past|last)\s+month\b/, (_m, ref) => ({
    from: utcMonthStart(utcMonthStart(ref) - 1),
    to: utcMonthStart(ref),
    label: 'the previous month',
  })],

  // ── quarters ──
  [/\bthis\s+quarter\b/, (_m, ref) => ({ from: utcQuarterStart(ref), to: utcDayStartOf(ref, 1), label: 'this quarter' })],
  [/\b(?:past|last)\s+quarter\b/, (_m, ref) => ({
    from: utcQuarterStart(utcQuarterStart(ref) - 1),
    to: utcQuarterStart(ref),
    label: 'the previous quarter',
  })],

  // ── years ──
  [/\bthis\s+year\b/, (_m, ref) => ({ from: utcYearStart(ref), to: utcDayStartOf(ref, 1), label: 'this year' })],
  [/\b(?:past|last)\s+year\b/, (_m, ref) => ({
    from: utcYearStart(new Date(Date.UTC(ref.getUTCFullYear() - 1, 0, 1))),
    to: utcYearStart(ref),
    label: 'the previous year',
  })],
];

/**
 * Midnight UTC of the day `offsetDays` from the reference date.
 *
 * Distinct from utcDayStart(offset), which always measures from TODAY. Taking
 * a reference date is what makes a window reproducible under test and what
 * allows "last week" to be derived from "this week" rather than guessed.
 */
function utcDayStartOf(ref, offsetDays = 0) {
  const d = new Date(ref);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

/**
 * Resolve a question's time window.
 *
 * A question naming no window resolves to ALL TIME (approved decision 4) and
 * is flagged so the answer can state that explicitly. Callers must not invent a
 * default period, which is how the digest and the bot came to disagree.
 *
 * @param {string} question
 * @param {Date}   [now] reference date, injectable for deterministic tests
 * @returns {{from: Date|null, to: Date|null, label: string, isAllTime: boolean, statedIn: boolean}}
 *          from === null means unbounded (all time).
 */
function resolveWindow(question, now = new Date()) {
  const q = String(question || '').toLowerCase();
  const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  for (const [re, make] of WINDOW_PHRASES) {
    const m = q.match(re);
    if (m) {
      const w = make(m, ref);
      return { ...w, isAllTime: false, statedIn: true };
    }
  }
  return { from: null, to: null, label: 'all time', isAllTime: true, statedIn: false };
}

/**
 * The money-defining WHERE clauses for a revenue fact.
 *
 * The simulated exclusion applies to EVERY window (see header note 1), so this
 * helper needs no window argument: revenue's status semantics are currently
 * window-independent.
 *
 * @returns {{clauses: string[], note: string}}
 */
function revenueClauses() {
  const clauses = [`"b"."status" IN (${REVENUE_STATUSES.map((s) => `'${s}'`).join(',')})`];
  let note = `status IN (${REVENUE_STATUSES.join(', ')})`;
  if (EXCLUDE_SIMULATED) {
    clauses.push(SIMULATED_BOOKING_CLAUSE);
    note += ' and isSimulated = false';
  }
  return { clauses, note };
}

/**
 * The date-window clause for a fact, or nothing when all-time.
 *
 * Emits `?` placeholders, NOT `$N`. Placeholder numbering is the WHERE builder's
 * single responsibility: if this helper pre-numbered to `$1,$2` while a status
 * filter in the same query also claimed `$1`, Postgres receives a parameter that
 * is referenced twice and a bound value with no placeholder at all — the same
 * class of failure that silently emptied the compact schema earlier.
 *
 * @returns {{clause: string, params: Date[]}} clause has no leading AND; the
 *          builder joins fragments with AND.
 */
function windowClause(column, window) {
  if (!window || !window.from) return { clause: '', params: [] };
  return {
    clause: `${column} >= ? AND ${column} < ?`,
    params: [window.from, window.to],
  };
}

/**
 * Human-readable window phrase for the narration, e.g.
 * "all time" -> "All time", "the past 7 days" -> "The past 7 days".
 */
function describeWindow(window) {
  if (!window) return 'All time';
  if (window.isAllTime) return 'All time';
  const l = String(window.label || '');
  return l.charAt(0).toUpperCase() + l.slice(1);
}

module.exports = {
  DAY_MS,
  REVENUE_STATUSES,
  EXCLUDE_SIMULATED,
  SIMULATED_BOOKING_CLAUSE,
  CUSTOMER_ROLE,
  TOP_TOURS_DATE_COLUMN,
  money,
  utcDayStart,
  utcDayStartOf,
  utcDateStart,
  utcWeekStart,
  utcMonthStart,
  utcQuarterStart,
  utcYearStart,
  resolveWindow,
  WINDOW_PHRASES,
  revenueClauses,
  windowClause,
  describeWindow,
};
