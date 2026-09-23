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
    expect(res.status).toHaveBeenCalledWith(200);

    expect(res.json).toHaveBeenCalledWith({ status: 'ignored' });
    expect(notificationRecipientService.disableByEmail).not.toHaveBeenCalled();
  });

  it('accepts a signature made with the secondary (inbound) secret', async () => {
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = 'whsec_secondary';
    try {
      const event = {
        type: 'email.bounced',
        data: { to: 'x@y.com', tags: [{ name: 'notification_recipient', value: 'r2' }], bounce: { type: 'hard' } },
      };
      const body = JSON.stringify(event);
      const id = 'msg_2';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto.createHmac('sha256', 'whsec_secondary').update(`${id}.${timestamp}.${body}`).digest('base64');
      const req = { body: Buffer.from(body), headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } };
      const res = resMock();
      await controller.receive(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(notificationRecipientService.disableById).toHaveBeenCalledWith('r2', 'hard_bounce');
    } finally {
      delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    }
  });

  it('accepts when the valid signature is not first in the header (rotation)', async () => {
    const event = {
      type: 'email.bounced',
      data: { to: 'x@y.com', tags: [{ name: 'notification_recipient', value: 'r3' }], bounce: { type: 'hard' } },
    };
    const body = JSON.stringify(event);
    const id = 'msg_3';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const good = crypto.createHmac('sha256', SECRET).update(`${id}.${timestamp}.${body}`).digest('base64');
    const other = crypto.createHmac('sha256', 'whsec_rotated_old').update(`${id}.${timestamp}.${body}`).digest('base64');
    const req = { body: Buffer.from(body), headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${other} v1,${good}` } };
    const res = resMock();
    await controller.receive(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(notificationRecipientService.disableById).toHaveBeenCalledWith('r3', 'hard_bounce');
  });

  it('accepts a signature made with the dedicated inbound signing secret', async () => {
    process.env.RESEND_INBOUND_SIGNING_SECRET = 'whsec_inbound_signing';
    try {
      const event = {
        type: 'email.bounced',
        data: { to: 'x@y.com', tags: [{ name: 'notification_recipient', value: 'r4' }], bounce: { type: 'hard' } },
      };
      const body = JSON.stringify(event);
      const id = 'msg_4';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto.createHmac('sha256', 'whsec_inbound_signing').update(`${id}.${timestamp}.${body}`).digest('base64');
      const req = { body: Buffer.from(body), headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } };
      const res = resMock();
      await controller.receive(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(notificationRecipientService.disableById).toHaveBeenCalledWith('r4', 'hard_bounce');
    } finally {
      delete process.env.RESEND_INBOUND_SIGNING_SECRET;
    }
  });
});
