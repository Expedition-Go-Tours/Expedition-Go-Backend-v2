const {
  getTourOptions,
  defaultOption,
  resolveTourOption,
  projectOption,
  validateTourOptions,
  optionSummaries,
  optionScopeFor,
  applyOption,
} = require('../../utils/tourOptions');

const optionBase = {
  id: 'opt-1',
  refCode: 'default',
  title: 'Morning Tour',
  description: '',
  isPrivate: false,
  pricing: {
    pricingModel: 'perPerson',
    currency: 'USD',
    pricingApproach: 'dependsOnAge',
    pricingCategories: [
      { name: 'Adult', price: 50, minAge: 18, maxAge: 59 },
      { name: 'Child', price: 30, minAge: 4, maxAge: 17 },
    ],
    minParticipants: 1,
    maxParticipants: 10,
    groupSizes: [],
    additionalPersonsEnabled: false,
    additionalPersonPrice: null,
    maxGroupsPerTimeSlot: 1,
  },
  availability: {
    scheduleType: 'fixedTimeSlot',
    timezone: 'Africa/Accra',
    timeSlots: [{ id: 's1', startTime: '09:00', endTime: '10:00' }],
    weeklySchedule: { Monday: [{ startTime: '09:00', endTime: '10:00' }] },
    dateExceptions: [],
    schedules: [
      {
        name: 'Summer',
        type: 'fixedTimeSlot',
        startDate: '2026-06-01',
        hasEndDate: true,
        endDate: '2026-09-30',
        weeklySchedule: { Monday: [{ startTime: '09:00', endTime: '10:00' }] },
        dateExceptions: [],
        timeSlots: [{ id: 's1', startTime: '09:00', endTime: '10:00' }],
      },
    ],
  },
  cutoff: {
    cutoffMinutes: 60,
    lastMinuteBookings: true,
    perSlotCutoff: true,
    perSlotCutoffs: { '09:00': 30 },
  },
};

const tourWithOptions = {
  productContent: {
    options: [
      optionBase,
      {
        ...optionBase,
        id: 'opt-2',
        refCode: 'sunset',
        title: 'Sunset Tour',
        pricing: { ...optionBase.pricing, pricingCategories: [{ name: 'Adult', price: 80, minAge: 18, maxAge: 59 }] },
        cutoff: { ...optionBase.cutoff, cutoffMinutes: 120 },
      },
    ],
  },
  bookingAndTickets: { cancellationPolicy: { type: 'standard', cancellationWindowHours: 24 }, meetingPoint: 'Lobby' },
  schedulesAndPricing: { legacy: 'should not be used when options exist' },
};

const legacyTour = {
  productContent: {},
  bookingAndTickets: { cutoffMinutes: 20, meetingPoint: 'Lobby' },
  schedulesAndPricing: { availability: { timeSlots: ['10:00'] }, travelerDetails: { maxParticipants: 8 } },
};

describe('tourOptions resolution', () => {
  it('lists and defaults to the first option', () => {
    const options = getTourOptions(tourWithOptions);
    expect(options).toHaveLength(2);
    expect(defaultOption(tourWithOptions).id).toBe('opt-1');
  });

  it('resolves by id, refCode, or default', () => {
    expect(resolveTourOption(tourWithOptions, 'opt-2').option.title).toBe('Sunset Tour');
    expect(resolveTourOption(tourWithOptions, 'sunset').option.title).toBe('Sunset Tour');
    expect(resolveTourOption(tourWithOptions, 'default').option.id).toBe('opt-1');
    expect(resolveTourOption(tourWithOptions, 'unknown').option.id).toBe('opt-1');
  });

  it('returns no option for option-less tours', () => {
    expect(defaultOption(legacyTour)).toBeNull();
    expect(resolveTourOption(legacyTour, 'x').option).toBeNull();
  });
});

