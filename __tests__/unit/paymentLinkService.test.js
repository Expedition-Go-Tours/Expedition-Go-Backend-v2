/**
 * One hosted-session service for customer Pay now, supplier links and recovery.
 *
 * The tests pin the money-safety parts: an active attempt is reused rather
 * than doubled, a resend cannot invent a session, and only the request that
 * created a send row may enqueue the email.
 */
jest.mock('../../src/core/services/prismaClient', () => {
  const prisma = {
    booking: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bookingPaymentAttempt: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    bookingPaymentLinkSend: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$queryRaw = jest.fn();
  return prisma;
});
jest.mock('../../src/core/services/getConfig', () => jest.fn().mockResolvedValue('true'));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  createCheckoutSession: jest.fn(),
  getStripe: jest.fn(),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn().mockResolvedValue({ id: 'email-job-1' }),
}));

const prisma = require('../../src/core/services/prismaClient');
const getConfig = require('../../src/core/services/getConfig');
const { createCheckoutSession, getStripe } = require('../../src/core/services/stripeHelpers');
const { enqueueEmail } = require('../../src/core/services/queue');
const service = require('../../src/core/services/paymentLinkService');

const NOW = Date.now();

function booking(over = {}) {
  return {
    id: 'booking_1',
    bookingNumber: 'TRG-1-2026-1',
    status: 'CONFIRMED',
    paymentTiming: 'later',
    paymentStatus: 'PENDING',
    origin: 'MARKETPLACE',
    grossAmount: '120.00',
    currency: 'USD',
    travelDate: new Date(NOW + 3 * 24 * 60 * 60 * 1000),
    selectedTime: '09:00',
    source: 'GHANA',
    clientOrigin: 'https://www.travioghana.com',
    customer: { id: 'cust_1', email: 'customer@example.com', stripeCustomerId: 'cus_1' },
    tour: {
      id: 'tour_1',
      title: 'Cape Coast Tour',
      description: 'A day trip',
      supplierId: 'supplier_1',
      bookingAndTickets: JSON.stringify({
        availability: { timezone: 'Africa/Accra' },
        perSlotCutoff: true,
      }),
    },
    ...over,
  };
}

function liveAttempt(over = {}) {
  return {
    id: 'attempt_1',
    bookingId: 'booking_1',
    source: 'SUPPLIER_LINK',
    status: 'ACTIVE',
    amount: '120.00',
    currency: 'USD',
    stripeCheckoutSessionId: 'cs_1',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
    expiresAt: new Date(NOW + 22 * 60 * 60 * 1000),
    createdAt: new Date(NOW - 1000),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CLIENT_URL = 'https://www.travioghana.com';
  getConfig.mockResolvedValue('true');
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  prisma.booking.update.mockResolvedValue({});
  prisma.booking.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookingPaymentAttempt.updateMany.mockResolvedValue({ count: 1 });
  prisma.bookingPaymentLinkSend.update.mockResolvedValue({});
  prisma.bookingPaymentLinkSend.findMany.mockResolvedValue([]);
  createCheckoutSession.mockResolvedValue({
    id: 'cs_new',
    url: 'https://checkout.stripe.com/c/pay/cs_new',
    payment_intent: 'pi_new',
    expires_at: Math.floor((NOW + 22 * 60 * 60 * 1000) / 1000),
  });
});

