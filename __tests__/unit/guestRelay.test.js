/**
 * The guest relay identity. The mechanics are small; the guarantees are what
 * matter: only unclaimed marketplace guest bookings qualify, the token is
 * stable, and the real address is resolved from the booking rather than copied
 * onto the relay row.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  guestRelay: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
}));
jest.mock('../../src/core/services/chatInbound', () => ({
  receivingDomainFor: jest.fn(() => 'messages.travioghana.com'),
}));
jest.mock('../../src/core/services/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const guestRelay = require('../../src/core/services/guestRelay');

const guestBooking = (over = {}) => ({
  id: 'booking-1',
  guestId: 'guest-1',
  customerId: null,
  origin: 'MARKETPLACE',
  source: 'GHANA',
  bookingNumber: 'TRG-1',
  leadTravelerName: 'Yannick',
  leadTravelerEmail: 'yannick@example.com',
  guest: { id: 'guest-1', email: 'yannick@example.com', name: 'Yannick' },
  tour: { supplierId: 'supplier-1', title: 'Waterfalls' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isEligible', () => {
  it('accepts an unclaimed marketplace guest with a reachable inbox', () => {
    expect(guestRelay.isEligible(guestBooking())).toBe(true);
  });

  it('accepts a list row that carries only the scalar lead email', () => {
    expect(guestRelay.isEligible(guestBooking({ guest: null }))).toBe(true);
  });

  it('rejects a supplier-created walk-in', () => {
    expect(guestRelay.isEligible(guestBooking({ origin: 'SUPPLIER_CREATED' }))).toBe(false);
  });

  it('rejects a booking that has been claimed', () => {
    expect(guestRelay.isEligible(guestBooking({ customerId: 'cust-1' }))).toBe(false);
  });

  it('rejects a guest with no email anywhere', () => {
    expect(guestRelay.isEligible(guestBooking({
      guest: null,
      leadTravelerEmail: '',
    }))).toBe(false);
  });

  it('rejects when no supplier can be established', () => {
    expect(guestRelay.isEligible(guestBooking({ tour: {} }))).toBe(false);
  });
});

describe('tokenFor / addressFor', () => {
  it('is stable for a booking and uses the g- namespace', () => {
    const first = guestRelay.tokenFor('booking-1');
    const second = guestRelay.tokenFor('booking-1');

    expect(first).toBe(second);
    expect(first).toMatch(/^g-[0-9a-f]{16}$/);
    expect(guestRelay.tokenFor('booking-2')).not.toBe(first);
  });

  it('mints on the booking brand’s receiving domain', () => {
    expect(guestRelay.addressFor(guestBooking()))
      .toBe(`${guestRelay.tokenFor('booking-1')}@messages.travioghana.com`);
  });
});

describe('ensureForBooking', () => {
  it('returns the existing row without creating another', async () => {
    prisma.guestRelay.findUnique.mockResolvedValue({
      id: 'relay-1',
      bookingId: 'booking-1',
      address: 'g-0123456789abcdef@messages.travioghana.com',
      disabledAt: null,
    });

    const relay = await guestRelay.ensureForBooking(guestBooking());

    expect(relay.id).toBe('relay-1');
    expect(prisma.guestRelay.create).not.toHaveBeenCalled();
  });

  it('returns null when the existing relay has been disabled', async () => {
    prisma.guestRelay.findUnique.mockResolvedValue({
      id: 'relay-1',
      disabledAt: new Date(),
    });

    expect(await guestRelay.ensureForBooking(guestBooking())).toBeNull();
  });

  it('creates a row with the canonical token and address', async () => {
    prisma.guestRelay.findUnique.mockResolvedValue(null);
    prisma.guestRelay.create.mockImplementation(async ({ data }) => ({ id: 'relay-1', ...data }));

    const relay = await guestRelay.ensureForBooking(guestBooking());

    expect(prisma.guestRelay.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: 'booking-1',
        guestId: 'guest-1',
        supplierId: 'supplier-1',
        token: guestRelay.tokenFor('booking-1'),
        address: `${guestRelay.tokenFor('booking-1')}@messages.travioghana.com`,
      }),
    });
    expect(relay.address).toContain('@messages.travioghana.com');
  });

  it('resolves a concurrent-create race by reading the winner', async () => {
    prisma.guestRelay.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'relay-winner', disabledAt: null });
    prisma.guestRelay.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const relay = await guestRelay.ensureForBooking(guestBooking());

    expect(relay.id).toBe('relay-winner');
  });

  it('does not mint for an ineligible booking', async () => {
    const relay = await guestRelay.ensureForBooking(guestBooking({ origin: 'SUPPLIER_CREATED' }));

    expect(relay).toBeNull();
    expect(prisma.guestRelay.create).not.toHaveBeenCalled();
  });
});

describe('findByToken', () => {
  it('rejects anything that is not a well-formed guest token', async () => {
    expect(await guestRelay.findByToken('c-0123456789abcdef')).toBeNull();
    expect(await guestRelay.findByToken('g-nope')).toBeNull();
    expect(prisma.guestRelay.findUnique).not.toHaveBeenCalled();
  });

  it('looks up the canonical token', async () => {
    prisma.guestRelay.findUnique.mockResolvedValue({ id: 'relay-1' });

    expect(await guestRelay.findByToken('G-0123456789ABCDEF')).toEqual({ id: 'relay-1' });
    expect(prisma.guestRelay.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { token: 'g-0123456789abcdef' },
    }));
  });
});

describe('realGuestEmail', () => {
  it('prefers the guest record, then the lead traveller snapshot', () => {
    expect(guestRelay.realGuestEmail({ booking: guestBooking() })).toBe('yannick@example.com');
    expect(guestRelay.realGuestEmail({ booking: guestBooking({ guest: null }) })).toBe('yannick@example.com');
    expect(guestRelay.realGuestEmail({ booking: guestBooking({ guest: null, leadTravelerEmail: '' }) })).toBe('');
  });
});