describe('projectOption', () => {
  it('projects the chosen option into engine format with its own price list', () => {
    const proj = projectOption(tourWithOptions, 'opt-2');
    expect(proj.optionId).toBe('opt-2');
    expect(proj.optionTitle).toBe('Sunset Tour');
    expect(proj.schedulesAndPricing.travelerDetails.pricingCategories[0].name).toBe('Adult');
    expect(proj.schedulesAndPricing.travelerDetails.pricingCategories[0].price).toBe(80);
    expect(proj.schedulesAndPricing.availability.timezone).toBe('Africa/Accra');
    expect(proj.schedulesAndPricing.pricingSchedules.schedules).toHaveLength(1);
    expect(proj.schedulesAndPricing.pricingSchedules.schedules[0].startDate).toBe('2026-06-01');
    expect(proj.schedulesAndPricing.pricingSchedules.schedules[0].prices).toEqual([
      { ageGroup: 'Adult', retailPrice: 80 },
    ]);
  });

  it('carries option cut-offs onto the booking blob and keeps tour fields', () => {
    const proj = projectOption(tourWithOptions, 'opt-1');
    expect(proj.bookingAndTickets.cutoffMinutes).toBe(60);
    expect(proj.bookingAndTickets.perSlotCutoff).toBe(true);
    expect(proj.bookingAndTickets.perSlotCutoffs['09:00']).toBe(30);
    expect(proj.bookingAndTickets.lastMinuteBookings).toBe(true);
    expect(proj.bookingAndTickets.meetingPoint).toBe('Lobby');
    expect(proj.bookingAndTickets.cancellationPolicy.type).toBe('standard');
  });

  it('passes legacy single-option blobs through untouched', () => {
    const proj = projectOption(legacyTour, 'whatever');
    expect(proj.option).toBeNull();
    expect(proj.optionId).toBeNull();
    expect(proj.schedulesAndPricing).toEqual(legacyTour.schedulesAndPricing);
    expect(proj.bookingAndTickets).toEqual(legacyTour.bookingAndTickets);
  });
});

describe('validateTourOptions', () => {
  it('accepts consistent options', () => {
    expect(validateTourOptions(tourWithOptions).ok).toBe(true);
  });

  it('flags a schedule whose prices disagree with the option price list', () => {
    const bad = {
      productContent: {
        options: [
          {
            ...optionBase,
            availability: {
              ...optionBase.availability,
              schedules: [
                { ...optionBase.availability.schedules[0], pricingCategories: [{ name: 'Adult', price: 999 }] },
              ],
            },
          },
        ],
      },
    };
    const result = validateTourOptions(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/differ from the option's price list/);
  });

  it('flags out-of-range cut-offs', () => {
    const bad = {
      productContent: {
        options: [{ ...optionBase, cutoff: { ...optionBase.cutoff, cutoffMinutes: 700 } }],
      },
    };
    const result = validateTourOptions(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/0–600/);
  });

  it('is a no-op for tours without options', () => {
    expect(validateTourOptions(legacyTour)).toEqual({ ok: true, errors: [] });
  });
});

describe('optionScopeFor / applyOption', () => {
  it('default option scopes with includeNull, others by id only', () => {
    expect(optionScopeFor(tourWithOptions, 'default')).toEqual({ id: 'opt-1', includeNull: true });
    expect(optionScopeFor(tourWithOptions, 'opt-2')).toEqual({ id: 'opt-2', includeNull: false });
    expect(optionScopeFor(legacyTour, 'x')).toBeNull();
  });

  it('applyOption swaps the engine blobs to the chosen option', () => {
    const applied = applyOption(tourWithOptions, 'opt-2');
    expect(applied.optionId).toBe('opt-2');
    expect(applied.optionTitle).toBe('Sunset Tour');
    expect(applied.optionScope).toEqual({ id: 'opt-2', includeNull: false });
    expect(applied.tour.schedulesAndPricing.travelerDetails.pricingCategories[0].price).toBe(80);
    expect(applied.tour.bookingAndTickets.cutoffMinutes).toBe(120);
  });

  it('legacy tours pass through unchanged with a null scope', () => {
    const applied = applyOption(legacyTour, 'whatever');
    expect(applied.optionScope).toBeNull();
    expect(applied.tour.schedulesAndPricing).toEqual(legacyTour.schedulesAndPricing);
  });
});

describe('optionSummaries', () => {
  it('returns light descriptors without pricing math', () => {
    const summaries = optionSummaries(tourWithOptions);
    expect(summaries.map((s) => s.title)).toEqual(['Morning Tour', 'Sunset Tour']);
    expect(summaries[0].id).toBe('opt-1');
    expect(summaries[0].isPrivate).toBe(false);
    // Display-only from-price derived from the option's own price list.
    expect(summaries[0].fromPrice).toBe(50);
    expect(summaries[0].currency).toBe('USD');
    expect(summaries[1].fromPrice).toBe(80);
  });
});