describe('ensurePaymentAttempt', () => {
  it('reuses the one active session instead of creating a second PaymentIntent', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(liveAttempt());

    const result = await service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.CUSTOMER_PAY_NOW,
      mode: service.MODE.CREATE,
      actor: { id: 'cust_1', role: 'customer' },
    });

    expect(result.reused).toBe(true);
    expect(result.attempt.id).toBe('attempt_1');
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses regenerate when there is no live link to replace', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(null);

    await expect(service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.REGENERATE,
    })).rejects.toMatchObject({
      errorCode: 'PAYMENT_LINK_NOT_ACTIVE',
      reasonCode: 'NO_ACTIVE_ATTEMPT',
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses regenerate for an expired link instead of silently creating one', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(liveAttempt({
      expiresAt: new Date(NOW - 60_000),
    }));

    await expect(service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.REGENERATE,
    })).rejects.toMatchObject({
      errorCode: 'PAYMENT_LINK_EXPIRED',
      reasonCode: 'ATTEMPT_EXPIRED',
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('revokes a session if the booking changed while Stripe was creating it', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(null);
    prisma.bookingPaymentAttempt.create.mockResolvedValue({
      id: 'attempt_new',
      bookingId: 'booking_1',
      source: 'SUPPLIER_LINK',
      status: 'CREATING',
      amount: '120.00',
      currency: 'USD',
      expiresAt: new Date(NOW + 22 * 60 * 60 * 1000),
      createdAt: new Date(NOW),
    });
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    const expire = jest.fn().mockResolvedValue({});
    getStripe.mockReturnValue({ checkout: { sessions: { expire } } });

    await expect(service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.CREATE,
    })).rejects.toMatchObject({
      errorCode: 'PAYMENT_LINK_NOT_ELIGIBLE',
      reasonCode: 'BOOKING_STATE_CHANGED',
    });

    expect(expire).toHaveBeenCalledWith('cs_new');
    expect(prisma.bookingPaymentAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CANCELLED', failureCode: 'BOOKING_STATE_CHANGED' }),
    }));
  });

  it('refuses a resend when no active link exists', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(null);

    await expect(service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.RESEND,
    })).rejects.toMatchObject({
      errorCode: 'PAYMENT_LINK_NOT_ACTIVE',
      reasonCode: 'NO_ACTIVE_ATTEMPT',
    });
  });

  it('never resends a live link for a booking that was cancelled meanwhile', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ status: 'CANCELLED' }));
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(liveAttempt());

    await expect(service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.RESEND,
    })).rejects.toMatchObject({
      errorCode: 'PAYMENT_LINK_NOT_ELIGIBLE',
      reasonCode: 'BOOKING_TERMINAL',
    });
  });

  it('never resends a live link for a booking that has already paid', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ paymentStatus: 'SUCCEEDED' }));
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(liveAttempt());

    await expect(service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.RESEND,
    })).rejects.toMatchObject({
      errorCode: 'PAYMENT_LINK_NOT_ELIGIBLE',
      reasonCode: 'PAYMENT_ALREADY_SETTLED',
    });
  });

  it('keeps the wake-up guard held while replacing a live session', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(liveAttempt());
    prisma.bookingPaymentAttempt.create.mockResolvedValue({
      id: 'attempt_new',
      bookingId: 'booking_1',
      source: 'SUPPLIER_LINK',
      status: 'CREATING',
      amount: '120.00',
      currency: 'USD',
      expiresAt: new Date(NOW + 22 * 60 * 60 * 1000),
      createdAt: new Date(NOW),
    });
    prisma.bookingPaymentAttempt.findUnique.mockResolvedValue({
      ...liveAttempt({ id: 'attempt_new', stripeCheckoutSessionId: 'cs_new' }),
      status: 'ACTIVE',
    });
    const expire = jest.fn().mockResolvedValue({});
    getStripe.mockReturnValue({ checkout: { sessions: { expire } } });

    await service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.REGENERATE,
    });

    expect(expire).toHaveBeenCalledWith('cs_1');
    expect(prisma.booking.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ paymentLinkHoldAt: null }),
    }));
  });

  it('creates one hosted session with pay-later metadata and the exact amount', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(null);
    prisma.bookingPaymentAttempt.create.mockResolvedValue({
      id: 'attempt_new',
      bookingId: 'booking_1',
      source: 'SUPPLIER_LINK',
      status: 'CREATING',
      amount: '120.00',
      currency: 'USD',
      expiresAt: new Date(NOW + 22 * 60 * 60 * 1000),
      createdAt: new Date(NOW),
    });
    prisma.bookingPaymentAttempt.findUnique.mockResolvedValue({
      ...liveAttempt({ id: 'attempt_new', stripeCheckoutSessionId: 'cs_new' }),
      status: 'ACTIVE',
    });

    const result = await service.ensurePaymentAttempt({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.CREATE,
      actor: { id: 'supplier_user', role: 'supplier' },
    });

    expect(result.reused).toBe(false);
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      amount: 12000,
      currency: 'USD',
      bookingId: 'booking_1',
      customerId: 'cus_1',
      customerEmail: 'customer@example.com',
      idempotencyKey: 'paylater-checkout-attempt:attempt_new',
      metadata: expect.objectContaining({
        paymentAttemptId: 'attempt_new',
        paymentTiming: 'later',
        bookingIds: 'booking_1',
      }),
    }));
    expect(prisma.booking.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ recoveryClosedAt: expect.anything() }),
    }));
  });
});

