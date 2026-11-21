/**
 * The header badge.
 *
 * The bell used to download the whole feed every minute just to count it. This
 * pins the dedicated endpoint: one number, scoped to the member's allowed
 * categories, and scoped to the user — a team member must not see the owner's
 * unread total.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  notification: { count: jest.fn(), findMany: jest.fn() },
}));

const prisma = require('../../src/core/services/prismaClient');
const makeSupplierController = require('../../src/core/supplier');

const controller = makeSupplierController('ghana');

const req = (over = {}) => ({
  query: {},
  user: { id: 'user-1' },
  teamContext: null,
  ...over,
});

const res = () => {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return response;
};

describe('supplier getUnreadNotificationCount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.notification.count.mockResolvedValue(4);
    prisma.notification.findMany.mockResolvedValue([]);
  });

  it('counts only this user’s unread notifications', async () => {
    const response = res();

    await controller.getUnreadNotificationCount(req(), response, jest.fn());

    const where = prisma.notification.count.mock.calls[0][0].where;
    expect(where.userId).toBe('user-1');
    expect(where.readAt).toBeNull();
    expect(response.json).toHaveBeenCalledWith({
      status: 'success',
      data: { unreadCount: 4 },
    });
  });

  it('applies a team role’s notification categories', async () => {
    const response = res();

    await controller.getUnreadNotificationCount(
      req({ teamContext: { notificationCategories: ['bookings'] } }),
      response,
      jest.fn(),
    );

    const where = prisma.notification.count.mock.calls[0][0].where;
    expect(where.userId).toBe('user-1');
    expect(where.type.in).toContain('BOOKING_CONFIRMED');
    // A member limited to bookings must not be told about payouts.
    expect(where.type.in).not.toContain('PAYOUT_PROCESSED');
  });
});

describe('supplier getNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.notification.count.mockResolvedValue(0);
    prisma.notification.findMany.mockResolvedValue([]);
  });

  it('honours the Unread tab the page has always asked for', async () => {
    const response = res();

    await controller.getNotifications(
      req({ query: { unreadOnly: 'true' } }),
      response,
      jest.fn(),
    );

    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.read).toBe(false);
    expect(where.userId).toBe('user-1');
  });

  it('leaves the list unfiltered when the tab is All', async () => {
    const response = res();

    await controller.getNotifications(
      req({ query: { unreadOnly: 'false' } }),
      response,
      jest.fn(),
    );

    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.read).toBeUndefined();
  });
});
