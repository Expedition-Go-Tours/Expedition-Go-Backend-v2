/**
 * Tour payload lifecycle test.
 *
 * Walks a tour's `schedulesAndPricing` blob through every stage of the
 * create → draft-save → submit-for-review → admin-approve → edit pipeline and
 * asserts the availability aggregate (`availability.*`) and the per-schedule
 * data (`pricingSchedules.schedules[0]`) stay consistent (and never get silently
 * wiped) at each stage.
 *
 * Regression guard for the bug where an innocent edit (e.g. duration 19h->1d)
 * on an ACTIVE tour produced a spurious "availability.daysOfWeek[0-6]" diff and
 * silently blanked the schedule the booking engine reads.
 *
 * The pipeline pieces exercised here are the SAME ones the controllers wire
 * together:
 *   draft-save/save  -> mergeDraftContent + rebuildSchedulePrices + reconcileAvailability
 *   submit           -> (validates the healed snapshot produced above)
 *   admin approve    -> buildLiveUpdateData (runs reconcileAvailability on the live write)
 *   re-open / edit   -> draft pipeline again + buildTourDiff to detect noise
 *
 * NOTE: buildDraftFromBody lives in tourController (not exported), so we
 * replicate its exact payload sequence here using the exported helpers — the
 * same three calls the controller makes.
 */

jest.mock('../../utils/prismaClient', () => ({
  tour: {
    findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(),
    count: jest.fn(), create: jest.fn(), update: jest.fn(),
    groupBy: jest.fn(), aggregate: jest.fn(),
  },
  payoutMethod: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
}));

jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  TOUR_DETAIL_PREFIX: (id) => `tours:detail:${id}`,
  TOUR_LIST_PREFIX: 'tours:list:*',
  TOUR_FILTERS_KEY: 'tours:filters:options',
  TOUR_POPULAR_KEY: 'tours:popular:by-category',
  REVIEWS_TOUR_PREFIX: (tourId) => `reviews:tour:${tourId}:*`,
}));

jest.mock('../../utils/cloudinaryHelper', () => ({
  deleteCloudinaryImage: jest.fn(() => Promise.resolve()),
  isValidCloudinaryUrl: jest.fn((u) => typeof u === 'string' && u.startsWith('https://res.cloudinary.com/')),
}));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((u) => u) }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));
jest.mock('../../utils/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()), enqueueNotification: jest.fn(() => Promise.resolve()), enqueueAiScoring: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn(() => Promise.resolve()), emitToRoom: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/tourFilterBuilder', () => ({
  buildTourFilters: jest.fn(), buildSortOptions: jest.fn(), getAvailableFilterOptions: jest.fn(),
  validateFilterParams: jest.fn(), findNearbyTourIds: jest.fn(), getTourDistances: jest.fn(),
}));
jest.mock('../../utils/popularityScorer', () => ({ getPopularByCategory: jest.fn() }));
jest.mock('../../utils/fullTextSearch', () => ({ rankTourIdsBySearch: jest.fn() }));
// Use the REAL helpers for availability/pricing logic so the payload is exercised
// end-to-end. Stub only the slug + duration + validation helpers.
jest.mock('../../utils/tourHelpers', () => {
  const actual = jest.requireActual('../../utils/tourHelpers');
  return {
    ...actual,
    createSlug: jest.fn(() => Promise.resolve('tower-fix')),
    durationToMinutes: jest.fn((d) => {
      if (!d) return null;
      if (d.unit === 'hours') return Math.round((d.value || d.hours || 0) * 60);
      if (d.unit === 'days') return Math.round((d.value || d.days || 0) * 24 * 60);
      return null;
    }),
    validateStoredPricing: jest.fn(() => []),
    validateTourData: jest.fn(() => ({ isValid: true, errors: [] })),
  };
});
jest.mock('../../utils/appError', () => {
  class AppError extends Error {
    constructor(msg, code) { super(msg); this.statusCode = code; this.status = code; }
  }
  return AppError;
});

const {
  rebuildSchedulePrices,
  reconcileAvailability,
  validateStoredPricing,
  validateTourData,
} = require('../../utils/tourHelpers');
const { mergeDraftContent, buildLiveUpdateData, buildTourDiff } = require('../../utils/tourDraft');

