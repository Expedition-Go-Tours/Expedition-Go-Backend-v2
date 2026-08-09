/**
 * Regression suite for the draft alias-shadowing bug.
 *
 * The supplier's flat payloads spell some blob fields with their ALIAS key
 * (language, shortDescription, whatsIncluded, whatsNotIncluded, ageGroups)
 * while the stored blobs use the canonical key (writingLanguage, shortSummary,
 * included, excluded, pricingCategories). injectLiveValues must never seed the
 * canonical key from the LIVE tour when the payload carries any member of the
 * alias group — otherwise productToTour's `canonical || alias` precedence
 * silently discards the supplier's change and the admin diff reports nothing.
 *
 * These tests use the REAL productToTour (the suite's productToTour mock reads
 * the alias keys directly and cannot reproduce the shadowing).
 */

jest.mock('../../utils/prismaClient', () => ({ $disconnect: jest.fn() }));

const { applyFlatToBlobMapping, mergeDraftContent, buildTourDiff, computeChangesSummary } = require('../../utils/tourDraft');

const liveTour = {
  title: 'Live Safari',
  description: 'A fully fleshed-out tour description that is long enough.',
  coverPhoto: null,
  photos: [],
  tags: ['nature'],
  metaTitle: null,
  metaDescription: null,
  categorization: {
    category: 'Adventure',
    subcategory: null,
    activityType: null,
    difficulty: 'Easy',
    duration: { value: 3, unit: 'hours' },
    transportMode: null,
    transportModes: [],
    transportServices: [],
    accommodationIncluded: null,
  },
  productContent: {
    writingLanguage: 'French',
    shortSummary: 'Old short summary',
    included: ['Water bottle'],
    excluded: ['Lunch'],
    highlights: ['Scenic views'],
  },
  schedulesAndPricing: {
    travelerDetails: {
      pricingModel: 'perPerson',
      pricingApproach: 'dependsOnAge',
      pricingCategories: [{ name: 'Adult', price: 100, minAge: 13, maxAge: 99 }],
      minParticipants: 1,
      maxParticipants: 18,
      maxGroupsPerTimeSlot: 1,
    },
    pricingSchedules: {
      currency: 'USD',
      schedules: [
        {
          name: 'Standard',
          type: 'operatingHours',
          startDate: '2026-01-01',
          hasEndDate: false,
          endDate: null,
          weeklySchedule: {
            Monday: [{ startTime: '09:00', endTime: '17:00' }],
            Tuesday: [{ startTime: '09:00', endTime: '17:00' }],
            Wednesday: [{ startTime: '09:00', endTime: '17:00' }],
            Thursday: [{ startTime: '09:00', endTime: '17:00' }],
            Friday: [{ startTime: '09:00', endTime: '17:00' }],
            Saturday: [{ startTime: '09:00', endTime: '17:00' }],
          },
          dateExceptions: [],
          timeSlots: [],
          pricingModel: 'perPerson',
          pricingApproach: 'dependsOnAge',
          pricingCategories: [{ name: 'Adult', price: 100, minAge: 13, maxAge: 99 }],
        },
      ],
    },
    availability: {
      scheduleType: 'operatingHours',
      daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      operatingHoursStart: '09:00',
      operatingHoursEnd: '17:00',
      weeklySchedule: {
        Monday: [{ startTime: '09:00', endTime: '17:00' }],
        Tuesday: [{ startTime: '09:00', endTime: '17:00' }],
        Wednesday: [{ startTime: '09:00', endTime: '17:00' }],
        Thursday: [{ startTime: '09:00', endTime: '17:00' }],
        Friday: [{ startTime: '09:00', endTime: '17:00' }],
        Saturday: [{ startTime: '09:00', endTime: '17:00' }],
      },
      timeSlots: [],
      startDate: '2026-01-01',
      endDate: null,
      timezone: 'UTC',
    },
  },
  bookingAndTickets: { cutoffMinutes: 20, ticketPolicy: { type: 'standard' } },
};

