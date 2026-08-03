/**
 * Audit / backfill legacy `schedulesAndPricing` pricing data.
 *
 * Identifies tours whose stored prices are unsafe for the live checkout path:
 * non-numeric or non-finite `retailPrice` values (the source of the
 * `buildPriceIdConstraint` numeric-cast crash), zero/negative prices, missing
 * pricing schedules, and missing/invalid currency codes.
 *
 * Read-only by default. Pass `--fix` to sanitize in place:
 *   - numeric-string prices are coerced to numbers (clamped to [0, MAX_PRICE]);
 *   - garbage that cannot be coerced is set to null (publish-time validation
 *     will then require the supplier to fix it — null never reaches SQL casts);
 *   - an empty `pricingSchedules.currency` is backfilled from a valid fallback
 *     declared elsewhere in the same blob.
 *
 * Usage:
 *   node scripts/auditTourPricing.js [--fix] [--tour=<tourId>]
 */

const prisma = require('../utils/prismaClient');
const { MAX_PRICE, isValidCurrencyCode, normalizeCurrency } = require('../utils/currencyCodes');

const FIX = process.argv.includes('--fix');
const ONLY_TOUR = process.argv.find((a) => a.startsWith('--tour='))?.split('=')[1] || null;

const CHANGES = { tours: 0, pricesCoerced: 0, pricesNulled: 0, currencyBackfilled: 0 };
const ISSUES = {};

function countIssue(type, detail) {
  if (!ISSUES[type]) ISSUES[type] = [];
  if (ISSUES[type].length < 50) ISSUES[type].push(detail);
}

function toFinitePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampPrice(value) {
  const n = toFinitePrice(value);
  if (n == null) return null;
  return Math.min(Math.max(n, 0), MAX_PRICE);
}

function priceIssue(value) {
  if (value === null || value === undefined || value === '') return 'required';
  const n = toFinitePrice(value);
  if (n == null) return 'invalid';
  if (n > MAX_PRICE) return 'max';
  if (n <= 0) return 'positive';
  return null;
}

function parseBlob(blob) {
  if (blob == null) return null;
  if (typeof blob === 'string') {
    try { return JSON.parse(blob); } catch { return null; }
  }
  return blob;
}

function declaredCurrencies(blob) {
  const codes = [];
  const ps = blob?.pricingSchedules;
  if (ps?.currency != null && ps.currency !== '') codes.push(ps.currency);
  if (blob?.currency != null && blob.currency !== '') codes.push(blob.currency);
  if (Array.isArray(ps?.schedules)) {
    for (const s of ps.schedules) {
      if (s?.currency != null && s.currency !== '') codes.push(s.currency);
    }
  }
  return codes;
}

function auditTour(tour) {
  const ctx = `[${tour.id}] ${tour.title}`;
  const blob = parseBlob(tour.schedulesAndPricing);

  if (!blob || typeof blob !== 'object') {
    countIssue('unparseable-blob', `${ctx} — schedulesAndPricing missing or unparseable`);
    return { changed: false, blob };
  }

  const ps = blob.pricingSchedules || {};
  const schedules = Array.isArray(ps.schedules) ? ps.schedules : [];
  if (schedules.length === 0) {
    countIssue('no-schedules', `${ctx} — no pricing schedules`);
  }

  // Prices declared in the schedule rows (what buildPriceIdConstraint reads).
  let changed = false;
  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    if (!s || typeof s !== 'object') continue;
    if (!Array.isArray(s.prices)) continue;

    for (let j = 0; j < s.prices.length; j++) {
      const p = s.prices[j];
      if (!p || typeof p !== 'object') continue;
      const issue = priceIssue(p.retailPrice);
      if (!issue) continue;

      const where = `schedule ${i + 1} price ${j + 1} (${p.ageGroup || p.label || '?'})`;
      const value = typeof p.retailPrice === 'string' ? `"${p.retailPrice}"` : String(p.retailPrice);
      countIssue(`price:${issue}`, `${ctx} — ${where} retailPrice=${value}`);

      if (FIX) {
        if (issue === 'invalid') {
          p.retailPrice = null;
          CHANGES.pricesNulled += 1;
        } else {
          const clamped = clampPrice(p.retailPrice);
          if (clamped !== p.retailPrice) {
            p.retailPrice = clamped;
            CHANGES.pricesCoerced += 1;
          }
        }
        changed = true;
      }
    }
  }

  // Currency: authoritative pricingSchedules.currency, else a valid fallback.
  const codes = declaredCurrencies(blob);
  const validCode = codes.find((c) => isValidCurrencyCode(normalizeCurrency(c)));
  if (!validCode) {
    countIssue('no-currency', `${ctx} — no valid ISO 4217 currency declared`);
  } else if (ps.currency == null || ps.currency === '') {
    countIssue('currency-missing-at-pricingSchedules', `${ctx} — pricingSchedules.currency empty`);
    if (FIX) {
      ps.currency = validCode;
      CHANGES.currencyBackfilled += 1;
      changed = true;
    }
  }

  return { changed, blob };
}

async function main() {
  const where = ONLY_TOUR ? { id: ONLY_TOUR } : {};
  const tours = await prisma.tour.findMany({
    where,
    select: { id: true, title: true, status: true, schedulesAndPricing: true },
  });

  console.log(`Auditing ${tours.length} tour${tours.length === 1 ? '' : 's'} (fix: ${FIX ? 'ON' : 'OFF'})...\n`);

  for (const tour of tours) {
    const { changed, blob } = auditTour(tour);
    if (changed && FIX) {
      await prisma.tour.update({
        where: { id: tour.id },
        data: { schedulesAndPricing: blob },
      });
      CHANGES.tours += 1;
    }
  }

  console.log('--- Issues found ---');
  const keys = Object.keys(ISSUES);
  if (keys.length === 0) {
    console.log('None. All tours have parseable pricing with finite, in-range prices and a currency.');
  }
  for (const key of keys.sort()) {
    console.log(`\n[${key}] (${ISSUES[key].length}${ISSUES[key].length >= 50 ? '+' : ''})`);
    for (const detail of ISSUES[key]) console.log(`  ${detail}`);
  }

  console.log('\n--- Changes ---');
  console.log(`  tours updated         : ${CHANGES.tours}`);
  console.log(`  prices coerced to num : ${CHANGES.pricesCoerced}`);
  console.log(`  garbage prices -> null: ${CHANGES.pricesNulled}`);
  console.log(`  currency backfilled   : ${CHANGES.currencyBackfilled}`);

  if (!FIX && keys.length > 0) {
    console.log('\nRun with --fix to sanitize the offending values (review first).');
  }

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Audit failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