describe('deliverPaymentLink', () => {
  it('enqueues the email once when the same idempotency key is retried', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(liveAttempt());
    const send = {
      id: 'send_1',
      status: 'QUEUED',
      bookingId: 'booking_1',
      attemptId: 'attempt_1',
      channel: 'EMAIL',
    };
    prisma.bookingPaymentLinkSend.create
      .mockResolvedValueOnce(send)
      .mockImplementationOnce(async () => {
        const err = new Error('duplicate');
        err.code = 'P2002';
        throw err;
      });
    prisma.bookingPaymentLinkSend.findFirst.mockResolvedValue({ ...send, status: 'QUEUED' });

    const first = await service.sendPaymentLink({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.CREATE,
      idempotencyKey: 'supplier-key-1',
    });
    const second = await service.sendPaymentLink({
      bookingId: 'booking_1',
      source: service.SOURCE.SUPPLIER_LINK,
      mode: service.MODE.CREATE,
      idempotencyKey: 'supplier-key-1',
    });

    expect(first.emailStatus).toBe('QUEUED');
    expect(second.emailStatus).toBe('QUEUED');
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({
      type: 'payment-link',
      bookingId: 'booking_1',
      data: expect.objectContaining({
        paymentLinkSendId: 'send_1',
        paymentLinkAttemptId: 'attempt_1',
      }),
    }));
  });
});

/**
 * Customer touch policy: one email per booking per day, and a ceiling on how
 * often a supplier may ping a customer about the same reservation.
 *
 * A supplier can click Send as often as the button allows, so the ceiling has
 * to live here. It counts real touches (QUEUED/SENT - a FAILED send never
 * reached anyone), it lets a retried idempotency key through untouched, and it
 * reports the wait rather than a dead end.
 */