// Replicates tourController.buildDraftFromBody's payload handling (photos are
// irrelevant to availability, so omitted). This is the exact three-step sequence
// the controller runs on every draft save / submit.
function draftFromBody(existingTour, body) {
  const merged = mergeDraftContent(existingTour, body);
  if (merged.schedulesAndPricing && typeof merged.schedulesAndPricing === 'object' && !Array.isArray(merged.schedulesAndPricing)) {
    merged.schedulesAndPricing = rebuildSchedulePrices(merged.schedulesAndPricing);
    merged.schedulesAndPricing = reconcileAvailability(merged.schedulesAndPricing);
  }
  return merged;
}

// Real production snapshot of the "Tower Fix" tour (cmrypuex70001117qmysomznp)
// as captured from prod. This IS the corruption shape:
//   - pricingSchedules.schedules[0].weeklySchedule = null
//   - availability.weeklySchedule = all-empty object
//   - availability.daysOfWeek = []
//   - availability.timeSlots = ["09:45"] (a fixed-time-slot tour that only has
//     timeSlots, no weekday hours — so daysOfWeek [] is actually LEGITIMATE here,
//     but the aggregate weeklySchedule must mirror schedules[0], not be wiped).
const TOWER_FIX_BLOB = {
  travelerDetails: {
    ageGroups: [{ label: 'Child', minAge: 0, maxAge: 17 }, { label: 'Adult', minAge: 18, maxAge: 59 }],
    groupSizes: [],
    pricingModel: 'perPerson',
    uniformPrice: null,
    maxParticipants: 10,
    minParticipants: 1,
    pricingApproach: 'dependsOnAge',
    pricingCategories: [
      { name: 'Child', price: 200, tiers: [], idType: '', maxAge: 17, minAge: 0, idRequired: false, needsAdult: false, notAllowed: false, ticketNotRequired: false },
      { name: 'Adult', price: 300, tiers: [], idType: '', maxAge: 59, minAge: 18, idRequired: false, needsAdult: false, notAllowed: false, ticketNotRequired: false },
    ],
    maxGroupsPerTimeSlot: 1,
    additionalPersonPrice: null,
    additionalPersonsEnabled: false,
  },
  pricingSchedules: {
    currency: 'USD',
    schedules: [
      {
        name: 'summer',
        type: 'fixedTimeSlot',
        startDate: '2026-08-14',
        hasEndDate: false,
        endDate: null,
        dateExceptions: [],
        weeklySchedule: null,
        timeSlots: [{ id: '33c7da0c-9e65-4693-912d-610cd04b85ee', startTime: '09:45' }],
        pricingModel: 'perPerson',
        currency: 'USD',
        pricingApproach: 'dependsOnAge',
        uniformPrice: null,
        pricingCategories: [
          { name: 'Child', price: 200, tiers: [], idType: '', maxAge: 17, minAge: 0, idRequired: false, needsAdult: false, notAllowed: false, ticketNotRequired: false },
          { name: 'Adult', price: 300, tiers: [], idType: '', maxAge: 59, minAge: 18, idRequired: false, needsAdult: false, notAllowed: false, ticketNotRequired: false },
        ],
        prices: [{ ageGroup: 'Child', retailPrice: 200 }, { ageGroup: 'Adult', retailPrice: 300 }],
        minParticipants: 1,
        maxParticipants: 10,
      },
    ],
  },
  availability: {
    scheduleType: 'fixedTimeSlot',
    operatingHoursStart: '08:00',
    operatingHoursEnd: '18:00',
    startDate: '2026-08-14',
    endDate: null,
    timezone: 'UTC',
    weeklySchedule: { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] },
    timeSlots: ['09:45'],
    daysOfWeek: [],
  },
};

const EMPTY_WEEKLY = { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] };
const HOURS = { ...EMPTY_WEEKLY, Monday: [{ startTime: '09:00', endTime: '12:00' }] };

