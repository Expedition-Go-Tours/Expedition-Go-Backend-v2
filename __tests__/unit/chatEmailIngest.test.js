/**
 * Chat inbound email ingestion — negative-cache behaviour.
 *
 * Unmatched inbound emails must be ignored ONCE: the 15s poller used to
 * re-fetch them forever (one stuck id produced ~91k futile Resend fetches,
 * DB lookups and log lines). Transient failures must NOT be cached so they
 * keep retrying.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  message: { findUnique: jest.fn(), create: jest.fn() },
  conversation: { findFirst: jest.fn(), update: jest.fn() },
  conversationParticipant: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  booking: { findUnique: jest.fn() },
  supplierNotificationRecipient: { findFirst: jest.fn() },
  user: { findFirst: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../src/core/services/chatService', () => ({
  EMAIL_ENABLED_TYPES: ['SUPPLIER_CUSTOMER', 'EXPEDITION_CUSTOMER', 'USER_SUPPORT', 'SUPPLIER_ADMIN'],
  notifyConversationByEmail: jest.fn(),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

// The ingest pushes messages over the socket through `require('../../../app')`.
jest.mock('../../app', () => ({ get: jest.fn(() => null) }));

jest.mock('../../src/core/services/chatInbound', () => ({
  tokensFromRecipients: jest.fn(() => []),
  parseEmail: jest.fn(() => 'sender@example.com'),
  extractReplyContent: jest.fn(() => 'Thanks!'),
}));

jest.mock('../../src/core/services/chatAttachments', () => ({
  isAllowed: jest.fn(() => true),
  uploadBuffer: jest.fn(),
  classify: jest.fn(() => 'image'),
  MAX_PER_EMAIL: 5,
}));

jest.mock('../../src/core/services/notificationService', () => ({
  sendNotification: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn().mockResolvedValue(undefined),
}));

const prisma = require('../../src/core/services/prismaClient');
const chatService = require('../../src/core/services/chatService');
const ingest = require('../../src/core/services/chatEmailIngest');

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

beforeEach(() => {
  jest.clearAllMocks();
  ingest.__clearIgnoredInbound();
  prisma.message.findUnique.mockResolvedValue(null);
  prisma.conversation.findFirst.mockResolvedValue(null);
  global.fetch = jest.fn();
});

afterAll(() => {
  delete global.fetch;
});

describe('negative cache for unmatched inbound emails', () => {
  it('fetches an unmatched email once, then never again (poll included)', async () => {
    const emailPayload = {
      id: 'id-1',
      message_id: 'mid-1',
      to: ['c-abc@messages.example.com'],
      from: 'Sender <sender@example.com>',
      html: '',
      text: 'hi',
      attachments: [],
    };
    global.fetch.mockResolvedValue(jsonResponse(emailPayload));

    const first = await ingest.ingestReceivedEmail('id-1');
    expect(first).toBe('ignored');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const second = await ingest.ingestReceivedEmail('id-1');
    expect(second).toBe('ignored');
    expect(global.fetch).toHaveBeenCalledTimes(1); // cached — no refetch

    // The poller must skip it too: only the list call, no per-item fetch
    // and no dedupe DB lookup.
    global.fetch.mockResolvedValue(jsonResponse({ data: [{ id: 'id-1', message_id: 'mid-1' }] }));
    await ingest.pollReceivedEmails();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it('does not cache transient fetch failures — they keep retrying', async () => {
    global.fetch.mockResolvedValue(jsonResponse(null, false, 504));

    expect(await ingest.ingestReceivedEmail('id-flaky')).toBe('fetch_failed');
    expect(await ingest.ingestReceivedEmail('id-flaky')).toBe('fetch_failed');
    expect(global.fetch).toHaveBeenCalledTimes(2); // retried, not cached
  });

  it('poll fetches fresh ids once, then skips them on later polls', async () => {
    const emailPayload = { id: 'id-fresh', message_id: 'mid-fresh', to: [], from: 'a@b.com', html: '', text: 'x', attachments: [] };
    global.fetch.mockImplementation((url) =>
      Promise.resolve(String(url).includes('?limit=')
        ? { ok: true, status: 200, json: async () => ({ data: [{ id: 'id-fresh', message_id: 'mid-fresh' }] }) }
        : jsonResponse(emailPayload))
    );

    await ingest.pollReceivedEmails();
    expect(global.fetch).toHaveBeenCalledTimes(2); // list + item fetch → ignored

    await ingest.pollReceivedEmails();
    expect(global.fetch).toHaveBeenCalledTimes(3); // second poll: list only
  });
});

/**
 * Verified supplier notification recipients may reply by email.
 *
 * Customer threads are 1-on-1, so the supplier's own colleague is never a
 * participant — but the supplier invited her and she completed double opt-in.
 * That recorded trust must let her post. It must let ONLY her: no row for this
 * supplier, no bookings preference, no registered account, or no DMARC pass all
 * keep the sender blocked exactly as before.
 */