describe('customer touch policy', () => {
  const HOUR = 60 * 60 * 1000;

  function touch(over = {}) {
    return {
      id: `send_${Math.random().toString(36).slice(2)}`,
      bookingId: 'booking_1',
      attemptId: 'attempt_1',
      channel: 'EMAIL',
      status: 'SENT',
      createdAt: new Date(NOW - HOUR),
      sentAt: new Date(NOW - HOUR),
      ...over,
    };
  }

  function prime({ history = [], reused = null } = {}) {
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.bookingPaymentAttempt.findFirst.mockResolvedValue(liveAttempt());
    prisma.bookingPaymentLinkSend.findFirst.mockResolvedValue(reused);
    prisma.bookingPaymentLinkSend.findMany.mockResolvedValue(history);
    prisma.bookingPaymentLinkSend.create.mockResolvedValue({
      id: 'send_new',
      status: 'QUEUED',
      channel: 'EMAIL',
      bookingId: 'booking_1',
      attemptId: 'attempt_1',
    });
    enqueueEmail.mockResolvedValue({ id: 'job_1' });
  }

  const sendLink = (key = 'key-1') => service.sendPaymentLink({
    bookingId: 'booking_1',
    source: service.SOURCE.SUPPLIER_LINK,
    mode: service.MODE.CREATE,
    idempotencyKey: key,
  });

  it('allows the first send for a booking with no history', async () => {
    prime({ history: [] });

    const result = await sendLink();

    expect(result.emailStatus).toBe('QUEUED');
    expect(prisma.bookingPaymentLinkSend.create).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a second email inside the 24h cooldown and reports the wait', async () => {
    prime({ history: [touch({ createdAt: new Date(NOW - HOUR) })] });

    await expect(sendLink()).rejects.toMatchObject({
      statusCode: 429,
      errorCode: 'PAYMENT_LINK_COOLDOWN',
      reasonCode: 'TOO_SOON_TO_RESEND',
    });

    const err = await sendLink().catch((e) => e);
    expect(err.details.retryAfterMinutes).toBeLessThanOrEqual(23 * 60);
    expect(err.details.retryAfterMinutes).toBeGreaterThan(22 * 60);
    // Nothing was queued and no session row was left behind.
    expect(prisma.bookingPaymentLinkSend.create).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('lets another email through once the cooldown has passed', async () => {
    prime({ history: [touch({ createdAt: new Date(NOW - 25 * HOUR) })] });

    const result = await sendLink();

    expect(result.emailStatus).toBe('QUEUED');
    expect(prisma.bookingPaymentLinkSend.create).toHaveBeenCalledTimes(1);
  });

  it('does not count a failed email as a touch', async () => {
    prime({ history: [touch({ status: 'FAILED', createdAt: new Date(NOW - HOUR) })] });

    const result = await sendLink();

    expect(result.emailStatus).toBe('QUEUED');
  });

  it('counts chat posts toward the ceiling without starting the email cooldown', async () => {
    const twoDays = 2 * 24 * HOUR;
    prime({
      history: [
        touch({ channel: 'CHAT', createdAt: new Date(NOW - HOUR) }),
        touch({ createdAt: new Date(NOW - twoDays) }),
        touch({ createdAt: new Date(NOW - twoDays - HOUR) }),
        touch({ createdAt: new Date(NOW - twoDays - 2 * HOUR) }),
      ],
    });

    const result = await sendLink();

    // Four touches are on the books, the newest EMAIL is two days old, so both
    // the ceiling and the cooldown allow this one.
    expect(result.emailStatus).toBe('QUEUED');
    expect(prisma.bookingPaymentLinkSend.create).toHaveBeenCalledTimes(1);
  });

  it('refuses once the booking has reached the customer-touch ceiling', async () => {
    const twoDays = 2 * 24 * HOUR;
    prime({
      history: [
        touch({ createdAt: new Date(NOW - twoDays) }),
        touch({ createdAt: new Date(NOW - twoDays - HOUR) }),
        touch({ channel: 'CHAT', createdAt: new Date(NOW - twoDays - 2 * HOUR) }),
        touch({ createdAt: new Date(NOW - twoDays - 3 * HOUR) }),
        touch({ createdAt: new Date(NOW - twoDays - 4 * HOUR) }),
      ],
    });

    await expect(sendLink()).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'PAYMENT_LINK_SEND_LIMIT',
      reasonCode: 'TOUCH_LIMIT_REACHED',
    });
    expect(prisma.bookingPaymentLinkSend.create).not.toHaveBeenCalled();
  });

  it('serves a retried idempotency key its own row instead of refusing it', async () => {
    prime({ history: [touch({ createdAt: new Date(NOW - HOUR) })] });
    prisma.bookingPaymentLinkSend.findFirst.mockResolvedValue({
      id: 'send_existing',
      status: 'QUEUED',
      channel: 'EMAIL',
      bookingId: 'booking_1',
      attemptId: 'attempt_1',
    });
    // The unique index on (bookingId, channel, idempotencyKey) is what turns a
    // retry into a reuse, so the mock has to raise it like Postgres would.
    prisma.bookingPaymentLinkSend.create.mockImplementationOnce(async () => {
      const err = new Error('duplicate');
      err.code = 'P2002';
      throw err;
    });

    const result = await sendLink('same-key-twice');

    expect(result.emailStatus).toBe('QUEUED');
    // The policy is not consulted for a key that already produced a send.
    expect(prisma.bookingPaymentLinkSend.findMany).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });
});
