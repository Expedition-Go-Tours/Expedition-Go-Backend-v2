/**
 * 30-day documentation window reminders — reminders only, never enforcement.
 *
 * The daily sweep must remind at T-7 / T-3 / day-of, never double-notify
 * (VerificationEvent sentinel), and never nudge a supplier who has already
 * provided everything the window asks for.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  supplierProfile: { findMany: jest.fn() },
  supplierDocument: { findMany: jest.fn() },
  vehicle: { findMany: jest.fn() },
  guide: { findMany: jest.fn() },
  verificationEvent: { findFirst: jest.fn(), create: jest.fn().mockResolvedValue({}) },
  user: { findUnique: jest.fn() },
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({}),
  resolveEmailBrand: jest.fn(() => ({ brandName: 'TravioGhana' })),
}));
jest.mock('../../src/core/services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const { enqueueNotification } = require('../../src/core/services/queue');
const { sendEmail } = require('../../src/core/services/emailService');
const {
  planDocumentationWindowReminders,
  daysUntil,
} = require('../../src/core/services/documentationWindow');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A TOUR_COMPANY in Ghana selling tours — the richest "later" checklist. */
const companyProfile = (deadline, { status = 'ACTIVE' } = {}) => ({
  id: 'sp-1',
  userId: 'u-1',
  status,
  documentationDeadline: deadline.toISOString(),
  supplierType: 'TOUR_COMPANY',
  businessInfo: { supplierChoice: 'registered_company', businessType: 'company', country: 'GH' },
  operatingInfo: { services: ['Tours & Activities'] },
});

const ALL_SUPPLIER_LATER_TYPES = [
  'PROFILE_PHOTO',
  'PROOF_OF_ADDRESS',
  'GTA_CERTIFICATE',
  'PUBLIC_LIABILITY_INSURANCE',
];

const APPROVED_SUPPLIER_DOCS = ALL_SUPPLIER_LATER_TYPES.map((type) => ({
  ownerType: 'SUPPLIER',
  ownerId: null,
  type,
  status: 'APPROVED',
}));

describe('daysUntil', () => {
  const now = new Date('2026-09-28T12:00:00Z');

  it('counts whole UTC calendar days from now to the deadline', () => {
    expect(daysUntil(new Date(now.getTime() + 7 * MS_PER_DAY), now)).toBe(7);
    expect(daysUntil(new Date(now.getTime() + 3 * MS_PER_DAY), now)).toBe(3);
    expect(daysUntil(new Date(now.getTime() + MS_PER_DAY), now)).toBe(1);
    expect(daysUntil(new Date(now.getTime()), now)).toBe(0);
    expect(daysUntil(new Date(now.getTime() - MS_PER_DAY), now)).toBe(-1);
  });
});

