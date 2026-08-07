jest.mock('../../utils/prismaClient', () => ({
  tour: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
  },
  booking: { groupBy: jest.fn(), aggregate: jest.fn() },
  review: { aggregate: jest.fn() },
  tourSecondaryTheme: { deleteMany: jest.fn(), createMany: jest.fn() },
  payoutMethod: { findFirst: jest.fn() },
  media: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateTourCaches: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(),
}));

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));
jest.mock('../../utils/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()), enqueueNotification: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn(() => Promise.resolve()), emitToRoom: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/cloudinaryHelper', () => ({
  deleteCloudinaryImage: jest.fn(),
  isValidCloudinaryUrl: jest.fn((url) => typeof url === 'string' && url.startsWith('https://res.cloudinary.com/')),
}));
jest.mock('../../utils/tourHelpers', () => ({
  createSlug: jest.fn(),
  validateTourData: jest.fn(),
  validateStoredPricing: jest.fn(),
  rebuildSchedulePrices: jest.fn((b) => b),
  reconcileAvailability: jest.fn((b) => b),
  durationToMinutes: jest.fn(),
}));
jest.mock('../../utils/productToTour', () => ({
  productToTour: jest.fn((flat) => ({
    title: flat.title || '',
    categorization: {
      category: flat.category || 'Adventure',
      subcategory: flat.subcategory || null,
      activityType: flat.activityType || null,
      difficulty: flat.difficulty || 'Easy',
      duration: flat.duration ? { value: flat.duration, unit: flat.durationUnit || 'hours' } : null,
      transportMode: flat.transportMode || null,
      transportModes: Array.isArray(flat.transportModes) ? flat.transportModes : [],
      transportServices: Array.isArray(flat.transportServices) ? flat.transportServices : [],
    },
    theme: { primaryTheme: flat.primaryTheme || null, secondary: Array.isArray(flat.secondaryThemes) ? flat.secondaryThemes : [] },
    productContent: {
      writingLanguage: flat.language || 'English',
      shortSummary: flat.shortDescription || '',
      fullDescription: flat.fullDescription || '',
      highlights: Array.isArray(flat.highlights) ? flat.highlights : [],
      meetingMode: flat.meetingMode || 'meeting_point',
      meetingPoint: flat.meetingPoint || { name: 'Gate', address: 'Main Rd' },
      locations: Array.isArray(flat.locations) ? flat.locations : [],
      attractions: Array.isArray(flat.attractions) ? flat.attractions : [],
      activitiesIncluded: Array.isArray(flat.activitiesIncluded) ? flat.activitiesIncluded : [],
      pickupTransportTypes: Array.isArray(flat.pickupTransportTypes) ? flat.pickupTransportTypes : [],
      whatsIncluded: Array.isArray(flat.whatsIncluded) ? flat.whatsIncluded : [],
      whatsNotIncluded: Array.isArray(flat.whatsNotIncluded) ? flat.whatsNotIncluded : [],
      guideType: flat.guideType || 'tour-guide',
      guideMaterials: flat.guideMaterials || { audioGuide: false, infoBooklet: false },
      foodProvided: !!flat.foodProvided,
      meals: Array.isArray(flat.meals) ? flat.meals : [],
      mealType: flat.mealType || '',
      showDietaryRestrictions: !!flat.showDietaryRestrictions,
      drinksIncluded: !!flat.drinksIncluded,
      dietaryOptions: Array.isArray(flat.dietaryOptions) ? flat.dietaryOptions : [],
      transportationProvided: !!flat.transportationProvided,
      transportationType: flat.transportationType || '',
      healthRestrictions: Array.isArray(flat.healthRestrictions) ? flat.healthRestrictions : [],
      notAllowed: Array.isArray(flat.notAllowed) ? flat.notAllowed : [],
      petFriendly: !!flat.petFriendly,
      mandatoryItems: Array.isArray(flat.mandatoryItems) ? flat.mandatoryItems : [],
      knowBeforeYouGo: flat.knowBeforeYouGo || '',
      emergencyCountryCode: flat.emergencyCountryCode || '',
      emergencyPhone: flat.emergencyPhone || '',
      voucherInfo: flat.voucherInfo || '',
      copyrightConfirmed: !!flat.copyrightConfirmed,
      options: Array.isArray(flat.options) ? flat.options : [],
    },
    schedulesAndPricing: flat.schedulesAndPricing || {
      travelerDetails: {
        pricingModel: 'perPerson',
        pricingApproach: 'dependsOnAge',
        pricingCategories: [{ name: 'Adult', price: 100, minAge: 13, maxAge: 99 }],
      },
      pricingSchedules: { currency: 'USD', schedules: [] },
      availability: { scheduleType: 'operatingHours', weeklySchedule: {} }
    },
    bookingAndTickets: {
      meetingPoint: flat.meetingPoint || { name: 'Gate', address: 'Main Rd' },
      cutoffMinutes: flat.cutoffMinutes || 20,
      cancellationPolicy: flat.cancellationPolicy || { type: 'standard' },
    }
  }))
}));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn() }));
jest.mock('../../utils/tourFilterBuilder', () => ({
  buildTourFilters: jest.fn(),
  buildSortOptions: jest.fn(),
  getAvailableFilterOptions: jest.fn(),
  validateFilterParams: jest.fn(),
  findNearbyTourIds: jest.fn(),
  getTourDistances: jest.fn(),
}));
jest.mock('../../utils/popularityScorer', () => ({ getPopularByCategory: jest.fn() }));
jest.mock('../../utils/fullTextSearch', () => ({ rankTourIdsBySearch: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const cache = require('../../utils/cacheHelper');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const { validateTourData, validateStoredPricing } = require('../../utils/tourHelpers');
const { logActivity } = require('../../utils/auditLogger');
const tourController = require('../../controllers/tourController');
const tourDraft = require('../../utils/tourDraft');

let req, res, next;

const liveRow = {
  id: 'tour-1',
  title: 'Live Safari',
  slug: 'live-safari',
  description: 'A fully fleshed-out tour description that is long enough.',
  coverPhoto: null,
  photos: ['https://res.cloudinary.com/x/image/upload/v1/a.jpg'],
  tags: ['nature'],
  metaTitle: null,
  metaDescription: null,
  categorization: { category: 'Adventure' },
  theme: { primaryTheme: 'Nature' },
  productContent: {
    writingLanguage: 'English',
    highlights: ['Scenic views'],
    meetingMode: 'meeting_point',
    meetingPoint: { name: 'Gate', address: 'Main Rd' },
  },
  schedulesAndPricing: { travelerDetails: {} },
  bookingAndTickets: { meetingPoint: { name: 'Gate', address: 'Main Rd' } },
  status: 'ACTIVE',
  supplierId: 'supplier-1',
  draftSubmittedAt: null,
  draftStatus: null,
  draftContent: null,
};

describe('tourDraft utils', () => {
  it('computes a sectioned diff between live and draft', () => {
    const diff = tourDraft.buildTourDiff(
      liveRow,
      { ...liveRow, title: 'Live Safari 2', productContent: { ...liveRow.productContent, highlights: ['Scenic views', 'Wildlife'] } }
    );
    const paths = diff.map((d) => d.path);
    expect(paths).toContain('title');
    expect(paths).toContain('productContent.highlights[1]');
  });

  it('summarizes which sections changed', () => {
    const diff = tourDraft.buildTourDiff(liveRow, { ...liveRow, description: 'changed' });
    const summary = tourDraft.computeChangesSummary(diff);
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.sections.some((s) => s.section === 'description')).toBe(true);
  });

  it('reports photo additions and removals in a single entry', () => {
    const draft = { ...liveRow, photos: ['https://res.cloudinary.com/x/image/upload/v1/a.jpg', 'https://res.cloudinary.com/x/image/upload/v1/b.jpg'] };
    const diff = tourDraft.buildTourDiff(liveRow, draft);
    const photo = diff.find((d) => d.path === 'photos');
    expect(photo).toBeDefined();
    expect(photo.before).toContain('removed');
    expect(photo.after).toContain('added');
  });
});

describe('updateTour (draft path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { id: 'tour-1' }, body: { title: 'Edited Title' }, supplierId: 'supplier-1', files: [] };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
    validateTourData.mockReturnValue({ isValid: true });
    prisma.tour.findFirst
      .mockResolvedValueOnce({ id: 'tour-1', status: 'ACTIVE', photos: liveRow.photos, title: liveRow.title })
      .mockResolvedValue({ ...liveRow, draftContent: null });
    prisma.tour.update.mockResolvedValue({ ...liveRow, draftStatus: 'DRAFT', draftContent: { title: 'Edited Title' } });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
  });

  it('writes edits to draftContent and keeps status ACTIVE when editing a live tour', async () => {
    await tourController.updateTour(req, res, next);

    expect(prisma.tour.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tour-1' },
        data: expect.objectContaining({ draftStatus: 'DRAFT', draftContent: expect.objectContaining({ title: 'Edited Title' }) }),
      })
    );

    const updateData = prisma.tour.update.mock.calls[0][0].data;
    expect(updateData.status).toBeUndefined();
    expect(updateData.title).toBeUndefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();

    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'tour.draft_saved' }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.tour.draftStatus).toBe('DRAFT');
  });

  it('does not take the draft path when the supplier archives a live tour', async () => {
    req.body.status = 'ARCHIVED';
    prisma.tour.update.mockResolvedValue({ ...liveRow, status: 'ARCHIVED' });
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    await tourController.updateTour(req, res, next);

    expect(prisma.$transaction).toHaveBeenCalled();
    const draftCall = prisma.tour.update.mock.calls.find((c) => c[0] && c[0].data && c[0].data.draftStatus === 'DRAFT');
    expect(draftCall).toBeUndefined();
  });
});

