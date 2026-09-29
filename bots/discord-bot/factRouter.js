/**
 * factRouter.js — deterministic question → metric router.
 *
 * Zero model calls. This is a plain rule matcher, on purpose: an LLM router
 * would add a 12–20s round-trip purely to choose between a deterministic fact
 * and the SQL agent, which is the exact latency this layer exists to remove. It
 * also introduces a new failure mode — a wrong verdict either answers a complex
 * question with an over-simplified fact, or adds latency and no benefit.
 *
 * The design priority is therefore ASYMMETRIC RISK:
 *   - A false negative (declining a question we could have answered) is harmless:
 *     it falls through to the existing, capable MiMo SQL agent. The user just
 *     gets the old behaviour.
 *   - A false positive (answering a question the fact layer does not actually
 *     cover) hands the user a confident wrong number. This is the failure the
 *     routing rules below work hardest to prevent.
 *
 * Every metric's numbers come from src/core/services/metricDefinitions.js. This
 * file only decides WHICH metric applies and with what qualifiers; it never
 * interprets what a number means.
 *
 * @module bots/discord-bot/factRouter
 */

const { resolveWindow, CUSTOMER_ROLE, TOP_TOURS_DATE_COLUMN } = require('../../src/core/services/metricDefinitions');

/**
 * Metrics that win outright when their phrase is present. Ordered so a more
 * specific phrase is tested before a broader one ("top tours by revenue" is a
 * ranking, not a revenue total).
 */
const SPECIFIC_RULES = [
  { metric: 'topTours', kw: ['top tour', 'best tour', 'top selling', 'best selling', 'best-selling', 'top 5 tour', 'top 10 tour', 'popular tour', 'leading tour', 'busiest tour'] },
  { metric: 'refunds', kw: ['refund', 'money back', 'chargeback', 'given back'] },
  { metric: 'disputes', kw: ['dispute', 'complaint', 'chargeback case'] },
  { metric: 'payouts', kw: ['payout', 'paid out', 'supplier payment', 'owed to supplier'] },
  { metric: 'reviews', kw: ['review', 'rating', 'star rating', 'feedback score'] },
  { metric: 'signups', kw: ['signup', 'sign up', 'sign-up', 'signed up', 'new user', 'registered', 'registration', 'new account'] },
];

/**
 * Metrics that only apply when they are the ONLY general match. A question
 * naming two of them ("revenue and bookings") is a composed question the facts
 * layer does not answer, rather than one silently half-answered.
 */
const GENERAL_RULES = [
  { metric: 'revenue', kw: ['revenue', 'sales', 'turnover', 'gross', 'how much money', 'made money', 'earned', 'income', 'take'] },
  { metric: 'tours', kw: ['tour', 'trip', 'experience', 'activity'] },
  { metric: 'suppliers', kw: ['supplier', 'vendor', 'partner'] },
  { metric: 'customers', kw: ['customer', 'client', 'buyer'] },
  { metric: 'bookings', kw: ['booking', 'reservation', 'order', 'trip sold'] },
  { metric: 'users', kw: ['user', 'account'] },
];

/**
 * Entity nouns that make the `signups` metric inapplicable.
 *
 * "signed up" is a verb, so "how many new suppliers signed up this month"
 * contains a signup keyword while actually asking about SUPPLIERS. Without this
 * the specific rule would win and answer a supplier-registration question with a
 * user-account count. When one of these nouns is present, `signups` stands down
 * and the general rules decide.
 */
const SIGNUP_SUBJECT_EXCLUSIONS = ['supplier', 'vendor', 'partner', 'tour', 'trip', 'experience', 'customer', 'client', 'buyer', 'booking', 'reservation', 'order'];

/**
 * Alternative "customer" populations, kept as distinct metrics so one is never
 * silently reported in place of another. See metricDefinitions header note 2:
 * measured 2026-09-29 as 52 customers / 26 booking customers / 91 users.
 */
const CUSTOMER_POPULATIONS = [
  { metric: 'bookingCustomers', kw: ['made a booking', 'made bookings', 'booked', 'has booked', 'have booked', 'placed an order', 'placed orders'] },
  { metric: 'users', kw: ['total users', 'all users', 'every user', 'number of users', 'user accounts'] },
];