describe('planDocumentationWindowReminders', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const deadlineIn = (days) => new Date(now.getTime() + days * MS_PER_DAY);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.supplierDocument.findMany.mockResolvedValue([]);
    prisma.vehicle.findMany.mockResolvedValue([]);
    prisma.guide.findMany.mockResolvedValue([]);
    prisma.verificationEvent.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-1', name: 'Kofi', email: 'kofi@example.com' });
  });

  it('only sweeps live suppliers that still have a documentation deadline', async () => {
    prisma.supplierProfile.findMany.mockResolvedValue([]);

    await planDocumentationWindowReminders(now);

    expect(prisma.supplierProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          documentationDeadline: { not: null },
          status: { in: ['ACTIVE', 'APPROVED'] },
        }),
      })
    );
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('sends the T-7 reminder with email + in-app notification, recording the sentinel', async () => {
    prisma.supplierProfile.findMany.mockResolvedValue([companyProfile(deadlineIn(7))]);

    const result = await planDocumentationWindowReminders(now);

    expect(result).toEqual({ remindersSent: 1 });
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        type: 'DOCUMENTATION_WINDOW_REMINDER',
        title: '7 days left to complete your documentation',
        data: expect.objectContaining({ supplierId: 'sp-1', daysLeft: 7 }),
      })
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'kofi@example.com', subject: 'Reminder: 7 days left to complete your documents' })
    );
    expect(prisma.verificationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        supplierId: 'sp-1',
        entityId: 'sp-1',
        action: 'DOCUMENTATION_WINDOW_REMINDER_7',
        actorId: 'SYSTEM',
      }),
    });
  });

  it('sends the T-3 reminder', async () => {
    prisma.supplierProfile.findMany.mockResolvedValue([companyProfile(deadlineIn(3))]);

    const result = await planDocumentationWindowReminders(now);

    expect(result).toEqual({ remindersSent: 1 });
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: '3 days left to complete your documentation' })
    );
    expect(prisma.verificationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DOCUMENTATION_WINDOW_REMINDER_3' }),
    });
  });

  it('sends the day-of reminder on the final day', async () => {
    prisma.supplierProfile.findMany.mockResolvedValue([companyProfile(deadlineIn(0))]);

    const result = await planDocumentationWindowReminders(now);

    expect(result).toEqual({ remindersSent: 1 });
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Your documentation window closes today',
        data: expect.objectContaining({ daysLeft: 0 }),
      })
    );
    expect(prisma.verificationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DOCUMENTATION_WINDOW_REMINDER_0' }),
    });
  });

  it('never double-notifies — a recorded sentinel skips the reminder', async () => {
    prisma.supplierProfile.findMany.mockResolvedValue([companyProfile(deadlineIn(7))]);
    prisma.verificationEvent.findFirst.mockResolvedValue({ id: 'ev-1' });

    const result = await planDocumentationWindowReminders(now);

    expect(result).toEqual({ remindersSent: 0 });
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(prisma.verificationEvent.create).not.toHaveBeenCalled();
  });

  it('skips suppliers who have already provided every required document', async () => {
    prisma.supplierProfile.findMany.mockResolvedValue([companyProfile(deadlineIn(7))]);
    prisma.supplierDocument.findMany.mockResolvedValue(APPROVED_SUPPLIER_DOCS);

    const result = await planDocumentationWindowReminders(now);

    expect(result).toEqual({ remindersSent: 0 });
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('counts outstanding per-vehicle documents when vehicles must be verified', async () => {
    const driverProfile = {
      id: 'sp-2',
      userId: 'u-2',
      status: 'ACTIVE',
      documentationDeadline: deadlineIn(7).toISOString(),
      supplierType: 'TRANSPORTATION_PROVIDER',
      businessInfo: { supplierChoice: 'transport_company', businessType: 'company', country: 'GH' },
      operatingInfo: { services: ['Airport Transfers'] },
    };
    prisma.supplierProfile.findMany.mockResolvedValue([driverProfile]);
    // Supplier-level later docs all on file…
    prisma.supplierDocument.findMany.mockResolvedValue([
      ...APPROVED_SUPPLIER_DOCS,
      { ownerType: 'SUPPLIER', ownerId: null, type: 'PASSENGER_TRANSPORT_LICENCE', status: 'APPROVED' },
      { ownerType: 'SUPPLIER', ownerId: null, type: 'DRIVERS_LICENCE', status: 'APPROVED' },
      { ownerType: 'VEHICLE', ownerId: 'v-1', type: 'VEHICLE_REGISTRATION', status: 'APPROVED' },
      { ownerType: 'VEHICLE', ownerId: 'v-1', type: 'VEHICLE_OWNERSHIP', status: 'APPROVED' },
      { ownerType: 'VEHICLE', ownerId: 'v-1', type: 'VEHICLE_INSURANCE', status: 'APPROVED' },
    ]);
    // …but the vehicle still lacks its roadworthiness certificate.
    prisma.vehicle.findMany.mockResolvedValue([{ id: 'v-1' }]);
    prisma.guide.findMany.mockResolvedValue([]);

    const result = await planDocumentationWindowReminders(now);

    // The vehicle's missing document keeps the reminder in scope.
    expect(result).toEqual({ remindersSent: 1 });
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outstandingDocuments: 1 }) })
    );
  });

  it('does not remind outside the T-7 / T-3 / day-of windows', async () => {
    for (const days of [1, 2, 4, 5, 6, 8, 12, -2]) {
      jest.clearAllMocks();
      prisma.supplierDocument.findMany.mockResolvedValue([]);
      prisma.vehicle.findMany.mockResolvedValue([]);
      prisma.guide.findMany.mockResolvedValue([]);
      prisma.verificationEvent.findFirst.mockResolvedValue(null);
      prisma.supplierProfile.findMany.mockResolvedValue([companyProfile(deadlineIn(days))]);

      const result = await planDocumentationWindowReminders(now);

      expect(result).toEqual({ remindersSent: 0 });
      expect(enqueueNotification).not.toHaveBeenCalled();
      expect(prisma.verificationEvent.create).not.toHaveBeenCalled();
    }
  });

  it('returns zero when no profiles have a deadline', async () => {
    prisma.supplierProfile.findMany.mockResolvedValue([]);

    const result = await planDocumentationWindowReminders(now);

    expect(result).toEqual({ remindersSent: 0 });
  });
});