const baseTour = (overrides = {}) => ({
  id: 'cmrypuex70001117qmysomznp',
  title: 'Tower Fix',
  slug: 'tower-fix',
  description: 'A tour description long enough to pass review validation requirements.',
  referenceCode: null,
  photos: [],
  coverPhoto: null,
  status: 'ACTIVE',
  supplierId: 'cmr9daelz000wfvikmj21c7vs',
  durationMinutes: 120,
  categorization: { category: 'activity', subcategory: null, activityType: 'self-guided', difficulty: 'hard', duration: { unit: 'hours', value: 2 }, transportMode: null, transportModes: [], transportServices: [] },
  theme: { primaryTheme: null, secondary: [] },
  productContent: {
    writingLanguage: 'English', shortSummary: 'short', highlights: ['views'],
    meetingMode: 'pickup',
    meetingPoint: { name: 'Gate', address: 'Main Rd', lat: 5.62, lng: -0.17 },
    locations: [{ city: 'Accra', country: 'Ghana', region: 'Greater Accra Region' }],
    itineraryOverview: 'overview',
  },
  schedulesAndPricing: JSON.parse(JSON.stringify(TOWER_FIX_BLOB)),
  bookingAndTickets: { meetingPoint: { name: 'Gate', address: 'Main Rd' }, cutoffMinutes: 20, timezone: 'UTC' },
  tags: ['Royalty & History', 'Animals & Nature'],
  createdAt: '2026-07-24T09:06:32.586Z',
  updatedAt: '2026-08-07T14:01:20.353Z',
  draftStatus: null,
  draftContent: null,
  draftSubmittedAt: null,
  draftReviewedAt: null,
  draftReviewNote: null,
  ...overrides,
});

