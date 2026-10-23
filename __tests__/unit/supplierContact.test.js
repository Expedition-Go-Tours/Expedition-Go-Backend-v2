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
}));
jest.mock('../../src/core/services/chatService', () => ({
  findOrCreateConversation: jest.fn(),
}));
jest.mock('../../src/core/services/chatInbound', () => ({
  ensureConversationToken: jest.fn(),
  replyAddressFor: jest.fn(),
}));
jest.mock('../../src/core/services/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const chatService = require('../../src/core/services/chatService');
const chatInbound = require('../../src/core/services/chatInbound');
const supplierContact = require('../../src/core/services/supplierContact');

const RELAY = 'c-0123456789abcdef@messages.travioghana.com';

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
});
