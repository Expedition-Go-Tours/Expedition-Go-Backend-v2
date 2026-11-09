/**
 * The supplier ↔ customer contact privacy layer (GetYourGuide's model).
 *
 * What matters here is not the mechanics of minting an address — chatInbound
 * already does that — but the guarantee: no supplier-facing payload ever
 * carries the customer's real email, and a failure to mint a relay BLANKS the
 * field instead of falling back to the real one.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  conversation: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  guestRelay: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
}));
jest.mock('../../src/core/services/chatService', () => ({
  findOrCreateConversation: jest.fn(),
}));
jest.mock('../../src/core/services/chatInbound', () => ({
  ensureConversationToken: jest.fn(),
  replyAddressFor: jest.fn(),
}));
jest.mock('../../src/core/services/guestRelay', () => ({
  isEligible: jest.fn(() => false),
  ensureForBooking: jest.fn(),
}));
jest.mock('../../src/core/services/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const chatService = require('../../src/core/services/chatService');
const chatInbound = require('../../src/core/services/chatInbound');
const guestRelay = require('../../src/core/services/guestRelay');
const supplierContact = require('../../src/core/services/supplierContact');

const RELAY = 'c-0123456789abcdef@messages.travioghana.com';
const GUEST_RELAY = 'g-0123456789abcdef@messages.travioghana.com';

const booking = (over = {}) => ({
  id: 'b-1',
  bookingNumber: 'TRG-1',
  customerId: 'cust-1',
  customer: { id: 'cust-1', name: 'Kwame Mensah', email: 'kwame@example.com', phone: '+233201111111' },
  leadTravelerName: 'Kwame Mensah',
  leadTravelerEmail: 'kwame@example.com',
  leadTravelerPhone: '+233201111111',
  tour: { supplierId: 'supplier-1', title: 'Shai Hills Safari' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  supplierContact.clearContactCache();
  guestRelay.isEligible.mockReturnValue(false);
  guestRelay.ensureForBooking.mockResolvedValue(null);
  chatService.findOrCreateConversation.mockResolvedValue({ id: 'conv-1', brand: 'ghana' });
  chatInbound.ensureConversationToken.mockResolvedValue('c0123456789abcdef');
  chatInbound.replyAddressFor.mockReturnValue(RELAY);
});

describe('withSupplierContact', () => {
  it('puts the relay in place of the customer’s real email', () => {
    const masked = supplierContact.withSupplierContact(booking(), RELAY);

    expect(masked.customer.email).toBe(RELAY);
    expect(masked.customer.name).toBe('Kwame Mensah');
    expect(masked.customer.phone).toBe('+233201111111');
  });

  it('masks the lead traveller’s email too — the guest the driver meets', () => {
    const masked = supplierContact.withSupplierContact(booking(), RELAY);

    expect(masked.leadTravelerEmail).toBe(RELAY);
    expect(masked.leadTravelerName).toBe('Kwame Mensah');
  });

  it('leaves the phone alone: the driver has to reach a late guest', () => {
    const masked = supplierContact.withSupplierContact(booking(), RELAY);

    expect(masked.customer.phone).toBe('+233201111111');
    expect(masked.leadTravelerPhone).toBe('+233201111111');
  });

  it('blanks the address when no relay can be minted — never falls back to the real one', () => {
    const masked = supplierContact.withSupplierContact(booking(), null);

    expect(masked.customer.email).toBe('');
    expect(masked.leadTravelerEmail).toBe('');
    expect(JSON.stringify(masked)).not.toContain('kwame@example.com');
  });

  it('never leaks the real address into a serialized payload', () => {
    for (const address of [RELAY, null]) {
      expect(JSON.stringify(supplierContact.withSupplierContact(booking(), address)))
        .not.toContain('kwame@example.com');
    }
  });

  it('uses the relay for a guest even when the lead traveller email was empty', () => {
    const masked = supplierContact.withSupplierContact(
      booking({ customerId: null, customer: null, guestId: 'guest-1', leadTravelerEmail: '' }),
      GUEST_RELAY,
    );

    expect(masked.leadTravelerEmail).toBe(GUEST_RELAY);
    expect(masked.customer).toBeNull();
  });

  it('masks the guest relation too — the list now selects it for the relay resolver', () => {
    const masked = supplierContact.withSupplierContact(
      booking({
        customerId: null,
        customer: null,
        guestId: 'guest-1',
        origin: 'MARKETPLACE',
        leadTravelerEmail: 'yannick@example.com',
        guest: { id: 'guest-1', name: 'Yannick', email: 'yannick@example.com' },
      }),
      GUEST_RELAY,
    );

    expect(masked.guest.email).toBe(GUEST_RELAY);
    expect(JSON.stringify(masked)).not.toContain('yannick@example.com');
  });

  it('blanks the guest relation when a marketplace relay cannot be minted', () => {
    const masked = supplierContact.withSupplierContact(
      booking({
        customerId: null,
        customer: null,
        guestId: 'guest-1',
        origin: 'MARKETPLACE',
        leadTravelerEmail: 'yannick@example.com',
        guest: { id: 'guest-1', name: 'Yannick', email: 'yannick@example.com' },
      }),
      null,
    );

    expect(masked.guest.email).toBe('');
    expect(JSON.stringify(masked)).not.toContain('yannick@example.com');
  });
});

describe('contactAddressForBooking', () => {
  it('resolves the pair’s existing conversation and mints its relay', async () => {
    const address = await supplierContact.contactAddressForBooking(booking());

    expect(chatService.findOrCreateConversation).toHaveBeenCalledWith(
      'supplier-1',
      'cust-1',
      'SUPPLIER_CUSTOMER',
      expect.objectContaining({ bookingNumber: 'TRG-1' }),
    );
    expect(chatInbound.ensureConversationToken).toHaveBeenCalledWith(prisma, 'conv-1');
    expect(address).toBe(RELAY);
  });

  it('is one address per customer-and-supplier pair, cached', async () => {
    await supplierContact.contactAddressForBooking(booking());
    await supplierContact.contactAddressForBooking(
      booking({ id: 'b-2', bookingNumber: 'TRG-2' }),
    );

    // A repeat guest is the same address on every trip — and only one lookup.
    expect(chatService.findOrCreateConversation).toHaveBeenCalledTimes(1);
  });

  it('returns null (not the real email) when minting fails', async () => {
    chatService.findOrCreateConversation.mockRejectedValue(new Error('db down'));

    const address = await supplierContact.contactAddressForBooking(booking());

    expect(address).toBeNull();
  });

  it('mints a booking-scoped guest relay when an unclaimed marketplace guest has no account', async () => {
    guestRelay.isEligible.mockReturnValue(true);
    guestRelay.ensureForBooking.mockResolvedValue({ address: GUEST_RELAY });

    const address = await supplierContact.contactAddressForBooking(booking({
      customerId: null,
      guestId: 'guest-1',
      origin: 'MARKETPLACE',
      customer: null,
    }));

    expect(address).toBe(GUEST_RELAY);
    // A guest has no Conversation, so the conversation path must not run.
    expect(chatService.findOrCreateConversation).not.toHaveBeenCalled();
    expect(guestRelay.ensureForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b-1', guestId: 'guest-1' }),
      'supplier-1',
    );
  });

  it('leaves a supplier-created walk-in alone (the supplier entered that address)', async () => {
    guestRelay.isEligible.mockReturnValue(false);

    const address = await supplierContact.contactAddressForBooking(booking({
      customerId: null,
      guestId: 'guest-1',
      origin: 'SUPPLIER_CREATED',
      customer: null,
    }));

    expect(address).toBeNull();
    expect(guestRelay.ensureForBooking).not.toHaveBeenCalled();
    expect(chatService.findOrCreateConversation).not.toHaveBeenCalled();
  });

  it('returns null when the guest relay cannot be minted', async () => {
    guestRelay.isEligible.mockReturnValue(true);
    guestRelay.ensureForBooking.mockRejectedValue(new Error('db down'));

    const address = await supplierContact.contactAddressForBooking(booking({
      customerId: null,
      guestId: 'guest-1',
      origin: 'MARKETPLACE',
      customer: null,
    }));

    expect(address).toBeNull();
  });
});

describe('contactAddressesForBookings (batch)', () => {
  it('answers from cache and from one lookup, creating only missing pairs', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 'conv-existing',
        brand: 'ghana',
        participants: [{ userId: 'supplier-1' }, { userId: 'cust-1' }],
      },
    ]);

    const out = await supplierContact.contactAddressesForBookings(
      [booking({ id: 'b-1' }), booking({ id: 'b-2', customerId: 'cust-2', customer: { id: 'cust-2', name: 'Akosua', email: 'akosua@example.com' } })],
      'supplier-1',
    );

    expect(prisma.conversation.findMany).toHaveBeenCalledTimes(1);
    // cust-1 reused the existing conversation; cust-2 had none and was created.
    expect(chatService.findOrCreateConversation).toHaveBeenCalledTimes(1);
    expect(out.get('b-1')).toBe(RELAY);
    expect(out.size).toBe(2);
  });

  it('ignores conversations this supplier is not part of', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 'conv-other',
        brand: 'ghana',
        participants: [{ userId: 'another-supplier' }, { userId: 'cust-1' }],
      },
    ]);

    await supplierContact.contactAddressesForBookings([booking()], 'supplier-1');

    // Another supplier's conversation with the same customer is not ours.
    expect(chatService.findOrCreateConversation).toHaveBeenCalledTimes(1);
    expect(chatInbound.replyAddressFor).toHaveBeenCalledWith('conv-1', 'ghana');
  });

  it('answers guest rows from one booking-keyed lookup, minting only the missing ones', async () => {
    guestRelay.isEligible.mockReturnValue(true);
    prisma.guestRelay.findMany.mockResolvedValue([
      { bookingId: 'guest-b1', address: GUEST_RELAY, disabledAt: null },
    ]);
    guestRelay.ensureForBooking.mockResolvedValue({
      address: 'g-fedcba9876543210@messages.travioghana.com',
    });

    const out = await supplierContact.contactAddressesForBookings(
      [
        booking({ id: 'guest-b1', customerId: null, customer: null, guestId: 'guest-1', origin: 'MARKETPLACE' }),
        booking({ id: 'guest-b2', customerId: null, customer: null, guestId: 'guest-2', origin: 'MARKETPLACE' }),
      ],
      'supplier-1',
    );

    expect(prisma.guestRelay.findMany).toHaveBeenCalledTimes(1);
    expect(guestRelay.ensureForBooking).toHaveBeenCalledTimes(1);
    expect(out.get('guest-b1')).toBe(GUEST_RELAY);
    expect(out.get('guest-b2')).toBe('g-fedcba9876543210@messages.travioghana.com');
  });
});
