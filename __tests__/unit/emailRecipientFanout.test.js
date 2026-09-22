jest.mock('../../src/core/services/prismaClient', () => ({}));
jest.mock('../../src/core/services/notificationRecipientService', () => ({
  resolveRecipients: jest.fn(),
}));

const { resolveRecipients } = require('../../src/core/services/notificationRecipientService');
const emailService = require('../../src/core/services/emailService');

describe('supplier email recipient resolution and fan-out', () => {
  const ORIGINAL = { nodeEnv: process.env.NODE_ENV, worker: process.env.JEST_WORKER_ID, key: process.env.RESEND_API_KEY };

  beforeAll(() => {
    // Force the REST branch of sendHtml so we can observe one request per
    // address without a real provider client.
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 'test-key';
  });

  afterAll(() => {
    process.env.NODE_ENV = ORIGINAL.nodeEnv;
    if (ORIGINAL.worker === undefined) delete process.env.JEST_WORKER_ID; else process.env.JEST_WORKER_ID = ORIGINAL.worker;
    if (ORIGINAL.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = ORIGINAL.key;
    delete global.fetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'msg-1' }) });
  });

  describe('supplierRecipientList', () => {
    it('returns addresses plus per-recipient tags', async () => {
      resolveRecipients.mockResolvedValue([
        { email: 'owner@example.com', recipientId: null },
        { email: 'second@example.com', recipientId: 'r1' },
      ]);

      const { to, tagsByRecipient } = await emailService.supplierRecipientList({ id: 'sup-1' }, 'bookings');

      expect(to).toEqual(['owner@example.com', 'second@example.com']);
      expect(tagsByRecipient).toEqual({
        'second@example.com': [{ name: 'notification_recipient', value: 'r1' }],
      });
      expect(resolveRecipients).toHaveBeenCalledWith('sup-1', 'bookings');
    });

    it('degrades to the single supplier email when no id is available', async () => {
      const { to, tagsByRecipient } = await emailService.supplierRecipientList({ email: 'only@example.com' }, 'bookings');

      expect(to).toEqual(['only@example.com']);
      expect(tagsByRecipient).toEqual({});
      expect(resolveRecipients).not.toHaveBeenCalled();
    });
  });

  describe('sendHtml fan-out', () => {
    it('sends one request per address with its own tag', async () => {
      await emailService.sendEmail({
        to: ['a@example.com', 'b@example.com'],
        subject: 'Hello',
        template: 'generic-notification',
        data: {},
        tagsByRecipient: { 'b@example.com': [{ name: 'notification_recipient', value: 'r2' }] },
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const bodies = global.fetch.mock.calls.map(([, opts]) => JSON.parse(opts.body));
      const byTo = Object.fromEntries(bodies.map((b) => [b.to, b]));
      expect(Object.keys(byTo).sort()).toEqual(['a@example.com', 'b@example.com']);
      expect(byTo['b@example.com'].tags).toEqual([{ name: 'notification_recipient', value: 'r2' }]);
      expect(byTo['a@example.com'].tags).toBeUndefined();
    });

    it('does not fail the whole send when one address fails', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'bad address' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'msg-2' }) });

      const result = await emailService.sendEmail({
        to: ['broken@example.com', 'good@example.com'],
        subject: 'Hello',
        template: 'generic-notification',
        data: {},
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });
  });
});
