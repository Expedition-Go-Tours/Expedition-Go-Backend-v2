/**
 * Availability system edge-case + payload test.
 *
 * Covers:
 *   1. Real-tour calendar + checkTourAvailability dynamics (read-only).
 *   2. Synthetic edge cases through the authoritative in-transaction evaluator
 *      (evaluateBookingAvailability) — closed days, non-operating days, BLOCKED /
 *      FULL overrides, per-slot capacity, per-group caps, PENDING occupancy.
 *   3. End-to-end through the real stack: a temporary tour + overrides +
 *      bookings are seeded, exercised through buildAvailabilityCalendar and
 *      checkTourAvailability, then cleaned up.
 *
 * Every scenario prints its input payload and returned payload.
 *
 * Usage:
 *   node scripts/testAvailability.js [--tour=<tourId>]
 *
 * Exits non-zero if any assertion fails.
 */

const prisma = require('../utils/prismaClient');
const { checkTourAvailability } = require('../utils/tourHelpers');
const { buildAvailabilityCalendar } = require('../utils/availabilityCalendar');
const { evaluateBookingAvailability } = require('../utils/availabilityCore');

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

function futureDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

const DAYS_ALL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------------------
// 1. Real-tour dynamics (read-only)
// ---------------------------------------------------------------------------
async function runRealDynamics() {
  section('1. Real-tour availability dynamics (read-only)');

  const tourIdArg = process.argv.find((a) => a.startsWith('--tour='))?.split('=')[1] || null;
  const realTours = await prisma.tour.findMany({
    where: tourIdArg ? { id: tourIdArg } : { status: 'ACTIVE' },
    select: { id: true, title: true, status: true, schedulesAndPricing: true },
    take: 5,
  });

  if (realTours.length === 0) {
    console.log('  (no ACTIVE tour found — skipping dynamics)');
    return;
  }

  for (const tour of realTours) {
    console.log(`\n  tour: ${tour.title} [${tour.id}]`);
    const start = futureDate(1);
    const end = futureDate(14);
    const calendar = await buildAvailabilityCalendar(tour.id, tour.schedulesAndPricing, start, end);
    dump(`  calendar ${start}..${end}`, calendar);

    // Run checkTourAvailability against the first operating day with a slot.
    const operating = calendar.find((d) => d.isOperatingDay && d.status !== 'BLOCKED');
    if (operating) {
      const slot = operating.timeSlots[0]?.time || null;
      const res = await checkTourAvailability(tour.id, operating.date, {
        selectedTime: slot,
        travelers: { adults: 2 },
      });
      dump(`  checkTourAvailability(${operating.date}, slot=${slot}, 2 adults)`, res);
    } else {
      console.log('  (no operating day in the next 14 days)');
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Synthetic edge cases — evaluateBookingAvailability (fake db, no writes)
// ---------------------------------------------------------------------------
const perPersonTour = {
  id: 'e-t1',
  schedulesAndPricing: {
    availability: { daysOfWeek: DAYS_ALL, timeSlots: ['10:00', '14:00'] },
    travelerDetails: { maxParticipants: 10 },
  },
};

const perGroupTour = {
  id: 'e-t2',
  schedulesAndPricing: {
    availability: { daysOfWeek: DAYS_ALL, timeSlots: ['10:00'] },
    travelerDetails: { pricingModel: 'perGroup', maxGroupsPerTimeSlot: 3, maxParticipants: 4 },
  },
};

function fakeDb({ override = null, counts = [{ currentBookings: '0', groupCount: '0' }] } = {}) {
  return {
    tourDateOverride: { findFirst: async () => override },
    $queryRawUnsafe: async () => counts,
  };
}

async function runSyntheticEvaluator() {
  section('2. Synthetic edge cases — evaluateBookingAvailability');

  const DATE = futureDate(7); // any operating day (daysOfWeek = all)

  {
    const res = await evaluateBookingAvailability(fakeDb({ counts: [{ currentBookings: '2', groupCount: '0' }] }), perPersonTour, DATE, '10:00', { adults: 2 });
    dump('req/params', { tourId: perPersonTour.id, date: DATE, selectedTime: '10:00', travelers: { adults: 2 }, db: { override: null, counts: 2 } });
    dump('res', res);
    check('healthy day, 2 of 10 already booked, 2 more fit -> 8 left', res.ok && res.availableSpots === 8, JSON.stringify(res));
  }

  {
    const closedTour = {
      ...perPersonTour,
      schedulesAndPricing: {
        ...perPersonTour.schedulesAndPricing,
        availability: { ...perPersonTour.schedulesAndPricing.availability, dateExceptions: [{ type: 'closed', date: DATE }] },
      },
    };
    const res = await evaluateBookingAvailability(fakeDb(), closedTour, DATE, '10:00', { adults: 1 });
    dump('res (closed date)', res);
    check('closed date rejected', !res.ok && /not available on this date/.test(res.reason), res.reason);
  }

  {
    const mondayOnly = { ...perPersonTour, schedulesAndPricing: { ...perPersonTour.schedulesAndPricing, availability: { daysOfWeek: ['Monday'], timeSlots: ['10:00'] } } };
    const tue = '2026-06-16'; // a Tuesday
    const res = await evaluateBookingAvailability(fakeDb(), mondayOnly, tue, '10:00', { adults: 1 });
    dump('res (non-operating day)', res);
    check('non-operating day rejected', !res.ok && /not available on this date/.test(res.reason), res.reason);
  }

  {
    const res = await evaluateBookingAvailability(
      fakeDb({ override: { status: 'BLOCKED', capacity: 10, timeSlotOverrides: null } }),
      perPersonTour, DATE, '10:00', { adults: 1 }
    );
    dump('res (BLOCKED override)', res);
    check('BLOCKED override rejected', !res.ok && res.reason === 'Date is blocked', res.reason);
  }

  {
    const res = await evaluateBookingAvailability(
      fakeDb({ override: { status: 'FULL', capacity: 10, timeSlotOverrides: null } }),
      perPersonTour, DATE, '10:00', { adults: 1 }
    );
    dump('res (FULL override)', res);
    check('FULL override rejected', !res.ok && res.reason === 'Date is fully booked', res.reason);
  }

  {
    const res = await evaluateBookingAvailability(fakeDb(), perPersonTour, DATE, null, { adults: 1 });
    dump('res (no slot selected)', res);
    check('slot required when tour has slots', !res.ok && res.reason === 'A time slot must be selected', res.reason);
  }

  {
    const res = await evaluateBookingAvailability(fakeDb(), perPersonTour, DATE, '99:99', { adults: 1 });
    dump('res (invalid slot)', res);
    check('invalid slot rejected', !res.ok && /not available/.test(res.reason), res.reason);
  }

  {
    // Slot capacity is exhausted — including any PENDING rows that hold spots
    // until the payment webhook confirms or cancels them.
    const res = await evaluateBookingAvailability(
      fakeDb({ counts: [{ currentBookings: '10', groupCount: '0' }] }),
      perPersonTour, DATE, '10:00', { adults: 1 }
    );
    dump('res (10 of 10 booked incl. PENDING)', res);
    check('capacity exhausted (PENDING counts)', !res.ok && /Only 0 spots left/.test(res.reason), res.reason);
  }

  {
    const res = await evaluateBookingAvailability(
      fakeDb({ counts: [{ currentBookings: '8', groupCount: '0' }] }),
      perPersonTour, DATE, '10:00', { adults: 5 }
    );
    dump('res (party overflow)', res);
    check('party larger than remaining capacity rejected', !res.ok && /Only 2 spots left, but 5 requested/.test(res.reason), res.reason);
  }

  {
    // perGroup: all 3 group slots taken, but each only has 1 traveler.
    const res = await evaluateBookingAvailability(
      fakeDb({ counts: [{ currentBookings: '3', groupCount: '3' }] }),
      perGroupTour, DATE, '10:00', { adults: 1 }
    );
    dump('res (perGroup, all groups taken)', res);
    check('perGroup group cap rejected', !res.ok && res.reason === 'No group slots remaining for this time', res.reason);
  }

  {
    const res = await evaluateBookingAvailability(
      fakeDb({ counts: [{ currentBookings: '2', groupCount: '1' }] }),
      perGroupTour, DATE, '10:00', { adults: 2 }
    );
    dump('res (perGroup, 1 of 3 groups used)', res);
    check('perGroup success -> groupsRemaining 2', res.ok && res.groupsRemaining === 2 && res.isPerGroup, JSON.stringify(res));
  }

  {
    // Tour with no fixed slots -> whole-day capacity.
    const noSlots = { ...perPersonTour, schedulesAndPricing: { ...perPersonTour.schedulesAndPricing, availability: { daysOfWeek: DAYS_ALL } } };
    const res = await evaluateBookingAvailability(fakeDb({ counts: [{ currentBookings: '3', groupCount: '0' }] }), noSlots, DATE, null, { adults: 3 });
    dump('res (no-slot tour, day-level)', res);
    check('day-level capacity: 3 of 10 already booked, 3 more fit -> 7 left', res.ok && res.availableSpots === 7 && res.daySlots.length === 0, JSON.stringify(res));
  }
}

// ---------------------------------------------------------------------------
// 3. End-to-end through the real stack (temp tour + overrides + bookings, cleaned up)
// ---------------------------------------------------------------------------
async function runE2E() {
  section('3. E2E via seeded temp tour (real DB, cleaned up afterwards)');

  const supplier = await prisma.user.findFirst({ where: { roles: { has: 'supplier' } }, select: { id: true } });
  const customer = await prisma.user.findFirst({ where: { roles: { has: 'customer' } }, select: { id: true } });
  if (!supplier || !customer) {
    console.log('  (no supplier/customer users available — skipping E2E section)');
    return;
  }

  const opDay = futureDate(7);
  const blockedDay = futureDate(8);
  const fullDay = futureDate(9);
  const limitedDay = futureDate(12);
  const closedDay = futureDate(15);

  const blob = {
    currency: 'USD',
    travelerDetails: {
      pricingModel: 'perPerson',
      pricingApproach: 'dependsOnAge',
      maxParticipants: 10,
      pricingCategories: [{ name: 'Adult', price: 50 }],
    },
    pricingSchedules: {
      currency: 'USD',
      schedules: [{ startDate: '2026-01-01', endDate: '2026-12-31', prices: [{ ageGroup: 'Adult', retailPrice: 50 }] }],
    },
    availability: {
      daysOfWeek: DAYS_ALL,
      timeSlots: ['10:00', '14:00'],
      dateExceptions: [{ id: 'temp-close', type: 'closed', date: closedDay }],
    },
    promotions: [],
  };

  const ts = Date.now();
  let tourId = null;

  try {
    const tour = await prisma.tour.create({
      data: {
        supplierId: supplier.id,
        title: 'Availability Test Tour (temp)',
        description: 'Temporary tour created by scripts/testAvailability.js',
        photos: [],
        categorization: {},
        theme: {},
        productContent: {},
        schedulesAndPricing: blob,
        bookingAndTickets: {},
        slug: `availability-test-${ts}`,
        status: 'ACTIVE',
      },
    });
    tourId = tour.id;
    console.log(`  seeded temp tour: ${tour.title} [${tour.id}]`);

    await prisma.tourDateOverride.create({ data: { tourId, date: new Date(`${blockedDay}T00:00:00.000Z`), status: 'BLOCKED' } });
    await prisma.tourDateOverride.create({ data: { tourId, date: new Date(`${fullDay}T00:00:00.000Z`), status: 'FULL' } });
    await prisma.tourDateOverride.create({
      data: {
        tourId,
        date: new Date(`${limitedDay}T00:00:00.000Z`),
        status: 'LIMITED',
        capacity: 5,
        timeSlotOverrides: [{ time: '10:00', capacity: 4 }, { time: '14:00', capacity: 5 }],
      },
    });

    const mkBooking = async (num, travelers, status, paymentStatus, selectedTime) => {
      await prisma.booking.create({
        data: {
          bookingNumber: `AVTEST-${ts}-${num}`,
          customerId: customer.id,
          tourId,
          travelers,
          selectedDate: new Date(`${opDay}T00:00:00.000Z`),
          selectedTime,
          subtotal: 150,
          total: 150,
          currency: 'USD',
          commissionRate: 0.15,
          commissionAmount: 22.5,
          supplierPayout: 127.5,
          status,
          paymentStatus,
        },
      });
    };
    await mkBooking(1, { adults: 3 }, 'CONFIRMED', 'SUCCEEDED', '10:00');
    await mkBooking(2, { adults: 2 }, 'PENDING', 'PROCESSING', '10:00');
    console.log('  seeded 2 bookings on', opDay, '(3 CONFIRMED + 2 PENDING-in-payment @ 10:00)');

    // Calendar
    const calendar = await buildAvailabilityCalendar(tourId, blob, futureDate(5), futureDate(16));
    dump('  calendar', calendar);

    const byDate = (d) => calendar.find((c) => c.date === d);
    check('blocked override -> BLOCKED', byDate(blockedDay)?.status === 'BLOCKED', byDate(blockedDay)?.status);
    check('full override -> FULL', byDate(fullDay)?.status === 'FULL', byDate(fullDay)?.status);
    check('closed date -> BLOCKED + not operating', byDate(closedDay)?.status === 'BLOCKED' && byDate(closedDay)?.isOperatingDay === false,
      JSON.stringify(byDate(closedDay)));
    check('limited override capacity 5 honored', byDate(limitedDay)?.capacity === 5, byDate(limitedDay)?.capacity);
    check('limited override slots from timeSlotOverrides', byDate(limitedDay)?.timeSlots?.length === 2 && byDate(limitedDay).timeSlots[0].capacity === 4,
      JSON.stringify(byDate(limitedDay)?.timeSlots));
    check('operating day reflects bookings: 10:00 booked 5', byDate(opDay)?.timeSlots.find((s) => s.time === '10:00')?.booked === 5,
      JSON.stringify(byDate(opDay)?.timeSlots));

    // checkTourAvailability through the real stack
    const ok = await checkTourAvailability(tourId, opDay, { selectedTime: '10:00', travelers: { adults: 2 } });
    dump(`checkTourAvailability(${opDay}, 10:00, 2 adults)`, ok);
    check('real check: 5/10 used, 2 more fits', ok.available && ok.currentBookings === 5 && ok.availableSpots === 5, JSON.stringify(ok));

    const overflow = await checkTourAvailability(tourId, opDay, { selectedTime: '10:00', travelers: { adults: 6 } });
    dump(`checkTourAvailability(${opDay}, 10:00, 6 adults)`, overflow);
    check('real check: 6 adults overflows (only 5 left)', !overflow.available && /Only 5 spots left, but 6 requested/.test(overflow.reason), overflow.reason);

    const blocked = await checkTourAvailability(tourId, blockedDay, { selectedTime: '10:00', travelers: { adults: 1 } });
    dump(`checkTourAvailability(${blockedDay})`, blocked);
    check('real check: blocked override', !blocked.available && blocked.reason === 'Date is blocked', blocked.reason);

    const closed = await checkTourAvailability(tourId, closedDay, { selectedTime: '10:00', travelers: { adults: 1 } });
    dump(`checkTourAvailability(${closedDay})`, closed);
    check('real check: closed date', !closed.available && /not available on this date/.test(closed.reason), closed.reason);

    const slotOverflow = await checkTourAvailability(tourId, limitedDay, { selectedTime: '14:00', travelers: { adults: 6 } });
    dump(`checkTourAvailability(${limitedDay}, 14:00, 6 adults)`, slotOverflow);
    check('real check: override slot capacity 5 caps party of 6', !slotOverflow.available && /Only 5 spots left, but 6 requested/.test(slotOverflow.reason), slotOverflow.reason);
  } finally {
    if (tourId) {
      await prisma.booking.deleteMany({ where: { tourId } });
      await prisma.tourDateOverride.deleteMany({ where: { tourId } });
      await prisma.tour.delete({ where: { id: tourId } });
      console.log('  cleaned up temp tour + overrides + bookings');
    }
  }
}

async function main() {
  await runRealDynamics();
  await runSyntheticEvaluator();
  await runE2E();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Availability: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Availability test failed to run:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