describe('submitTourForReview (live tour with draft)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { id: 'tour-1' }, supplierId: 'supplier-1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
    validateStoredPricing.mockReturnValue([]);
    prisma.payoutMethod.findFirst = jest.fn().mockResolvedValue({ id: 'pm-1' });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  });

  it('keeps the live tour ACTIVE and moves only the draft to PENDING_APPROVAL', async () => {
    const withDraft = { ...liveRow, draftContent: { ...liveRow, title: 'Edited Title' } };
    prisma.tour.findFirst.mockResolvedValue({ ...withDraft, supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });
    prisma.tour.update.mockResolvedValue({ ...withDraft, draftSubmittedAt: new Date(), draftStatus: 'PENDING_APPROVAL', supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });

    await tourController.submitTourForReview(req, res, next);

    expect(prisma.tour.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ACTIVE',
          draftStatus: 'PENDING_APPROVAL',
          draftSubmittedAt: expect.any(Date),
        }),
      })
    );
    expect(cache.invalidateTourCaches).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isResubmission: true, changesSummary: expect.objectContaining({ count: expect.any(Number) }) }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still transitions a non-live tour to PENDING_APPROVAL (existing behavior)', async () => {
    prisma.tour.findFirst.mockResolvedValue({ ...liveRow, status: 'DRAFT', supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });
    prisma.tour.update.mockResolvedValue({ ...liveRow, status: 'PENDING_APPROVAL', supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });

    await tourController.submitTourForReview(req, res, next);

    expect(prisma.tour.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING_APPROVAL' }) })
    );
    expect(notifyAdmin.mock.calls[0][0].data.isResubmission).toBe(false);
  });

  it('persists the submitted payload into draftContent and validates it (live tour)', async () => {
    const withDraft = { ...liveRow, draftContent: { ...liveRow, title: 'Old Draft' } };
    prisma.tour.findFirst.mockResolvedValue({ ...withDraft, supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });
    prisma.tour.update.mockResolvedValue({ ...withDraft, draftSubmittedAt: new Date(), draftStatus: 'PENDING_APPROVAL', supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });
    req.body = { title: 'Newly Edited Title', schedulesAndPricing: { travelerDetails: { pricingCategories: [{ name: 'Child', price: 50 }] } } };

    await tourController.submitTourForReview(req, res, next);

    const updateCall = prisma.tour.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('ACTIVE');
    expect(updateCall.data.draftStatus).toBe('PENDING_APPROVAL');
    expect(updateCall.data.draftContent.title).toBe('Newly Edited Title');
    expect(updateCall.data.draftContent.photos).toEqual(liveRow.photos);
    expect(validateStoredPricing).toHaveBeenCalledWith(
      expect.objectContaining({ travelerDetails: expect.objectContaining({ pricingCategories: expect.any(Array) }) })
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rolls back when the submitted payload fails review validation (no update)', async () => {
    const withDraft = { ...liveRow, draftContent: { ...liveRow, title: 'Old Draft' } };
    prisma.tour.findFirst.mockResolvedValue({ ...withDraft, supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });
    req.body = { title: 'Has Bad Pricing', schedulesAndPricing: { travelerDetails: { pricingCategories: [{ name: 'Child', price: null }] } } };
    validateStoredPricing.mockReturnValue(['Pricing category "Child": price is required']);

    await tourController.submitTourForReview(req, res, next);

    expect(next).toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('Cannot submit for review');
    expect(prisma.tour.update).not.toHaveBeenCalled();
  });

  it('blocks resubmitting while a draft is already pending approval (409)', async () => {
    prisma.tour.findFirst.mockResolvedValue({
      ...liveRow,
      draftStatus: 'PENDING_APPROVAL',
      draftContent: { ...liveRow, title: 'Pending' },
      supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null },
    });
    req.body = { title: 'New Edit While Pending' };

    await tourController.submitTourForReview(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('pending review');
    expect(prisma.tour.update).not.toHaveBeenCalled();
  });

  it('persists a submitted payload into the live columns for a non-live tour', async () => {
    prisma.tour.findFirst.mockResolvedValue({ ...liveRow, status: 'DRAFT', supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });
    prisma.tour.update.mockResolvedValue({ ...liveRow, status: 'PENDING_APPROVAL', supplier: { id: 'supplier-1', name: 'Supplier', photoURL: null } });
    req.body = { title: 'Draft Tour Name', schedulesAndPricing: { travelerDetails: {} } };

    await tourController.submitTourForReview(req, res, next);

    const updateCall = prisma.tour.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('PENDING_APPROVAL');
    expect(updateCall.data.title).toBe('Draft Tour Name');
    expect(updateCall.data.photos).toEqual(liveRow.photos);
  });
});

