/**
 * Pricing system edge-case + payload test.
 *
 * Exercises calculateTourPrice against the full matrix of pricing models,
 * fallbacks, restrictions and promotions, printing the request payload and the
 * returned payload for every scenario so you can see the dynamics. Also runs a
 * read-only pass against a real tour from the database (optional --tour=<id>).
 *
 * Usage:
 *   node scripts/testPricing.js [--tour=<tourId>]
 *
 * Exits non-zero if any assertion fails.
 */

const prisma = require('../utils/prismaClient');
const { calculateTourPrice } = require('../utils/tourHelpers');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function section(title) {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? `  ->  ${extra}` : ''}`);
  }
}

function dump(label, value) {
  const json = JSON.stringify(value, null, 2);
  console.log(`  ${label}:`);
  console.log(json.split('\n').map((l) => `    ${l}`).join('\n'));
}

function reqPayload(tour, travelers, date, extra = {}) {
  return { tourId: tour.id, travelDate: date, travelers, ...extra };
}

function weekday(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long' });
}

// ---------------------------------------------------------------------------
// Tour fixtures
// ---------------------------------------------------------------------------
const schedule = (dates, prices, extra = {}) => ({
  startDate: dates[0],
  endDate: dates[1] || null,
  prices,
  ...extra,
});

const price = (ageGroup, retailPrice) => ({ ageGroup, retailPrice });

function makeTour(id, blob) {
  return { id, schedulesAndPricing: blob };
}

function baseBlob(overrides = {}) {
  return {
    currency: 'USD',
    travelerDetails: {
      pricingModel: 'perPerson',
      pricingApproach: 'dependsOnAge',
      pricingCategories: [
        { name: 'Adult', price: 50 },
        { name: 'Child', price: 25 },
        { name: 'Infant', price: 0 },
      ],
    },
    pricingSchedules: {
      currency: 'USD',
      schedules: [
        schedule(['2026-01-01', '2026-12-31'], [
          price('Adult', 50),
          price('Child', 25),
          price('Infant', 0),
        ]),
      ],
    },
    promotions: [],
    ...overrides,
  };
}

const DATE_OK = '2026-06-15';

async function runSynthetic() {
  section('1. Synthetic pricing matrix');

  {
    // dependsOnAge from travelerDetails.pricingCategories
    const tour = makeTour('s-t1', baseBlob());
    const req = reqPayload(tour, { adults: 2, children: 1, infants: 1 }, DATE_OK);
    const res = await calculateTourPrice(tour, req.travelers, req.travelDate, null, null, null);
    dump('req', req);
    dump('res', res);
    check('2 adults + 1 child + 1 infant = 2*50 + 25 + 0 = 125', res.success && res.subtotal === 125, `subtotal=${res.subtotal}`);
    check('currency normalized USD', res.success && res.currency === 'USD', res.currency);
  }

  {
    // fallback to schedule.prices when travelerDetails has no categories
    const blob = baseBlob({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'dependsOnAge' },
    });
    const tour = makeTour('s-t2', blob);
    const res = await calculateTourPrice(tour, { adults: 1, children: 2 }, DATE_OK, null, null, null);
    dump('res', res);
    check('falls back to schedule prices: adult=50, child=25 -> 100', res.success && res.subtotal === 100, `subtotal=${res.subtotal}`);
  }

  {
    // sameForEveryone uniform price
    const blob = baseBlob({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: 40 },
    });
    const tour = makeTour('s-t3', blob);
    const res = await calculateTourPrice(tour, { adults: 2, children: 1 }, DATE_OK, null, null, null);
    dump('res', res);
    check('uniform price 40 x 3 = 120', res.success && res.subtotal === 120, `subtotal=${res.subtotal}`);
  }

  {
    // perGroup matching a group size band
    const blob = baseBlob({
      travelerDetails: {
        pricingModel: 'perGroup',
        groupSizes: [{ from: 2, to: 5, price: 300 }, { from: 6, to: 10, price: 550 }],
      },
    });
    const tour = makeTour('s-t4', blob);
    const res4 = await calculateTourPrice(tour, { adults: 4 }, DATE_OK, null, null, null);
    dump('res (party of 4)', res4);
    check('party of 4 -> group band 2-5 = 300', res4.success && res4.subtotal === 300, `subtotal=${res4.subtotal}`);

    const res10 = await calculateTourPrice(tour, { adults: 6 }, DATE_OK, null, null, null);
    dump('res (party of 6)', res10);
    check('party of 6 -> group band 6-10 = 550', res10.success && res10.subtotal === 550, `subtotal=${res10.subtotal}`);

    const res1 = await calculateTourPrice(tour, { adults: 1 }, DATE_OK, null, null, null);
    dump('res (party of 1)', res1);
    check('party of 1 (no matching band) fails closed', !res1.success, res1.error);

    const res0 = await calculateTourPrice(tour, { adults: 0 }, DATE_OK, null, null, null);
    dump('res (party of 0)', res0);
    check('party of 0 fails closed', !res0.success, res0.error);
  }

  {
    // date outside every schedule
    const tour = makeTour('s-t5', baseBlob({
      pricingSchedules: {
        currency: 'USD',
        schedules: [schedule(['2026-01-01', '2026-03-31'], [price('Adult', 50)])],
      },
    }));
    const res = await calculateTourPrice(tour, { adults: 2 }, '2026-06-15', null, null, null);
    dump('res', res);
    check('date with no applicable schedule fails closed', !res.success && /No pricing available/.test(res.error), res.error);
  }

  {
    // day-of-week restriction (lives on the price entry, read as prices[0].days)
    const tour = makeTour('s-t6', baseBlob({
      pricingSchedules: {
        currency: 'USD',
        schedules: [schedule(['2026-01-01', '2026-12-31'], [{ ageGroup: 'Adult', retailPrice: 50, days: ['Monday'] }])],
      },
    }));
    const mon = '2026-06-15';
    const wrongDay = weekday(mon) === 'Monday' ? '2026-06-17' : '2026-06-15';
    const resOk = await calculateTourPrice(tour, { adults: 1 }, mon, null, null, null);
    const resBad = await calculateTourPrice(tour, { adults: 1 }, wrongDay, null, null, null);
    dump('res (Monday)', resOk);
    dump('res (non-Monday)', resBad);
    check('Monday books fine', resOk.success, resOk.error);
    check('non-Monday blocked by days restriction', !resBad.success, resBad.error);
  }

  {
    // time restriction on the schedule
    const tour = makeTour('s-t7', baseBlob({
      pricingSchedules: {
        currency: 'USD',
        schedules: [schedule(['2026-01-01', '2026-12-31'], [{ ageGroup: 'Adult', retailPrice: 50, times: ['10:00'] }])],
      },
    }));
    const resOk = await calculateTourPrice(tour, { adults: 1 }, DATE_OK, '10:00', null, null);
    const resBad = await calculateTourPrice(tour, { adults: 1 }, DATE_OK, '14:00', null, null);
    dump('res (10:00)', resOk);
    dump('res (14:00)', resBad);
    check('10:00 books fine', resOk.success, resOk.error);
    check('14:00 blocked by times restriction', !resBad.success, resBad.error);
  }

  {
    // garbage schedule prices ignored when travelerDetails is authoritative
    const blob = baseBlob({
      pricingSchedules: {
        currency: 'USD',
        schedules: [schedule(['2026-01-01', '2026-12-31'], [price('Adult', 'garbage'), price('Child', 'N/A')])],
      },
    });
    const tour = makeTour('s-t8', blob);
    const res = await calculateTourPrice(tour, { adults: 2, children: 1 }, DATE_OK, null, null, null);
    dump('res', res);
    check('prices from travelerDetails despite garbage schedule prices', res.success && res.subtotal === 125, `subtotal=${res.subtotal}`);
  }

  {
    // numeric-string prices are coerced
    const blob = baseBlob({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'dependsOnAge' },
      pricingSchedules: {
        currency: 'USD',
        schedules: [schedule(['2026-01-01', '2026-12-31'], [price('Adult', '50.00'), price('Child', '25')])],
      },
    });
    const tour = makeTour('s-t9', blob);
    const res = await calculateTourPrice(tour, { adults: 1, children: 1 }, DATE_OK, null, null, null);
    dump('res', res);
    check('numeric strings coerced: 50 + 25 = 75', res.success && res.subtotal === 75, `subtotal=${res.subtotal}`);
  }

  {
    // empty travelers with uniform price (documented behavior)
    const blob = baseBlob({
      travelerDetails: { pricingModel: 'perPerson', pricingApproach: 'sameForEveryone', uniformPrice: 40 },
    });
    const tour = makeTour('s-t10', blob);
    const res = await calculateTourPrice(tour, {}, DATE_OK, null, null, null);
    dump('res (empty travelers)', res);
    check('empty travelers -> total 0 (no charge)', res.success && res.total === 0, JSON.stringify(res));
  }

  {
    // negative travelers ignored
    const tour = makeTour('s-t11', baseBlob());
    const res = await calculateTourPrice(tour, { adults: 2, children: -1 }, DATE_OK, null, null, null);
    dump('res (negative child)', res);
    check('negative traveler counts ignored: 2*50 = 100', res.success && res.subtotal === 100, `subtotal=${res.subtotal}`);
  }

  {
    // missing pricingSchedules blob
    const tour = makeTour('s-t12', { travelerDetails: {} });
    const res = await calculateTourPrice(tour, { adults: 1 }, DATE_OK, null, null, null);
    dump('res (no pricingSchedules)', res);
    check('missing pricingSchedules fails closed', !res.success && /No pricing information/.test(res.error), res.error);
  }

  {
    // percentage promotion 10%
    const blob = baseBlob({
      promotions: [{
        isActive: true,
        type: 'percentage',
        discountValue: 10,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    });
    const tour = makeTour('s-t13', blob);
    const res = await calculateTourPrice(tour, { adults: 2 }, DATE_OK, null, null, null);
    dump('res (10% promo on 100)', res);
    check('10% promo: subtotal 100, discount 10, total 90', res.success && res.subtotal === 100 && res.discount === 10 && res.total === 90,
      `subtotal=${res.subtotal} discount=${res.discount} total=${res.total}`);
  }

  {
    // fixedAmount promotion capped at subtotal (never negative)
    const blob = baseBlob({
      promotions: [{
        isActive: true,
        type: 'fixedAmount',
        discountValue: 9999,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    });
    const tour = makeTour('s-t14', blob);
    const res = await calculateTourPrice(tour, { adults: 2 }, DATE_OK, null, null, null);
    dump('res (fixedAmount 9999 on 100)', res);
    check('discount clamped to subtotal: total 0, discount 100', res.success && res.total === 0 && res.discount === 100,
      `subtotal=${res.subtotal} discount=${res.discount} total=${res.total}`);
  }

  {
    // inactive promotion is ignored
    const blob = baseBlob({
      promotions: [{
        isActive: false,
        type: 'percentage',
        discountValue: 50,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      }],
    });
    const tour = makeTour('s-t15', blob);
    const res = await calculateTourPrice(tour, { adults: 2 }, DATE_OK, null, null, null);
    dump('res (inactive promo)', res);
    check('inactive promotion ignored', res.success && res.discount === 0, `discount=${res.discount}`);
  }
}

async function runRealDynamics() {
  section('2. Real-tour pricing dynamics (read-only)');

  const tourIdArg = process.argv.find((a) => a.startsWith('--tour='))?.split('=')[1] || null;

  const realTours = tourIdArg
    ? await prisma.tour.findMany({ where: { id: tourIdArg }, select: { id: true, title: true, status: true, schedulesAndPricing: true } })
    : await prisma.tour.findMany({ where: { status: 'ACTIVE' }, select: { id: true, title: true, status: true, schedulesAndPricing: true }, take: 8 });

  if (realTours.length === 0) {
    console.log('  (no ACTIVE tour found in the database — skipping dynamics)');
    return;
  }

  for (const realTour of realTours) {
    const blob = realTour.schedulesAndPricing;
    const ps = blob?.pricingSchedules || {};
    const first = Array.isArray(ps.schedules) ? ps.schedules[0] : null;
    const date = first?.startDate;
    console.log(`\n  tour: ${realTour.title} [${realTour.id}] status=${realTour.status}`);

    const res = date
      ? await calculateTourPrice(realTour, { adults: 2, children: 1, infants: 1 }, date, null, null, null)
      : { success: false, error: 'No pricing schedules present' };

    if (res.success) {
      dump(`  res — family (2 adults + 1 child + 1 infant) @ ${date}`, res);
    } else {
      console.log(`  res — family @ ${date || '(no schedule)'} -> FAIL: ${res.error}`);
    }
  }
}

async function main() {
  await runSynthetic();
  await runRealDynamics();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Pricing: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Pricing test failed to run:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