/** Status words per metric, mapped to real Prisma enum values. */
const STATUS_TERMS = {
  tours: {
    live: 'ACTIVE', active: 'ACTIVE', approved: 'ACTIVE', published: 'ACTIVE', listing: 'ACTIVE',
    draft: 'DRAFT', pending: 'PENDING_APPROVAL', paused: 'PAUSED', archived: 'ARCHIVED', rejected: 'REJECTED',
  },
  suppliers: {
    active: 'ACTIVE', approved: 'APPROVED', pending: 'PENDING', review: 'UNDER_REVIEW',
    suspended: 'SUSPENDED', rejected: 'REJECTED', expired: 'EXPIRED',
  },
  disputes: {
    open: 'OPEN', unresolved: 'OPEN', pending: 'OPEN',
    resolved: 'RESOLVED_CUSTOMER', withdrawn: 'WITHDRAWN',
  },
  bookings: {
    confirmed: 'CONFIRMED', completed: 'COMPLETED', cancelled: 'CANCELLED',
    canceled: 'CANCELLED', refunded: 'REFUNDED', pending: 'PENDING',
  },
  payouts: { pending: 'PENDING', processing: 'PROCESSING', paid: 'PAID', failed: 'FAILED' },
};

/**
 * "How many NEW X" counts rows created in the window rather than filtering by
 * status. "new" must be followed by a space so it does not fire on "news".
 */
const NEW_ENTITY_MARKERS = ['new ', 'signed up', 'sign up', 'joined', 'added', 'created', 'registered'];

/**
 * Comparative, causal or otherwise analytical wording. A single deterministic
 * fact cannot answer these; they belong to the reasoning agent.
 */
const ANALYTICAL_MARKERS = [
  'why', 'explain', 'because', 'reason', 'cause', 'caused by', 'compare', 'comparison',
  'versus', ' vs ', 'difference', 'differ', 'trend', 'trending', 'pattern',
  'analyse', 'analyze', 'insight', 'drop', 'dropped', 'spike', 'surge',
  'increase', 'increased', 'decrease', 'decreased', 'improved', 'worse',
  'best month', 'worst month', 'breakdown by', 'who is to blame', 'outperform',
];

/** Wording that cannot be resolved without conversation history. */
const CONTEXTUAL_MARKERS = [
  'those', 'these', 'them', 'that one', 'the same', 'more about',
  'what about', 'previous', 'above', 'earlier', 'and then', 'as well as that',
  'you said', 'you mentioned', 'from before', 'again', 'one more',
];

/**
 * A bare count attached to a noun refers back to something already listed
 * ("details on the 4 bookings"). Without history there is no filter to apply.
 */
const BARE_COUNT_REFERENCE = /\b(?:on|for|of|about|with|to)\s+(?:the\s+)?\d+\b/i;

/** Currency words an operator might ask about. */
const CURRENCY_WORDS = /\b(usd|ghs|ghana cedis?|gbp|pounds?|euros?|eur|ngn|naira|zar|cad|aud)\b/;

/** Normalise a matched currency word to an ISO code. */
const CURRENCY_CODES = {
  usd: 'USD',
  ghs: 'GHS',
  'ghana cedi': 'GHS',
  'ghana cedis': 'GHS',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  ngn: 'NGN',
  naira: 'NGN',
  zar: 'ZAR',
  cad: 'CAD',
  aud: 'AUD',
};

/**
 * A preposition followed by a CAPITALISED token is a place qualifier
 * ("in Accra", "near Cape Coast").
 *
 * Checked against the ORIGINAL casing deliberately: that is what separates a
 * place from a lowercase qualifier such as "revenue in usd" or "bookings in the
 * past 7 days". The Phase 0 replay caught this case being routed to a GLOBAL
 * tour count, which would have answered "how many tours are in Accra" with the
 * platform-wide total.
 */
const PLACE_QUALIFIER = /\b(?:in|near|around|within|from|at|to)\s+[A-Z][a-z]+/;

/** A tour-ranking request must not ask for a time series of buckets. */
const MULTI_PERIOD_BUCKETS = /\bby\s+(month|week|day|hour|quarter|year|day of week)\b/;

/**
 * Feature gate for the deterministic facts path. DEFAULT OFF.
 *
 * Nothing calls this yet — the wiring into answerQuestion is Phase 2, and it
 * must only be enabled after the Phase 1 replay has been reviewed. The gate
 * exists now so the switch is a single, reversible env change rather than a code
 * edit at rollout time.
 *
 * Unset, empty, "false", "0" and anything else that is not exactly "true" all
 * mean OFF. That direction is deliberate: a typo or a missing variable can only
 * disable the new path, never enable it by accident.
 */
function factsEnabled(env = process.env) {
  return String(env.AI_FACTS_ENABLED || '').toLowerCase() === 'true';
}

/** Longest phrase first, so "top tours" is not captured as bare "tours". */
function matchSpecific(q) {
  const hit = SPECIFIC_RULES.find((r) => r.kw.some((k) => q.includes(k))) || null;
  // A signup word used as a VERB is not a signup question when the question is
  // actually about another entity. See SIGNUP_SUBJECT_EXCLUSIONS.
  if (hit && hit.metric === 'signups' && SIGNUP_SUBJECT_EXCLUSIONS.some((k) => q.includes(k))) {
    return null;
  }
  return hit;
}

