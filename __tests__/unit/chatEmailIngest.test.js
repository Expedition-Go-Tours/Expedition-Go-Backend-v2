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
  conversationParticipant: { findFirst: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../src/core/services/chatService', () => ({
  EMAIL_ENABLED_TYPES: ['CUSTOMER_SUPPORT'],
  notifyConversationByEmail: jest.fn(),
}));

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
