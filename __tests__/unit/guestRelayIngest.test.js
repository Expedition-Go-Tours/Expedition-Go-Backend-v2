/**
 * Guest relay ingestion. Two directions, one address, and a strict rule about
 * who may use it: the supplier side (owner or a verified notification
 * recipient, DMARC pass) or the guest whose address is on the booking. Every
 * outcome is archived so a failed/ignored message is visible rather than lost.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  supplierNotificationRecipient: { findFirst: jest.fn(), findMany: jest.fn() },
  guestRelayMessage: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
}));
jest.mock('../../src/core/services/chatInbound', () => ({
  parseEmail: jest.fn((value) => {
    const raw = String(value || '').trim();
    const m = raw.match(/<([^<>]+)>/) || raw.match(/([^\s@]+@[^\s@]+)/);
    return m ? m[1].toLowerCase() : '';
  }),
  receivingDomains: jest.fn(() => ['messages.travioghana.com']),
  extractReplyContent: jest.fn(() => 'Hello from the relay'),
}));
jest.mock('../../src/core/services/emailService', () => ({
  sendHtml: jest.fn(),
}));
jest.mock('../../src/core/services/guestRelay', () => ({
  findByToken: jest.fn(),
  realGuestEmail: jest.fn(),
  brandKeyForBooking: jest.fn(() => 'ghana'),
}));
jest.mock('../../src/core/services/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const emailService = require('../../src/core/services/emailService');
const guestRelay = require('../../src/core/services/guestRelay');
const ingest = require('../../src/core/services/guestRelayIngest');

const RELAY_ADDRESS = 'g-0123456789abcdef@messages.travioghana.com';
const GUEST_EMAIL = 'yannick@example.com';
const SUPPLIER_EMAIL = 'supplier@example.com';

const relay = () => ({
  id: 'relay-1',
  supplierId: 'supplier-1',
  address: RELAY_ADDRESS,
  disabledAt: null,
  booking: {
    id: 'booking-1',
    bookingNumber: 'TRG-1',
    origin: 'MARKETPLACE',
    source: 'GHANA',
    leadTravelerName: 'Yannick',
    leadTravelerEmail: GUEST_EMAIL,
    guest: { id: 'guest-1', name: 'Yannick', email: GUEST_EMAIL },
    tour: { id: 'tour-1', title: 'Waterfalls', supplierId: 'supplier-1' },
  },
});

const email = (over = {}) => ({
  message_id: 'msg-1',
  from: `Expedition-Go <${SUPPLIER_EMAIL}>`,
  to: [RELAY_ADDRESS],
  subject: 'Pickup time',
  text: 'Hello from the relay',
  html: '<p>Hello from the relay</p>',
  authentication: { dmarc: 'pass' },
  headers: {},
  attachments: [],
  ...over,
});

const token = { kind: 'g', token: 'g-0123456789abcdef', hex: '0123456789abcdef' };

beforeEach(() => {
  jest.clearAllMocks();
  guestRelay.findByToken.mockResolvedValue(relay());
  guestRelay.realGuestEmail.mockReturnValue(GUEST_EMAIL);
  guestRelay.brandKeyForBooking.mockReturnValue('ghana');
  prisma.user.findUnique.mockResolvedValue({
    id: 'supplier-1',
    name: 'Expedition-Go Tours',
    email: SUPPLIER_EMAIL,
  });
  prisma.supplierNotificationRecipient.findFirst.mockResolvedValue(null);
  prisma.supplierNotificationRecipient.findMany.mockResolvedValue([]);
  prisma.guestRelayMessage.findUnique.mockResolvedValue(null);
  prisma.guestRelayMessage.create.mockResolvedValue({ id: 'grm-1' });
  prisma.guestRelayMessage.update.mockResolvedValue({ id: 'grm-1' });
  prisma.guestRelayMessage.count.mockResolvedValue(0);
  emailService.sendHtml.mockResolvedValue({ success: true, messageId: 'prov-1' });
});

describe('supplier → guest', () => {
  it('forwards to the real inbox and archives the outbound message', async () => {
    const status = await ingest.ingestReceivedEmail({ emailId: 'e-1', email: email(), token });

    expect(status).toBe('success');
    expect(emailService.sendHtml).toHaveBeenCalledWith(expect.objectContaining({
      to: GUEST_EMAIL,
      replyTo: RELAY_ADDRESS,
      brandKey: 'ghana',
    }));

    const created = prisma.guestRelayMessage.create.mock.calls[0][0].data;
    expect(created.direction).toBe('OUTBOUND');
    expect(created.fromEmail).toBe(SUPPLIER_EMAIL);
    expect(created.messageId).toBe('msg-1');

    expect(prisma.guestRelayMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FORWARDED', providerId: 'prov-1' }),
    }));
  });

  it('rejects a supplier sender that fails DMARC', async () => {
    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ authentication: { dmarc: 'fail' } }),
      token,
    });

    expect(status).toBe('ignored');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
    expect(prisma.guestRelayMessage.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'IGNORED', error: 'sender_not_authorised' }),
    );
  });

  it('accepts the owner’s exact address when the domain has no DMARC policy (gray)', async () => {
    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ authentication: { dmarc: 'gray' } }),
      token,
    });

    expect(status).toBe('success');
    expect(emailService.sendHtml).toHaveBeenCalled();
  });

  it('accepts a verified notification recipient with bookings enabled', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'supplier-1', name: 'Expedition-Go Tours', email: SUPPLIER_EMAIL });
    prisma.supplierNotificationRecipient.findFirst.mockResolvedValue({
      preferences: { bookings: true },
    });

    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ from: 'Staff <staff@example.com>' }),
      token,
    });

    expect(status).toBe('success');
    expect(emailService.sendHtml).toHaveBeenCalled();
  });

  it('rejects a verified recipient who has not opted into bookings mail', async () => {
    prisma.supplierNotificationRecipient.findFirst.mockResolvedValue({
      preferences: { bookings: false },
    });

    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ from: 'Staff <staff@example.com>' }),
      token,
    });

    expect(status).toBe('ignored');
  });

  it('rejects an unrelated sender', async () => {
    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ from: 'stranger@example.com' }),
      token,
    });

    expect(status).toBe('ignored');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
  });
});

describe('guest → supplier', () => {
  it('accepts the booking’s guest address without requiring DMARC', async () => {
    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({
        from: `Yannick <${GUEST_EMAIL}>`,
        authentication: { dmarc: 'fail' },
      }),
      token,
    });

    expect(status).toBe('success');
    expect(emailService.sendHtml).toHaveBeenCalledWith(expect.objectContaining({
      to: [SUPPLIER_EMAIL],
      replyTo: RELAY_ADDRESS,
    }));
    const created = prisma.guestRelayMessage.create.mock.calls[0][0].data;
    expect(created.direction).toBe('INBOUND');
    expect(created.fromEmail).toBe(GUEST_EMAIL);
  });

  it('rejects a different address even if it reaches the relay', async () => {
    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ from: 'someone-else@example.com' }),
      token,
    });

    expect(status).toBe('ignored');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
  });

  it('includes verified staff recipients and never the guest', async () => {
    prisma.supplierNotificationRecipient.findMany.mockResolvedValue([
      { email: 'staff@example.com', preferences: { bookings: true } },
      { email: 'nobooking@example.com', preferences: { bookings: false } },
      { email: GUEST_EMAIL, preferences: { bookings: true } },
    ]);

    await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ from: `Yannick <${GUEST_EMAIL}>` }),
      token,
    });

    expect(emailService.sendHtml).toHaveBeenCalledWith(expect.objectContaining({
      to: [SUPPLIER_EMAIL, 'staff@example.com'],
    }));
  });

  it('ignores the message when the supplier has no recipient', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'supplier-1', name: 'Expedition-Go', email: '' });

    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ from: `Yannick <${GUEST_EMAIL}>` }),
      token,
    });

    expect(status).toBe('ignored');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
  });
});

describe('guards', () => {
  it('ignores automated replies', async () => {
    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ headers: { 'Auto-Submitted': 'auto-replied' } }),
      token,
    });

    expect(status).toBe('ignored');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
  });

  it('never relays mail from one of our own receiving domains', async () => {
    const status = await ingest.ingestReceivedEmail({
      emailId: 'e-1',
      email: email({ from: `relay <c-0123456789abcdef@messages.travioghana.com>` }),
      token,
    });

    expect(status).toBe('ignored');
  });

  it('rate-limits a busy relay', async () => {
    prisma.guestRelayMessage.count.mockResolvedValue(20);

    const status = await ingest.ingestReceivedEmail({ emailId: 'e-1', email: email(), token });

    expect(status).toBe('ignored');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
    expect(prisma.guestRelayMessage.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ error: 'rate_limited' }),
    );
  });

  it('dedupes by Message-ID', async () => {
    prisma.guestRelayMessage.findUnique.mockResolvedValue({
      id: 'grm-existing',
      status: 'FORWARDED',
    });

    const status = await ingest.ingestReceivedEmail({ emailId: 'e-1', email: email(), token });

    expect(status).toBe('duplicate');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
  });

  it('retries a previously failed message instead of calling it a duplicate', async () => {
    prisma.guestRelayMessage.findUnique.mockResolvedValue({
      id: 'grm-existing',
      status: 'FAILED',
    });

    const status = await ingest.ingestReceivedEmail({ emailId: 'e-1', email: email(), token });

    expect(status).toBe('success');
    expect(prisma.guestRelayMessage.update).toHaveBeenCalled();
  });

  it('ignores a disabled relay', async () => {
    const disabled = relay();
    disabled.disabledAt = new Date();
    guestRelay.findByToken.mockResolvedValue(disabled);

    const status = await ingest.ingestReceivedEmail({ emailId: 'e-1', email: email(), token });

    expect(status).toBe('ignored');
    expect(emailService.sendHtml).not.toHaveBeenCalled();
  });
});
