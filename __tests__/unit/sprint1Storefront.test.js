/**
 * Sprint 1 conversion sweeps — the guards that keep these from mailing real
 * customers by accident or twice.
 *
 * Each service is flag-gated (a deploy must be a no-op until the flag is on),
 * claim-before-send (idempotent under at-least-once delivery), and honest about
 * what it can measure (no wishlist baseline → no price alert; an open date is
 * "book it now", not a waitlist join).
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  checkoutDraft: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  wishlistItem: { findMany: jest.fn(), updateMany: jest.fn() },
  waitlistEntry: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
  booking: { findFirst: jest.fn() },
  review: { count: jest.fn() },
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendCheckoutRecoveryEmail: jest.fn(),
  sendWishlistPriceDropEmail: jest.fn(),
  sendWaitlistOpenEmail: jest.fn(),
}));

jest.mock('../../src/core/services/notificationService', () => ({
  sendNotification: jest.fn(),
}));

jest.mock('../../src/core/services/tourHelpers', () => ({
  cheapestRetailPrice: jest.fn(),
  checkTourAvailability: jest.fn(),
}));

jest.mock('../../src/core/services/availabilityCore', () => ({
  toDateKey: (d) => new Date(d).toISOString().slice(0, 10),
}));

const prisma = require('../../src/core/services/prismaClient');
const {
  sendCheckoutRecoveryEmail,
  sendWishlistPriceDropEmail,
  sendWaitlistOpenEmail,
} = require('../../src/core/services/emailService');
const { sendNotification } = require('../../src/core/services/notificationService');
const { cheapestRetailPrice, checkTourAvailability } = require('../../src/core/services/tourHelpers');
const { recoverAbandonedCheckouts } = require('../../src/core/services/checkoutRecovery');
const { checkWishlistPriceDrops } = require('../../src/core/services/wishlistAlerts');
const { joinWaitlist, notifyWaitlistOpenDates } = require('../../src/core/services/waitlistService');
const { isEnabled } = require('../../src/core/services/featureFlags');

const releasedDraft = (overrides = {}) => ({
  id: 'draft_1',
  tourId: 'tour_1',
  travelDate: new Date('2026-11-04T00:00:00.000Z'),
  selectedTime: '09:00',
  seats: 2,
  status: 'EXPIRED',
  abandonedNotifiedAt: null,
  bookingId: null,
  currency: 'USD',
  stripeSessionId: 'pi_123',
  paypalOrderId: null,
  payload: { _source: 'GHANA', _clientOrigin: 'https://www.travioghana.com', travelers: { adults: 2 } },
  pricing: { total: 85 },
  customer: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  guestEmail: null,
  ...overrides,
});

const savedItem = (overrides = {}) => ({
  id: 'wi_1',
  userId: 'u1',
  tourId: 'tour_1',
  priceAtSave: 85,
  currency: 'USD',
  lastPriceAlertAt: null,
  addedAt: new Date(Date.now() - 48 * 3600 * 1000),
  tour: { id: 'tour_1', slug: 'accra-tour', title: 'Accra Tour', status: 'ACTIVE', schedulesAndPricing: '{}' },
  user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  ...overrides,
});

describe('abandoned checkout recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FF_CHECKOUT_RECOVERY;
    sendCheckoutRecoveryEmail.mockResolvedValue({ id: 'msg' });
  });

  it('does nothing while the flag is off', async () => {
    const result = await recoverAbandonedCheckouts();
    expect(result.disabled).toBe(true);
    expect(prisma.checkoutDraft.findMany).not.toHaveBeenCalled();
  });

  it('emails released drafts exactly once, claiming before sending', async () => {
    process.env.FF_CHECKOUT_RECOVERY = '1';
    const draft = releasedDraft();
    prisma.checkoutDraft.findMany.mockResolvedValue([draft]);
    prisma.checkoutDraft.updateMany.mockResolvedValue({ count: 1 });
    prisma.checkoutDraft.findUnique.mockResolvedValue({ bookingId: null, status: 'EXPIRED' });

    const result = await recoverAbandonedCheckouts();

    expect(result.sent).toBe(1);
    expect(sendCheckoutRecoveryEmail).toHaveBeenCalledTimes(1);
    // The claim happens before the send — that is what makes a racing second
    // worker skip instead of double-mailing.
    expect(prisma.checkoutDraft.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft_1', abandonedNotifiedAt: null } })
    );
    expect(prisma.checkoutDraft.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(sendCheckoutRecoveryEmail.mock.invocationCallOrder[0]);
  });

  it('skips when another worker claimed the draft first', async () => {
    process.env.FF_CHECKOUT_RECOVERY = '1';
    prisma.checkoutDraft.findMany.mockResolvedValue([releasedDraft()]);
    prisma.checkoutDraft.updateMany.mockResolvedValue({ count: 0 });

    const result = await recoverAbandonedCheckouts();

    expect(result.skipped).toBe(1);
    expect(sendCheckoutRecoveryEmail).not.toHaveBeenCalled();
  });

  it('never mails a draft that was settled between the query and the claim', async () => {
    process.env.FF_CHECKOUT_RECOVERY = '1';
    prisma.checkoutDraft.findMany.mockResolvedValue([releasedDraft()]);
    prisma.checkoutDraft.updateMany.mockResolvedValue({ count: 1 });
    // The webhook landed after the sweep read the row.
    prisma.checkoutDraft.findUnique.mockResolvedValue({ bookingId: 'b_1', status: 'PAID' });

    const result = await recoverAbandonedCheckouts();

    expect(result.skipped).toBe(1);
    expect(sendCheckoutRecoveryEmail).not.toHaveBeenCalled();
  });

  it('leaves the claim in place when the send fails permanently', async () => {
    process.env.FF_CHECKOUT_RECOVERY = '1';
    prisma.checkoutDraft.findMany.mockResolvedValue([releasedDraft()]);
    prisma.checkoutDraft.updateMany.mockResolvedValue({ count: 1 });
    prisma.checkoutDraft.findUnique.mockResolvedValue({ bookingId: null, status: 'EXPIRED' });
    sendCheckoutRecoveryEmail.mockRejectedValue(new Error('hard bounce'));

    const result = await recoverAbandonedCheckouts();

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    // The claim was already written, so the next sweep will not retry it.
    expect(prisma.checkoutDraft.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('wishlist price alerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FF_PRICE_ALERTS;
    sendWishlistPriceDropEmail.mockResolvedValue({ id: 'msg' });
    sendNotification.mockResolvedValue({ success: true });
  });

  it('does nothing while the flag is off', async () => {
    const result = await checkWishlistPriceDrops();
    expect(result.disabled).toBe(true);
    expect(prisma.wishlistItem.findMany).not.toHaveBeenCalled();
  });

  it('alerts on a real drop and moves the baseline to the new price', async () => {
    process.env.FF_PRICE_ALERTS = '1';
    cheapestRetailPrice.mockReturnValue(68);
    prisma.wishlistItem.findMany.mockResolvedValue([savedItem()]);
    prisma.wishlistItem.updateMany.mockResolvedValue({ count: 1 });

    const result = await checkWishlistPriceDrops();

    expect(result.sent).toBe(1);
    expect(sendWishlistPriceDropEmail).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', oldPrice: 85, newPrice: 68, currency: 'USD' })
    );
    // Baseline moves: the next alert must be another real drop, not the same
    // saving re-mailed every day.
    expect(prisma.wishlistItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastPriceAlertAt: expect.any(Date), priceAtSave: 68 } })
    );
  });

  it('stays silent when the price has not actually fallen', async () => {
    process.env.FF_PRICE_ALERTS = '1';
    cheapestRetailPrice.mockReturnValue(85);
    prisma.wishlistItem.findMany.mockResolvedValue([savedItem()]);

    const result = await checkWishlistPriceDrops();

    expect(result.sent).toBe(0);
    expect(sendWishlistPriceDropEmail).not.toHaveBeenCalled();
    expect(prisma.wishlistItem.updateMany).not.toHaveBeenCalled();
  });

  it('never scans rows saved before the baseline existed', async () => {
    process.env.FF_PRICE_ALERTS = '1';
    prisma.wishlistItem.findMany.mockResolvedValue([]);

    await checkWishlistPriceDrops();

    // The guarantee lives in the query: a row with no baseline is never a
    // candidate, so it can never reach the price comparison.
    expect(prisma.wishlistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ priceAtSave: { not: null } }) })
    );
    expect(cheapestRetailPrice).not.toHaveBeenCalled();
  });

  it('skips a tour that is no longer bookable rather than mailing a dead link', async () => {
    process.env.FF_PRICE_ALERTS = '1';
    prisma.wishlistItem.findMany.mockResolvedValue([
      savedItem({ tour: { ...savedItem().tour, status: 'ARCHIVED' } }),
    ]);

    const result = await checkWishlistPriceDrops();

    expect(result.skipped).toBe(1);
    expect(sendWishlistPriceDropEmail).not.toHaveBeenCalled();
  });

  it('does not alert when another worker already claimed the row', async () => {
    process.env.FF_PRICE_ALERTS = '1';
    cheapestRetailPrice.mockReturnValue(68);
    prisma.wishlistItem.findMany.mockResolvedValue([savedItem()]);
    prisma.wishlistItem.updateMany.mockResolvedValue({ count: 0 });

    const result = await checkWishlistPriceDrops();

    expect(result.sent).toBe(0);
    expect(sendWishlistPriceDropEmail).not.toHaveBeenCalled();
  });
});

describe('waitlist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FF_WAITLIST;
    prisma.tour.findUnique.mockResolvedValue({ id: 'tour_1', status: 'ACTIVE' });
    prisma.waitlistEntry.findUnique.mockResolvedValue(null);
    prisma.waitlistEntry.create.mockResolvedValue({ id: 'w_1' });
    sendWaitlistOpenEmail.mockResolvedValue({ id: 'msg' });
    sendNotification.mockResolvedValue({ success: true });
  });

  it('refuses to join while the flag is off', async () => {
    const result = await joinWaitlist({ tourId: 'tour_1', travelDate: '2026-12-31', email: 'a@b.com' });
    expect(result.ok).toBe(false);
  });

  it('rejects an open date — that is "book it now", not a waitlist', async () => {
    process.env.FF_WAITLIST = '1';
    checkTourAvailability.mockResolvedValue({ available: true });

    const result = await joinWaitlist({ tourId: 'tour_1', travelDate: '2026-12-31', email: 'a@b.com' });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/still available/i);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('joins a full date and is idempotent for the same email', async () => {
    process.env.FF_WAITLIST = '1';
    checkTourAvailability.mockResolvedValue({ available: false, reason: 'Date is fully booked' });

    const first = await joinWaitlist({ tourId: 'tour_1', travelDate: '2026-12-31', email: 'A@B.com' });
    expect(first.ok).toBe(true);
    expect(first.alreadyJoined).toBe(false);
    // Email is normalised so the unique key cannot be bypassed with casing.
    expect(prisma.waitlistEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'a@b.com' }) })
    );

    prisma.waitlistEntry.findUnique.mockResolvedValue({ id: 'w_1', cancelledAt: null });
    const second = await joinWaitlist({ tourId: 'tour_1', travelDate: '2026-12-31', email: 'a@b.com' });
    expect(second.ok).toBe(true);
    expect(second.alreadyJoined).toBe(true);
    expect(prisma.waitlistEntry.create).toHaveBeenCalledTimes(1);
  });

  it('validates the email instead of accepting anything', async () => {
    process.env.FF_WAITLIST = '1';
    const result = await joinWaitlist({ tourId: 'tour_1', travelDate: '2026-12-31', email: 'not-an-email' });
    expect(result.ok).toBe(false);
    expect(prisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('notifies waiting entries once the date reopens, and claims each one first', async () => {
    process.env.FF_WAITLIST = '1';
    const entry = {
      id: 'w_1',
      userId: 'u1',
      email: 'a@b.com',
      tourId: 'tour_1',
      travelDate: new Date('2026-12-31T00:00:00.000Z'),
      tour: { id: 'tour_1', slug: 'accra-tour', title: 'Accra Tour', schedulesAndPricing: '{}' },
    };
    prisma.waitlistEntry.findMany
      .mockResolvedValueOnce([{ tourId: 'tour_1', travelDate: entry.travelDate }])
      .mockResolvedValueOnce([entry]);
    prisma.waitlistEntry.updateMany.mockResolvedValue({ count: 1 });
    checkTourAvailability.mockResolvedValue({ available: true });

    const result = await notifyWaitlistOpenDates();

    expect(result.notified).toBe(1);
    expect(sendWaitlistOpenEmail).toHaveBeenCalledWith(
      expect.objectContaining({ entry, dateLabel: expect.any(String) })
    );
    // Claim before send: a crashed run must not mail the same person twice.
    expect(prisma.waitlistEntry.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(sendWaitlistOpenEmail.mock.invocationCallOrder[0]);
  });

  it('says nothing while the date is still full', async () => {
    process.env.FF_WAITLIST = '1';
    prisma.waitlistEntry.findMany.mockResolvedValueOnce([{ tourId: 'tour_1', travelDate: new Date() }]);
    checkTourAvailability.mockResolvedValue({ available: false, reason: 'Date is fully booked' });

    const result = await notifyWaitlistOpenDates();

    expect(result.notified).toBe(0);
    expect(sendWaitlistOpenEmail).not.toHaveBeenCalled();
    expect(prisma.waitlistEntry.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('feature flags', () => {
  beforeEach(() => delete process.env.FF_GUEST_CHECKOUT);

  it('defaults to off so a deploy cannot enable anything by itself', () => {
    expect(isEnabled('guestCheckout')).toBe(false);
  });

  it('accepts the usual truthy spellings and rejects everything else', () => {
    process.env.FF_GUEST_CHECKOUT = '1';
    expect(isEnabled('guestCheckout')).toBe(true);
    process.env.FF_GUEST_CHECKOUT = 'true';
    expect(isEnabled('guestCheckout')).toBe(true);
    process.env.FF_GUEST_CHECKOUT = 'ON';
    expect(isEnabled('guestCheckout')).toBe(true);
    process.env.FF_GUEST_CHECKOUT = '0';
    expect(isEnabled('guestCheckout')).toBe(false);
    process.env.FF_GUEST_CHECKOUT = 'banana';
    expect(isEnabled('guestCheckout')).toBe(false);
  });

  it('never enables an unknown flag name', () => {
    process.env.FF_NOPE = '1';
    expect(isEnabled('nope')).toBe(false);
  });
});