describe('getTourDraft', () => {
  it('returns live, draft, and a computed diff', async () => {
    jest.clearAllMocks();
    prisma.tour.findFirst.mockResolvedValue({ ...liveRow, draftContent: { ...liveRow, title: 'Edited Title' } });
    req = { params: { id: 'tour-1' }, supplierId: 'supplier-1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await tourController.getTourDraft(req, res, next);

    const data = res.json.mock.calls[0][0].data;
    expect(data.live.title).toBe('Live Safari');
    expect(data.draft.title).toBe('Edited Title');
    expect(Array.isArray(data.diff)).toBe(true);
    expect(data.changesSummary.count).toBe(data.diff.length);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns an empty diff when there is no draft', async () => {
    jest.clearAllMocks();
    prisma.tour.findFirst.mockResolvedValue({ ...liveRow, draftContent: null });
    req = { params: { id: 'tour-1' }, supplierId: 'supplier-1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await tourController.getTourDraft(req, res, next);

    const data = res.json.mock.calls[0][0].data;
    expect(data.draft).toBeNull();
    expect(data.diff).toEqual([]);
  });
});

describe('admin draft review', () => {
  const adminController = require('../../controllers/adminController');

  it('merges an approved draft into the live columns and notifies the supplier', async () => {
    jest.clearAllMocks();
    prisma.tour.findUnique.mockResolvedValue({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, title: 'Edited Title' }, supplier: { id: 'supplier-1' } });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.tour.update.mockResolvedValue({ ...liveRow, title: 'Edited Title' });
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    req = { params: { id: 'tour-1' }, body: { action: 'approve' }, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await adminController.reviewTourDraft(req, res, next);

    const updateCall = prisma.tour.update.mock.calls.find((c) => c[0] && c[0].data && c[0].data.status === 'ACTIVE');
    expect(updateCall).toBeDefined();
    expect(updateCall[0].data.title).toBe('Edited Title');
    expect(updateCall[0].data.draftStatus).toBeNull();
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'tour.draft_approved' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('flags a draft without touching the live version', async () => {
    jest.clearAllMocks();
    prisma.tour.findUnique.mockResolvedValue({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow }, supplier: { id: 'supplier-1' } });
    prisma.tour.update.mockResolvedValue({ ...liveRow, draftStatus: 'REJECTED', draftReviewNote: 'fix pricing' });

    req = { params: { id: 'tour-1' }, body: { action: 'flag', reason: 'fix pricing' }, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await adminController.reviewTourDraft(req, res, next);

    expect(prisma.tour.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ draftStatus: 'REJECTED', draftReviewNote: 'fix pricing' }) })
    );
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'tour.draft_flagged' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('is idempotent when a concurrent request already approved the draft', async () => {
    jest.clearAllMocks();
    // Top-level read sees PENDING_APPROVAL, but by the time the row lock is
    // acquired inside the tx the draft has already been approved (null).
    prisma.tour.findUnique
      .mockResolvedValueOnce({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, title: 'Edited Title' }, supplier: { id: 'supplier-1' } })
      .mockResolvedValue({ ...liveRow, draftStatus: null, draftContent: { ...liveRow, title: 'Edited Title' } });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    req = { params: { id: 'tour-1' }, body: { action: 'approve' }, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await adminController.reviewTourDraft(req, res, next);

    expect(prisma.tour.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.alreadyProcessed).toBe(true);
  });

  it('is idempotent on a second flag of the same draft', async () => {
    jest.clearAllMocks();
    prisma.tour.findUnique
      .mockResolvedValueOnce({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, title: 'Edited Title' }, supplier: { id: 'supplier-1' } })
      .mockResolvedValue({ ...liveRow, draftStatus: 'REJECTED', draftContent: { ...liveRow, title: 'Edited Title' } });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    req = { params: { id: 'tour-1' }, body: { action: 'flag', reason: 'fix pricing' }, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await adminController.reviewTourDraft(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.alreadyProcessed).toBe(true);
    expect(prisma.tour.update).not.toHaveBeenCalled();
  });

  it('rejects approval with a 400 when the draft has no changes', async () => {
    jest.clearAllMocks();
    prisma.tour.findUnique
      .mockResolvedValueOnce({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow }, supplier: { id: 'supplier-1' } })
      .mockResolvedValue({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow } });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    req = { params: { id: 'tour-1' }, body: { action: 'approve' }, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await adminController.reviewTourDraft(req, res, next);

    expect(prisma.tour.update).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('no changes') }));
  });

  it('rejects approval with a 400 when the draft theme is malformed JSON', async () => {
    jest.clearAllMocks();
    prisma.tour.findUnique
      .mockResolvedValueOnce({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, theme: 'not-json{{' }, supplier: { id: 'supplier-1' } })
      .mockResolvedValue({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, theme: 'not-json{{' } });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    req = { params: { id: 'tour-1' }, body: { action: 'approve' }, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await adminController.reviewTourDraft(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('theme') }));
  });

  it('invalidates the expedition detail key for both the old and regenerated slug on approval', async () => {
    jest.clearAllMocks();
    prisma.tour.findUnique
      .mockResolvedValueOnce({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, title: 'Edited Title' }, supplier: { id: 'supplier-1' } })
      .mockResolvedValue({ ...liveRow, slug: 'old-slug', draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, title: 'Edited Title' } });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    // The title changed, so buildLiveUpdateData regenerates the slug.
    prisma.tour.update.mockResolvedValue({ ...liveRow, slug: 'new-slug', title: 'Edited Title', status: 'ACTIVE' });
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    req = { params: { id: 'tour-1' }, body: { action: 'approve' }, user: { id: 'admin-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    await adminController.reviewTourDraft(req, res, next);

    const calls = cache.invalidateTourCaches.mock.calls;
    const slugArgs = calls.map((c) => c[1]).filter(Boolean);
    expect(slugArgs).toEqual(expect.arrayContaining(['old-slug', 'new-slug']));
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('edit-while-pending lock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { id: 'tour-1' }, body: { title: 'Edited Title' }, supplierId: 'supplier-1', files: [] };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
    validateTourData.mockReturnValue({ isValid: true });
  });

  it('blocks editing a tour that is currently pending approval (409)', async () => {
    prisma.tour.findFirst
      .mockResolvedValueOnce({ id: 'tour-1', status: 'ACTIVE', photos: liveRow.photos, title: liveRow.title })
      .mockResolvedValue({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, title: 'Pending' } });

    await tourController.updateTour(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(prisma.tour.update).not.toHaveBeenCalled();
  });

  it('allows editing once the draft has been withdrawn back to DRAFT', async () => {
    prisma.tour.findFirst
      .mockResolvedValueOnce({ id: 'tour-1', status: 'ACTIVE', photos: liveRow.photos, title: liveRow.title })
      .mockResolvedValue({ ...liveRow, draftStatus: 'DRAFT', draftContent: { ...liveRow, title: 'Pending' } });
    prisma.tour.update.mockResolvedValue({ ...liveRow, draftStatus: 'DRAFT', draftContent: { title: 'Edited Title' } });

    await tourController.updateTour(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const draftCall = prisma.tour.update.mock.calls.find((c) => c[0] && c[0].data && c[0].data.draftStatus === 'DRAFT');
    expect(draftCall).toBeDefined();
  });

  it('blocks editing a NEW tour that is awaiting approval (409, non-draft path)', async () => {
    // A new tour awaiting admin review has status PENDING_APPROVAL but no
    // draft row (draftStatus null) — the non-draft update path must still lock.
    prisma.tour.findFirst
      .mockResolvedValueOnce({ id: 'tour-1', status: 'PENDING_APPROVAL', photos: liveRow.photos, title: liveRow.title })
      .mockResolvedValue({ ...liveRow, status: 'PENDING_APPROVAL', draftStatus: null });
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    await tourController.updateTour(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    expect(prisma.tour.update).not.toHaveBeenCalled();
  });
});

describe('withdrawTourForReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { id: 'tour-1' }, supplierId: 'supplier-1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'tour-1' }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  });

  it('returns a live tour with a pending edit back to DRAFT', async () => {
    prisma.tour.findFirst.mockResolvedValue({ ...liveRow, draftStatus: 'PENDING_APPROVAL', draftContent: { ...liveRow, title: 'Edited' } });
    prisma.tour.update.mockResolvedValue({ ...liveRow, draftStatus: 'DRAFT' });

    await tourController.withdrawTourForReview(req, res, next);

    const updateCall = prisma.tour.update.mock.calls[0][0];
    expect(updateCall.data.draftStatus).toBe('DRAFT');
    expect(updateCall.data.status).toBeUndefined();
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'tour.withdrawn_from_review' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns a new tour awaiting approval back to DRAFT', async () => {
    prisma.tour.findFirst.mockResolvedValue({ ...liveRow, status: 'PENDING_APPROVAL', draftStatus: null });
    prisma.tour.update.mockResolvedValue({ ...liveRow, status: 'DRAFT' });

    await tourController.withdrawTourForReview(req, res, next);

    const updateCall = prisma.tour.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('DRAFT');
    expect(updateCall.data.draftStatus).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects withdrawing a tour that is not awaiting review', async () => {
    prisma.tour.findFirst.mockResolvedValue({ ...liveRow, status: 'ACTIVE', draftStatus: 'DRAFT' });

    await tourController.withdrawTourForReview(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(prisma.tour.update).not.toHaveBeenCalled();
  });
});