function matchGeneral(q) {
  return GENERAL_RULES.filter((r) => r.kw.some((k) => q.includes(k)));
}

function matchCustomerPopulation(q) {
  for (const r of CUSTOMER_POPULATIONS) {
    if (r.kw.some((k) => q.includes(k))) return r;
  }
  return null;
}

/** Extract an explicit status filter, longest phrase winning. */
function extractStatus(metric, q) {
  const terms = STATUS_TERMS[metric];
  if (!terms) return null;
  const hit = Object.keys(terms).sort((a, b) => b.length - a.length).find((k) => q.includes(k));
  return hit ? terms[hit] : null;
}

/**
 * Route a question to a deterministic metric.
 *
 * @param {string} question
 * @param {{now?: Date}} [opts] `now` is injectable for deterministic tests.
 * @returns {{
 *   metric: string,
 *   window: ReturnType<typeof resolveWindow>,
 *   statusFilter: string|null,
 *   windowedCount: boolean,
 *   currencyFilter: string|null,
 *   customerRole: string|null,
 *   topToursDateColumn: string|null,
 *   selfContained: true
 * }|null} null means "fall through to the MiMo SQL agent".
 */
function routeToFact(question, opts = {}) {
  const raw = String(question || '');
  const q = raw.toLowerCase().trim();
  if (!q) return null;

  // ── 1. Context-dependent questions are never routed on their own text ──
  // "In usd", "what about those bookings", "details on the 4 bookings" all
  // depend on prior turns. Routing them would either guess the context or serve
  // a shared-cache answer to a private question.
  if (CONTEXTUAL_MARKERS.some((k) => q.includes(k))) return null;
  if (BARE_COUNT_REFERENCE.test(raw)) return null;

  // ── 2. Place qualifiers are not modelled by the deterministic metrics ──
  // City-vs-region semantics ("in Accra") are a tuned prompt rule in the SQL
  // agent. The tour count here is platform-wide and must not be substituted.
  if (PLACE_QUALIFIER.test(raw)) return null;

  // ── 3. Analytical questions need the reasoning agent ───────────────────
  if (ANALYTICAL_MARKERS.some((k) => q.includes(k))) return null;

  // ── 4. Time-series buckets are not a single metric ────────────────────
  if (MULTI_PERIOD_BUCKETS.test(q)) return null;

  // ── 5. Metric selection ───────────────────────────────────────────────
  const specific = matchSpecific(q);
  let metric = null;
  if (specific) {
    metric = specific.metric;
  } else {
    const population = matchCustomerPopulation(q);
    if (population) {
      metric = population.metric;
    } else {
      const general = matchGeneral(q);
      if (general.length !== 1) return null;
      metric = general[0].metric;
    }
  }

  // "customers" and "users" are ambiguous with no population qualifier. The
  // approved meaning of a bare "customers" is customer-role users, but a bare
  // "how many users" is the all-users population — and the two are not
  // interchangeable (52 vs 91), so each metric is only claimed on its own
  // unambiguous phrasing.
  if (metric === 'users' && !/users?\b/.test(q)) return null;
  if (metric === 'customers' && /\busers?\b/.test(q) && !/\bcustomers?\b/.test(q)) return null;

  // ── 6. Qualifiers ─────────────────────────────────────────────────────
  const statusFilter = extractStatus(metric, q);
  const windowedCount = !statusFilter && NEW_ENTITY_MARKERS.some((k) => q.includes(k));

  const currencyMatch = q.match(CURRENCY_WORDS);
  const currencyFilter = currencyMatch
    ? CURRENCY_CODES[currencyMatch[1]] || currencyMatch[1].toUpperCase()
    : null;

  return {
    metric,
    window: resolveWindow(raw, opts.now),
    statusFilter,
    windowedCount,
    currencyFilter,
    // A population metric states its own role filter rather than relying on the
    // metric implementation to pick one.
    customerRole: metric === 'customers' ? CUSTOMER_ROLE : null,
    // Top-tour revenue rankings always read when the money was taken.
    // See metricDefinitions header note 3.
    topToursDateColumn: metric === 'topTours' ? TOP_TOURS_DATE_COLUMN : null,
    selfContained: true,
  };
}

module.exports = {
  routeToFact,
  factsEnabled,
  // exported for tests and for documenting the supported surface
  SPECIFIC_RULES,
  GENERAL_RULES,
  CUSTOMER_POPULATIONS,
  STATUS_TERMS,
  SIGNUP_SUBJECT_EXCLUSIONS,
};
