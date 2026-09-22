jest.mock('../../src/core/services/notificationRecipientService', () => ({
  disableById: jest.fn().mockResolvedValue({ count: 1 }),
  disableByEmail: jest.fn().mockResolvedValue({ count: 1 }),
}));

const crypto = require('crypto');
const notificationRecipientService = require('../../src/core/services/notificationRecipientService');
const controller = require('../../src/core/domain/emailWebhookController');

const SECRET = 'whsec_test_secret';

function signedReq(event) {
  const body = JSON.stringify(event);
  const id = 'msg_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', SECRET).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    body: Buffer.from(body),
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
  };
}

function resMock() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res;
}

describe('emailWebhookController', () => {
  beforeAll(() => { process.env.RESEND_WEBHOOK_SECRET = SECRET; });
  afterAll(() => { delete process.env.RESEND_WEBHOOK_SECRET; });
  beforeEach(() => jest.clearAllMocks());

  it('rejects a bad signature', async () => {
    const req = { body: Buffer.from('{}'), headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,deadbeef' } };
    const res = resMock();
    await controller.receive(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(notificationRecipientService.disableByEmail).not.toHaveBeenCalled();
  });

  it('disables the tagged recipient on a hard bounce', async () => {
    const req = signedReq({
      type: 'email.bounced',
      data: { to: 'second@example.com', tags: [{ name: 'notification_recipient', value: 'r1' }], bounce: { type: 'hard' } },
    });
    const res = resMock();
    await controller.receive(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(notificationRecipientService.disableById).toHaveBeenCalledWith('r1', 'hard_bounce');
    expect(notificationRecipientService.disableByEmail).not.toHaveBeenCalled();
  });

  it('ignores soft bounces', async () => {
    const req = signedReq({
      type: 'email.bounced',
      data: { to: 'second@example.com', tags: [{ name: 'notification_recipient', value: 'r1' }], bounce: { type: 'soft' } },
    });
    const res = resMock();
    await controller.receive(req, res);

    expect(notificationRecipientService.disableById).not.toHaveBeenCalled();
  });

  it('disables on a complaint, matching by email when untagged', async () => {
    const req = signedReq({ type: 'email.complained', data: { to: 'extra@example.com' } });
    const res = resMock();
    await controller.receive(req, res);

    expect(notificationRecipientService.disableByEmail).toHaveBeenCalledWith('extra@example.com', 'complaint');
  });

  it('ignores unrelated events', async () => {
    const req = signedReq({ type: 'email.delivered', data: { to: 'a@b.com' } });
    const res = resMock();
    await controller.receive(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: 'ignored' });
    expect(notificationRecipientService.disableByEmail).not.toHaveBeenCalled();
  });
});
