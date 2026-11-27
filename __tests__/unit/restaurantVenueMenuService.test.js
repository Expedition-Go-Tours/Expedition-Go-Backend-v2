/**
 * Structured menus.
 *
 * Prices are integer minor units and `null` means market price, so the tests
 * pin that a float or a negative is refused rather than rounded. Publishing is
 * also gated: an empty menu must not replace a live one.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $transaction: jest.fn(),
  restaurantMenu: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  restaurantMenuSection: { create: jest.fn(), deleteMany: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateRestaurantVenueCaches: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/queue', () => ({ enqueueEvent: jest.fn() }));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/restaurantVenueAccess', () => ({
  assertPermission: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const menus = require('../../src/core/services/restaurantVenueMenuService');

const CONTEXT = {
  venue: { id: 'v1', slug: 'buka-accra', name: 'Buka', menuUrl: null },
  membership: { id: 'm1', userId: 'u1', role: 'OWNER' },
  permissions: ['menu.manage'],
};

function menuRow(overrides = {}) {
  return {
    id: 'menu1',
    name: 'Main menu',
    description: null,
    status: 'DRAFT',
    currency: 'GHS',
    position: 1,
    publishedAt: null,
    updatedAt: new Date('2026-11-20T10:00:00Z'),
    sections: [
      {
        id: 's1',
        title: 'Starters',
        description: null,
        position: 0,
        items: [
          {
            id: 'i1',
            name: 'Kelewele',
            description: null,
            priceMinor: 2500,
            currency: 'GHS',
            dietary: ['Vegan'],
            isAvailable: true,
            position: 0,
            photoUrl: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

const VALID_BODY = {
  name: 'Main menu',
  currency: 'GHS',
  sections: [
    {
      title: 'Starters',
      items: [{ name: 'Kelewele', priceMinor: 2500, dietary: ['Vegan'] }],
    },
  ],
};

describe('restaurantVenueMenuService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    prisma.restaurantMenu.count.mockResolvedValue(0);
    prisma.restaurantMenu.findFirst.mockResolvedValue(null);
    prisma.restaurantMenu.create.mockResolvedValue({ id: 'menu1', position: 1 });
    prisma.restaurantMenuSection.create.mockResolvedValue({});
    prisma.restaurantMenu.findUnique.mockResolvedValue(menuRow());
  });

  it('stores prices as integer minor units', async () => {
    const saved = await menus.saveMenu(CONTEXT, VALID_BODY, { headers: {} });

    const section = prisma.restaurantMenuSection.create.mock.calls[0][0];
    expect(section.data.items.create[0]).toMatchObject({
      name: 'Kelewele',
      priceMinor: 2500,
      currency: 'GHS',
      dietary: ['Vegan'],
    });
    expect(saved.sections[0].items[0].priceMinor).toBe(2500);
  });

  it('keeps market price as null rather than zero', async () => {
    prisma.restaurantMenu.findUnique.mockResolvedValue(
      menuRow({
        sections: [
          {
            id: 's1',
            title: 'From the grill',
            position: 0,
            items: [
              {
                id: 'i1',
                name: 'Whole tilapia',
                priceMinor: null,
                currency: 'GHS',
                dietary: [],
                isAvailable: true,
                position: 0,
              },
            ],
          },
        ],
      }),
    );

    const saved = await menus.saveMenu(
      CONTEXT,
      {
        sections: [
          { title: 'From the grill', items: [{ name: 'Whole tilapia', priceMinor: null }] },
        ],
      },
      { headers: {} },
    );

    expect(saved.sections[0].items[0].priceMinor).toBeNull();
  });

  it('refuses a fractional price', async () => {
    await expect(
      menus.saveMenu(
        CONTEXT,
        { sections: [{ title: 'Starters', items: [{ name: 'Kelewele', priceMinor: 25.5 }] }] },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'INVALID_PRICE', statusCode: 400 });
  });

  it('refuses a negative price', async () => {
    await expect(
      menus.saveMenu(
        CONTEXT,
        { sections: [{ title: 'Starters', items: [{ name: 'Kelewele', priceMinor: -100 }] }] },
        { headers: {} },
      ),
    ).rejects.toMatchObject({ errorCode: 'INVALID_PRICE' });
  });

  it('refuses an unsupported currency', async () => {
    await expect(
      menus.saveMenu(CONTEXT, { ...VALID_BODY, currency: 'XYZ' }, { headers: {} }),
    ).rejects.toMatchObject({ errorCode: 'UNSUPPORTED_CURRENCY' });
  });

  it('replaces the section tree when an existing menu is saved', async () => {
    prisma.restaurantMenu.findFirst.mockResolvedValue({ id: 'menu1' });
    prisma.restaurantMenu.update.mockResolvedValue({ id: 'menu1' });

    await menus.saveMenu(CONTEXT, { ...VALID_BODY, id: 'menu1' }, { headers: {} });

    expect(prisma.restaurantMenuSection.deleteMany).toHaveBeenCalledWith({
      where: { menuId: 'menu1' },
    });
    expect(prisma.restaurantMenuSection.create).toHaveBeenCalled();
  });

  it('will not publish an empty menu', async () => {
    prisma.restaurantMenu.findFirst.mockResolvedValue({
      id: 'menu1',
      sections: [],
    });

    await expect(
      menus.publishMenu(CONTEXT, { menuId: 'menu1' }, { headers: {} }),
    ).rejects.toMatchObject({ errorCode: 'MENU_EMPTY', statusCode: 400 });
    expect(prisma.restaurantMenu.update).not.toHaveBeenCalled();
  });

  it('publishes a menu with content', async () => {
    prisma.restaurantMenu.findFirst.mockResolvedValue(menuRow());
    prisma.restaurantMenu.update.mockResolvedValue(menuRow({ status: 'PUBLISHED' }));

    const published = await menus.publishMenu(CONTEXT, { menuId: 'menu1' }, { headers: {} });

    expect(published.status).toBe('PUBLISHED');
    expect(prisma.restaurantMenu.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );
  });

  it('only exposes published menus to the storefront', async () => {
    prisma.restaurantMenu.findMany.mockResolvedValue([menuRow({ status: 'PUBLISHED' })]);

    await menus.getPublicMenus('v1');

    expect(prisma.restaurantMenu.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', status: 'PUBLISHED' } }),
    );
  });
});
