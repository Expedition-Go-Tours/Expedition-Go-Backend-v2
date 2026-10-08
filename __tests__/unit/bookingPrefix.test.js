/**
 * Booking reference prefix contract.
 *
 * TravioGhana bookings must be minted as `TRG-…`. Before this existed there
 * was ZERO coverage of the Ghana prefix, and the value was written in three
 * separate places — config/brands.js plus two hardcoded literals in
 * ghana/controller.js — so nothing noticed them disagreeing. Separately,
 * checkoutHold's fallbacks were `|| 'EXP'`, which is how a Ghana booking could
 * be born carrying the Expedition prefix at all: any hold created without an
 * explicit prefix, or any draft read before `_bookingPrefix` was written into
 * its payload, fell through to whichever brand the default's author had in mind.
 *
 * These tests pin three things:
 *   1. config says TRG, and TRG formats correctly
 *   2. the prefix is DERIVED from the booking source, never defaulted to a
 *      constant — proven by checking that a GHANA draft and an EXPEDITION
 *      draft resolve differently from identical inputs
 *   3. the Ghana controller reads BRAND.bookingPrefix instead of a literal,
 *      so the three copies cannot drift again
 */

jest.mock('../../src/core/services/queue', () => ({ enqueueEvent: jest.fn() }));

// checkoutHold records the checkout-start analytics directly via eventEmitter
// (never the queue — queued events were silently dropped during a Redis
// outage, which is exactly why the funnel went empty). Pin the direct write.
jest.mock('../../src/core/services/eventEmitter', () => ({ emit: jest.fn() }));

jest.mock('../../src/core/services/availabilityCore', () => ({
  evaluateBookingAvailability: jest.fn().mockResolvedValue({ ok: true }),
  travelerCount: jest.fn().mockReturnValue(2),
  parseBlob: jest.fn().mockReturnValue({}),
}));

// Capture the prefix rather than exercising the counter table here.
jest.mock('../../src/core/services/bookingHelpers', () => ({
  generateBookingNumber: jest.fn(async (prefix) => `${prefix}-MINTED`),
}));

jest.mock('../../src/core/services/prismaClient', () => {
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'tour-1' }]),
    checkoutDraft: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => ({ id: 'draft-1', expiresAt: new Date(), ...data })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tour: { findUnique: jest.fn().mockResolvedValue({ id: 'tour-1', bookingAndTickets: null }) },
    booking: { create: jest.fn().mockResolvedValue({ id: 'booking-1' }) },
    bookingCounter: { upsert: jest.fn().mockResolvedValue({ count: 7 }) },
  };
  return {
    __tx: tx,
    $transaction: jest.fn(async (fn) => fn(tx)),
    checkoutDraft: tx.checkoutDraft,
    tour: tx.tour,
    booking: tx.booking,
    bookingCounter: tx.bookingCounter,
    $queryRawUnsafe: tx.$queryRawUnsafe,
  };
});

const fs = require('fs');
const path = require('path');
const prisma = require('../../src/core/services/prismaClient');
const { acquireHold, materializeHold } = require('../../src/core/services/checkoutHold');
const { generateBookingNumber } = require('../../src/core/services/bookingHelpers');
const { BRANDS, getBrand } = require('../../config/brands');

const tx = prisma.__tx;

/** Valid hold parameters; `source` / `bookingPrefix` are what vary. */
function holdArgs({ source, bookingPrefix } = {}) {
  return {
    customerId: 'cust-1',
    tourId: 'tour-1',
    tour: { id: 'tour-1', bookingAndTickets: null, supplier: { supplierProfile: {} } },
    travelDate: new Date('2026-11-01'),
    selectedTime: '09:00',
    travelers: { adults: 2 },
    payload: {},
    pricing: { subtotal: 100, total: 100, discount: 0, currency: 'USD' },
    commission: { rate: 10, amount: 10, supplierPayout: 90 },
    ...(source !== undefined ? { source } : {}),
    ...(bookingPrefix !== undefined ? { bookingPrefix } : {}),
  };
}

/** A checkout draft payload as acquireHold would have stored it. */
function draftRecord(payload) {
  return {
    id: 'draft-1',
    status: 'HOLDING',
    tourId: 'tour-1',
    travelDate: new Date('2026-11-01'),
    selectedTime: '09:00',
    pricing: { total: 1000 },
    payload,
  };
}

