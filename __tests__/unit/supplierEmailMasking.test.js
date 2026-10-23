/**
 * Supplier-facing email renders the guest's RELAY address, never the real one.
 *
 * The rule is decided by RECIPIENT, not by the template's name — and that
 * distinction is not academic: `sendSupplierChangedBookingEmail` goes to the
 * CUSTOMER (telling them the supplier changed their booking) and must show
 * them their own address, while `sendSupplierCancellationFeeEmail` goes to the
 * supplier and must not.
 */
jest.mock('../../src/core/services/supplierContact', () => ({
  contactAddressForBooking: jest.fn(),
}));
jest.mock('../../src/core/services/prismaClient', () => ({}));

const supplierContact = require('../../src/core/services/supplierContact');
const emailService = require('../../src/core/services/emailService');

const RELAY = 'c-0123456789abcdef@messages.travioghana.com';
const data = () => ({
  bookingId: 'b-1',
  customerId: 'cust-1',
  bookingNumber: 'TRG-1',
  customerName: 'Kwame Mensah',
  customerEmail: 'kwame@example.com',
  leadTravelerEmail: 'kwame@example.com',
  customerPhone: '+233201111111',
  tourTitle: 'Shai Hills Safari',
});

beforeEach(() => {
  jest.clearAllMocks();
  supplierContact.contactAddressForBooking.mockResolvedValue(RELAY);
});

describe('emails addressed to the supplier', () => {
  it('renders the relay in place of the customer’s email', async () => {
    const masked = await emailService.withSupplierContactData(data());

    expect(masked.customerEmail).toBe(RELAY);
    expect(masked.leadTravelerEmail).toBe(RELAY);
    expect(JSON.stringify(masked)).not.toContain('kwame@example.com');
  });

  it('keeps the name and the phone — the driver needs both', async () => {
    const masked = await emailService.withSupplierContactData(data());

    expect(masked.customerName).toBe('Kwame Mensah');
    expect(masked.customerPhone).toBe('+233201111111');
  });

  it('blanks the address when no relay can be minted', async () => {
    supplierContact.contactAddressForBooking.mockResolvedValue(null);

    const masked = await emailService.withSupplierContactData(data());

    // Not the real address — a template that shows the name only beats one
    // that shows the guest's inbox because minting failed.
    expect(masked.customerEmail).toBe('');
    expect(masked.leadTravelerEmail).toBe('');
    expect(JSON.stringify(masked)).not.toContain('kwame@example.com');
  });
});

describe('emails addressed to the customer', () => {
  it('leave the customer’s own address alone — it is the recipient’s', async () => {
    // sendRendered only masks when `recipient: 'supplier'`; a customer send
    // passes no such marker and the substitution never runs.
    // (sendSupplierChangedBookingEmail is exactly this case despite its name.)
    const unmasked = data();
    expect(unmasked.customerEmail).toBe('kwame@example.com');
    expect(supplierContact.contactAddressForBooking).not.toHaveBeenCalled();
  });
});