describe('alias-form payloads keep the supplier value (no live shadowing)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('language -> writingLanguage keeps the submitted language', () => {
    const out = applyFlatToBlobMapping({ language: 'German' }, liveTour);
    expect(out.productContent.writingLanguage).toBe('German');
  });

  it('shortDescription-only payload keeps the submitted summary', () => {
    const out = applyFlatToBlobMapping({ shortDescription: 'Fresh short summary' }, liveTour);
    expect(out.productContent.shortSummary).toBe('Fresh short summary');
  });

  it('whatsIncluded-only payload keeps the submitted inclusions', () => {
    const out = applyFlatToBlobMapping({ whatsIncluded: ['Map', 'Guide'] }, liveTour);
    expect(out.productContent.included).toEqual(['Map', 'Guide']);
  });

  it('whatsNotIncluded-only payload keeps the submitted exclusions', () => {
    const out = applyFlatToBlobMapping({ whatsNotIncluded: ['Tips'] }, liveTour);
    expect(out.productContent.excluded).toEqual(['Tips']);
  });

  it('ageGroups-only payload keeps the submitted pricing categories', () => {
    const ageGroups = [
      { name: 'Kid', price: 10, minAge: 3, maxAge: 12 },
      { name: 'Adult', price: 50, minAge: 13, maxAge: 99 },
    ];
    const out = applyFlatToBlobMapping({ ageGroups, currency: 'EUR' }, liveTour);
    expect(out.schedulesAndPricing.travelerDetails.pricingCategories).toEqual(ageGroups);
  });

  it('canonical form still wins when payload carries both spellings', () => {
    const out = applyFlatToBlobMapping({ language: 'Spanish', writingLanguage: 'Portuguese' }, liveTour);
    expect(out.productContent.writingLanguage).toBe('Portuguese');
  });

  it('neither spelling: live value is preserved unchanged', () => {
    const out = applyFlatToBlobMapping({ highlights: ['Scenic views', 'Wildlife'] }, liveTour);
    expect(out.productContent.writingLanguage).toBe('French');
    expect(out.productContent.shortSummary).toBe('Old short summary');
  });

  it('pricing categories are preserved when the group is absent', () => {
    const live = JSON.parse(JSON.stringify(liveTour));
    live.schedulesAndPricing.travelerDetails.pricingCategories = [{ name: 'Kid', price: 25, minAge: 3, maxAge: 12 }];
    const out = applyFlatToBlobMapping({ currency: 'EUR' }, live);
    expect(out.schedulesAndPricing.travelerDetails.pricingCategories).toEqual([
      { name: 'Kid', price: 25, minAge: 3, maxAge: 12 },
    ]);
  });
});

describe('alias-only changes surface in the admin diff', () => {
  it('a language-only submission shows a productContent.writingLanguage row', () => {
    const body = applyFlatToBlobMapping({ language: 'German' }, liveTour);
    const draft = mergeDraftContent(liveTour, body);
    const diff = buildTourDiff(liveTour, draft);
    const paths = diff.map((d) => d.path);
    expect(paths).toContain('productContent.writingLanguage');
    const summary = computeChangesSummary(diff);
    expect(summary.sections.some((s) => s.section === 'productContent')).toBe(true);
    expect(summary.count).toBeGreaterThan(0);
  });

  it('an ageGroups change appears under schedulesAndPricing', () => {
    const ageGroups = [{ name: 'Kid', price: 10, minAge: 3, maxAge: 12 }];
    const body = applyFlatToBlobMapping({ ageGroups }, liveTour);
    const draft = mergeDraftContent(liveTour, body);
    const diff = buildTourDiff(liveTour, draft);
    const pricingPaths = diff.map((d) => d.path).filter((p) => p.startsWith('schedulesAndPricing.travelerDetails.pricingCategories'));
    expect(pricingPaths.length).toBeGreaterThan(0);
    expect(computeChangesSummary(diff).sections.some((s) => s.section === 'schedulesAndPricing')).toBe(true);
  });

  it('preserved pricing categories produce no pricing diff on unrelated edits', () => {
    const body = applyFlatToBlobMapping({ highlights: ['Scenic views', 'Wildlife'] }, liveTour);
    const draft = mergeDraftContent(liveTour, body);
    const diff = buildTourDiff(liveTour, draft);
    expect(diff.map((d) => d.path).filter((p) => p.includes('pricingCategories'))).toEqual([]);
  });
});