describe('verified supplier notification recipients', () => {
  const chatInbound = require('../../src/core/services/chatInbound');
  const auditLogger = require('../../src/core/services/auditLogger');

  const SECRETARY = {
    id: 'user_secretary',
    name: 'Emmanuella',
    email: 'secretary@example.com',
    photoURL: null,
    roles: ['customer'],
  };

  const conversation = {
    id: 'conv_1',
    type: 'SUPPLIER_CUSTOMER',
    bookingId: 'booking_1',
    bookingNumber: 'TRG-1',
    brand: 'ghana',
  };

  function emailPayload(over = {}) {
    return {
      id: 'id-vr',
      message_id: 'mid-vr',
      to: ['c-abc@messages.example.com'],
      from: 'Emmanuella <secretary@example.com>',
      html: '',
      text: 'Pickup will be at 08:00',
      attachments: [],
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      ...over,
    };
  }

  function primeHappyPath() {
    chatInbound.tokensFromRecipients.mockReturnValue([{ token: 'c-abc' }]);
    chatInbound.parseEmail.mockReturnValue('secretary@example.com');
    prisma.conversation.findFirst.mockResolvedValue(conversation);
    prisma.conversationParticipant.findFirst.mockResolvedValue(null);
    prisma.conversationParticipant.findMany.mockResolvedValue([]);
    prisma.message.findUnique.mockResolvedValue(null);
    prisma.booking.findUnique.mockResolvedValue({ tour: { supplierId: 'supplier_1' } });
    prisma.supplierNotificationRecipient.findFirst.mockResolvedValue({
      id: 'snr_1',
      supplierId: 'supplier_1',
      email: 'secretary@example.com',
      status: 'VERIFIED',
      disabledAt: null,
      preferences: { bookings: true, reviews: true },
    });
    prisma.user.findFirst.mockResolvedValue(SECRETARY);
    // Both mocks are used with `.catch(...)` on the success path, so they must
    // return promises rather than the default undefined.
    prisma.conversationParticipant.create.mockResolvedValue({ id: 'p_joined' });
    chatService.notifyConversationByEmail.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(async (fn) =>
      fn({ message: { create: jest.fn().mockResolvedValue({ id: 'msg_1' }) } })
    );
    global.fetch.mockResolvedValue(jsonResponse(emailPayload()));
  }

  it('accepts a verified recipient: attributes the message, joins the thread, audits it', async () => {
    primeHappyPath();

    expect(await ingest.ingestReceivedEmail('id-verified')).toBe('success');

    // Trust anchor: VERIFIED, not disabled, for this booking's supplier.
    expect(prisma.supplierNotificationRecipient.findFirst).toHaveBeenCalledWith({
      where: {
        supplierId: 'supplier_1',
        email: 'secretary@example.com',
        status: 'VERIFIED',
        disabledAt: null,
      },
    });
    // Authenticated first: no trust lookup happens without an aligned pass.
    expect(prisma.booking.findUnique).toHaveBeenCalledWith({
      where: { id: 'booking_1' },
      select: { tour: { select: { supplierId: true } } },
    });
    expect(prisma.conversationParticipant.create).toHaveBeenCalledWith({
      data: { conversationId: 'conv_1', userId: 'user_secretary', lastReadAt: expect.any(Date) },
    });
    expect(auditLogger.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_secretary',
        action: 'chat.email_ingest.verified_recipient_reply',
        resourceId: 'conv_1',
      })
    );
    expect(prisma.conversation.update).toHaveBeenCalled();
  });

  it('leaves the participant path exactly as it was', async () => {
    primeHappyPath();
    prisma.conversationParticipant.findFirst.mockResolvedValue({
      id: 'p_1',
      userId: 'user_secretary',
      user: SECRETARY,
    });

    expect(await ingest.ingestReceivedEmail('id-participant')).toBe('success');

    expect(prisma.supplierNotificationRecipient.findFirst).not.toHaveBeenCalled();
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(prisma.conversationParticipant.create).not.toHaveBeenCalled();
    expect(auditLogger.logActivity).not.toHaveBeenCalled();
  });

  it('blocks a forged From: when DMARC does not pass, before any trust lookup', async () => {
    primeHappyPath();
    global.fetch.mockResolvedValue(
      jsonResponse(emailPayload({ authentication: { spf: 'fail', dkim: 'none', dmarc: 'fail' } }))
    );

    expect(await ingest.ingestReceivedEmail('id-forged')).toBe('ignored');

    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(prisma.supplierNotificationRecipient.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.conversationParticipant.create).not.toHaveBeenCalled();
  });

  it('blocks a sender when the provider reports no authentication result at all', async () => {
    primeHappyPath();
    global.fetch.mockResolvedValue(jsonResponse(emailPayload({ authentication: undefined })));

    expect(await ingest.ingestReceivedEmail('id-unauthenticated')).toBe('ignored');

    expect(prisma.supplierNotificationRecipient.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('blocks a sender whose row belongs to a different supplier', async () => {
    primeHappyPath();
    prisma.booking.findUnique.mockResolvedValue({ tour: { supplierId: 'supplier_2' } });
    prisma.supplierNotificationRecipient.findFirst.mockResolvedValue(null);

    expect(await ingest.ingestReceivedEmail('id-other-supplier')).toBe('ignored');

    expect(prisma.supplierNotificationRecipient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ supplierId: 'supplier_2' }),
      })
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.conversationParticipant.create).not.toHaveBeenCalled();
  });

  it('blocks a recipient who is not trusted for booking notifications', async () => {
    primeHappyPath();
    prisma.supplierNotificationRecipient.findFirst.mockResolvedValue({
      id: 'snr_2',
      supplierId: 'supplier_1',
      email: 'secretary@example.com',
      status: 'VERIFIED',
      disabledAt: null,
      preferences: { bookings: false, reviews: true },
    });

    expect(await ingest.ingestReceivedEmail('id-reviews-only')).toBe('ignored');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.conversationParticipant.create).not.toHaveBeenCalled();
  });

  it('blocks a verified recipient with no registered account to attribute to', async () => {
    primeHappyPath();
    prisma.user.findFirst.mockResolvedValue(null);

    expect(await ingest.ingestReceivedEmail('id-no-user')).toBe('ignored');

    expect(prisma.conversationParticipant.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('never widens threads that have no booking, and therefore no supplier', async () => {
    primeHappyPath();
    prisma.conversation.findFirst.mockResolvedValue({ ...conversation, bookingId: null });

    expect(await ingest.ingestReceivedEmail('id-no-booking')).toBe('ignored');

    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(prisma.supplierNotificationRecipient.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
