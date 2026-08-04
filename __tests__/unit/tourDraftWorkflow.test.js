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
  durationToMinutes: jest.fn(),
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
});