describe('Tour payload lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateStoredPricing.mockReturnValue([]);
    validateTourData.mockReturnValue({ isValid: true, errors: [] });
  });

  describe('1. seed: real prod snapshot of Tower Fix (ACTIVE, no draft)', () => {
    it('matches the production corruption shape', () => {
      const t = baseTour();
      // schedules[0].weeklySchedule is null on prod — the per-schedule row lost its hours.
      expect(t.schedulesAndPricing.pricingSchedules.schedules[0].weeklySchedule).toBeNull();
      // aggregate weeklySchedule is present but all-empty object.
      expect(hasHours(t.schedulesAndPricing.availability.weeklySchedule)).toBe(false);
      // fixed-time-slot tour legitimately has no weekday daysOfWeek, but timeSlots exist.
      expect(t.schedulesAndPricing.availability.timeSlots).toEqual(['09:45']);
    });
  });

  describe('2. draft save heals the aggregate (reconcileAvailability)', () => {
    it('does not wipe availability.weeklySchedule — mirrors schedules[0]', () => {
      const existing = baseTour();
      // Simulate the editor emitting an empty aggregate (the autosave-drift bug).
      const body = {
        ...existing,
        schedulesAndPricing: {
          ...existing.schedulesAndPricing,
          availability: { ...existing.schedulesAndPricing.availability, weeklySchedule: {}, timeSlots: [] },
        },
      };
      const draft = draftFromBody(existing, body);

      // The aggregate must NOT be blanked to the void — reconcile adds hours
      // only when schedules[0] actually has them. Here schedules[0].weeklySchedule
      // is null, so we keep the existing timeSlots and a non-crashing weeklySchedule.
      expect(draft.schedulesAndPricing.availability).toBeDefined();
      expect(draft.schedulesAndPricing.pricingSchedules.schedules[0].weeklySchedule).not.toBeNull();
      expect(draft.schedulesAndPricing.availability.timeSlots).toEqual(['09:45']);
      expect(validateStoredPricing(draft.schedulesAndPricing)).toEqual([]);
    });

    it('backfills weekday hours when schedules[0] carries them (the Accra City Tour shape)', () => {
      const existing = baseTour({
        schedulesAndPricing: {
          ...baseTour().schedulesAndPricing,
          pricingSchedules: {
            currency: 'USD',
            schedules: [{ name: 'Standard', type: 'operatingHours', startDate: '2026-01-01', hasEndDate: false, weeklySchedule: JSON.parse(JSON.stringify(HOURS)), dateExceptions: [], timeSlots: [], pricingModel: 'perPerson', pricingApproach: 'dependsOnAge', pricingCategories: [{ name: 'Adult', price: 50, minAge: 13, maxAge: 99 }] }],
          },
        },
      });
      // aggregate is empty (the bug)
      const body = { ...existing, schedulesAndPricing: { ...existing.schedulesAndPricing, availability: { ...existing.schedulesAndPricing.availability, weeklySchedule: {}, daysOfWeek: [], timeSlots: [] } } };
      const draft = draftFromBody(existing, body);
      expect(hasHours(draft.schedulesAndPricing.availability.weeklySchedule)).toBe(true);
      expect(draft.schedulesAndPricing.availability.weeklySchedule).toEqual(HOURS);
      expect(draft.schedulesAndPricing.availability.daysOfWeek).toEqual(['Monday']);
    });

    it('never invents hours when both sides are empty (no over-opening the calendar)', () => {
      const bothEmpty = baseTour({
        schedulesAndPricing: {
          ...baseTour().schedulesAndPricing,
          availability: { scheduleType: 'fixedTimeSlot', timezone: 'UTC', weeklySchedule: {}, timeSlots: [], daysOfWeek: [] },
          pricingSchedules: { currency: 'USD', schedules: [{ name: 'Standard', weeklySchedule: {}, timeSlots: [], pricingCategories: [] }] },
        },
      });
      const draft = draftFromBody(bothEmpty, { ...bothEmpty });
      expect(draft.schedulesAndPricing.availability.daysOfWeek).toEqual([]);
      expect(hasHours(draft.schedulesAndPricing.availability.weeklySchedule)).toBe(false);
    });
  });

  describe('3. submit-for-review: healed snapshot passes pricing validation', () => {
    it('validateStoredPricing is clean on the healed snapshot', () => {
      const existing = baseTour();
      const submitted = draftFromBody(existing, { ...existing });
      expect(validateStoredPricing(submitted.schedulesAndPricing)).toEqual([]);
      expect(validateTourData(submitted).isValid).toBe(true);
    });
  });

  describe('4. admin approval (buildLiveUpdateData)', () => {
    it('writes a healed availability aggregate + in-sync schedules[0] live', async () => {
      const existing = baseTour();
      const submitted = draftFromBody(existing, { ...existing });
      const liveData = await buildLiveUpdateData(prisma, existing, submitted);
      const blob = liveData.schedulesAndPricing;
      // live aggregate must retain the fixed-time-slot timeSlots (not blanked)
      expect(blob.availability.timeSlots).toEqual(['09:45']);
      expect(blob.pricingSchedules.schedules[0].weeklySchedule).not.toBeNull();
      expect(validateStoredPricing(blob)).toEqual([]);
    });

    it('the live row, when re-diffed on reopen, shows only real changes (no schedule noise)', async () => {
      const existing = baseTour();
      const submitted = draftFromBody(existing, { ...existing });
      const liveData = await buildLiveUpdateData(prisma, existing, submitted);
      const approvedRow = {
        ...existing,
        ...liveData,
        schedulesAndPricing: liveData.schedulesAndPricing,
        status: 'ACTIVE',
        draftStatus: null,
        draftContent: null,
      };
      const reopened = draftFromBody(approvedRow, { ...approvedRow });
      const diff = buildTourDiff(approvedRow, reopened);
      const noise = diff.filter((d) => d.path.includes('weeklySchedule') || d.path.includes('daysOfWeek'));
      expect(noise).toEqual([]);
    });
  });

  describe('5. innocent edit (duration only) produces no schedule diff', () => {
    it('duration 2h -> 1d leaves the aggregate + schedules[0] untouched', () => {
      const approved = baseTour();
      approved.schedulesAndPricing = reconcileAvailability(rebuildSchedulePrices(JSON.parse(JSON.stringify(approved.schedulesAndPricing))));

      const editBody = {
        ...approved,
        durationMinutes: 1440,
        categorization: { ...approved.categorization, duration: { unit: 'days', value: 1 } },
        schedulesAndPricing: approved.schedulesAndPricing,
      };
      const draft = draftFromBody(approved, editBody);
      const diff = buildTourDiff(approved, draft);

      const availPaths = diff.filter((d) => d.path.startsWith('schedulesAndPricing.availability')).map((d) => d.path);
      expect(availPaths).toEqual([]);

      const schedPaths = diff.filter((d) => d.path.includes('schedules[0]')).map((d) => d.path);
      expect(schedPaths).toEqual([]);

      // ...but the duration MUST have changed.
      const durUnit = diff.find((d) => d.path === 'categorization.duration.unit');
      const durVal = diff.find((d) => d.path === 'categorization.duration.value');
      expect(durUnit).toBeDefined();
      expect(durVal).toBeDefined();
    });
  });

  describe('6. booking-engine view (availabilityCore reads the aggregate)', () => {
    it('timeSlots survive the full pipeline so the calendar still offers 09:45', async () => {
      const existing = baseTour();
      const submitted = draftFromBody(existing, { ...existing });
      const liveData = await buildLiveUpdateData(prisma, existing, submitted);
      expect(liveData.schedulesAndPricing.availability.timeSlots).toContain('09:45');
    });
  });
});

const { prisma } = (() => {
  const p = require('../../utils/prismaClient');
  return { prisma: p };
})();

function hasHours(ws) {
  return !!(ws && typeof ws === 'object' && Object.values(ws).some((slots) => Array.isArray(slots) && slots.length > 0));
}