describe('booking reference prefix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tx.checkoutDraft.findFirst.mockResolvedValue(null);
    tx.checkoutDraft.findUnique.mockResolvedValue(null);
    tx.tour.findUnique.mockResolvedValue({ id: 'tour-1', bookingAndTickets: null });
    tx.booking.create.mockResolvedValue({ id: 'booking-1' });
    tx.bookingCounter.upsert.mockResolvedValue({ count: 7 });
    // availabilityCore's jest.fn() impls survive clearAllMocks, but the
    // resolved values do not need re-setting — only calls are cleared.
    require('../../src/core/services/availabilityCore')
      .evaluateBookingAvailability.mockResolvedValue({ ok: true });
    require('../../src/core/services/bookingHelpers')
      .generateBookingNumber.mockImplementation(async (prefix) => `${prefix}-MINTED`);
  });

  describe('config', () => {
    it('Travio Ghana books as TRG', () => {
      expect(getBrand('ghana').bookingPrefix).toBe('TRG');
    });

    it('keeps Expedition on EXP and Travio Africa on AFR', () => {
      expect(BRANDS.expedition.bookingPrefix).toBe('EXP');
      expect(BRANDS.africa.bookingPrefix).toBe('AFR');
    });
  });

  describe('generated format', () => {
    it('produces a TRG- reference', async () => {
      // Real generator (requireActual) against the mocked counter table.
      const { generateBookingNumber: realGenerate } =
        jest.requireActual('../../src/core/services/bookingHelpers');
      const number = await realGenerate(getBrand('ghana').bookingPrefix);
      expect(number).toMatch(/^TRG-\d{8}-\d{4}-\d{2}$/);
    });
  });

  describe('acquireHold derives the prefix from the booking source', () => {
    it('mints TRG for a GHANA hold even when no prefix is passed', async () => {
      await acquireHold(holdArgs({ source: 'GHANA' }));
      expect(tx.checkoutDraft.create).toHaveBeenCalledTimes(1);
      const { payload } = tx.checkoutDraft.create.mock.calls[0][0].data;
      expect(payload._bookingPrefix).toBe('TRG');
      expect(payload._source).toBe('GHANA');
    });

    it('mints EXP for an EXPEDITION hold from the identical call', async () => {
      // Same code path, different source, different prefix — this is what
      // proves the value is derived rather than being one constant renamed.
      await acquireHold(holdArgs({ source: 'EXPEDITION' }));
      const { payload } = tx.checkoutDraft.create.mock.calls[0][0].data;
      expect(payload._bookingPrefix).toBe('EXP');
    });

    it('mints AFR for a TRAVIO_AFRICA hold', async () => {
      await acquireHold(holdArgs({ source: 'TRAVIO_AFRICA' }));
      const { payload } = tx.checkoutDraft.create.mock.calls[0][0].data;
      expect(payload._bookingPrefix).toBe('AFR');
    });

    it('prefers an explicitly passed prefix over the derived one', async () => {
      await acquireHold(holdArgs({ source: 'GHANA', bookingPrefix: 'OVERRIDE' }));
      const { payload } = tx.checkoutDraft.create.mock.calls[0][0].data;
      expect(payload._bookingPrefix).toBe('OVERRIDE');
    });

    it('falls back to Expedition for an unknown source', async () => {
      await acquireHold(holdArgs({ source: 'SOMEWHERE_ELSE' }));
      const { payload } = tx.checkoutDraft.create.mock.calls[0][0].data;
      expect(payload._bookingPrefix).toBe('EXP');
    });

    it('still records the source analytics event under the resolved brand', async () => {
      const { emit } = require('../../src/core/services/eventEmitter');
      await acquireHold(holdArgs({ source: 'GHANA' }));
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ghana.checkout_started' }),
      );
    });
  });

  describe('materializeHold falls back to the draft\'s own source', () => {
    async function materializeWith(payload) {
      tx.checkoutDraft.findUnique.mockResolvedValue(draftRecord(payload));
      generateBookingNumber.mockClear();
      // Downstream booking writes are not under test; the prefix decision
      // happens before them, and the assertion below is on the captured call.
      await materializeHold('draft-1', { id: 'cs_1', amount_total: 100000 }, 'pi_1').catch(() => {});
      return generateBookingNumber.mock.calls[0];
    }

    it('mints TRG when a GHANA draft is missing _bookingPrefix', async () => {
      // The exact "EXP appeared on a Travio Ghana booking" scenario.
      const [prefix] = await materializeWith({ travelers: [], _source: 'GHANA' });
      expect(prefix).toBe('TRG');
    });

    it('mints EXP when an EXPEDITION draft is missing _bookingPrefix', async () => {
      const [prefix] = await materializeWith({ travelers: [], _source: 'EXPEDITION' });
      expect(prefix).toBe('EXP');
    });

    it('keeps an explicit _bookingPrefix when the draft has one', async () => {
      const [prefix] = await materializeWith({
        travelers: [],
        _source: 'GHANA',
        _bookingPrefix: 'EXPLICIT',
      });
      expect(prefix).toBe('EXPLICIT');
    });
  });

  describe('the Ghana controller reads its prefix from BRAND', () => {
    it('contains no hardcoded booking prefix literal', () => {
      // The regression that shipped: config said one thing and two literals in
      // this file said another, and no test noticed. Reading the source is a
      // blunt instrument, but it is the only thing that fails when someone
      // types a prefix back into this controller.
      const src = fs.readFileSync(
        path.join(__dirname, '../../src/brands/ghana/controller.js'),
        'utf8',
      );
      expect(src).not.toMatch(/generateBookingNumber\(\s*['"][A-Za-z]+['"]\s*\)/);
      expect(src).not.toMatch(/bookingPrefix:\s*['"]/);
      expect(src).toMatch(/generateBookingNumber\(\s*BRAND\.bookingPrefix\s*\)/);
      expect(src).toMatch(/bookingPrefix:\s*BRAND\.bookingPrefix/);
    });
  });
});
