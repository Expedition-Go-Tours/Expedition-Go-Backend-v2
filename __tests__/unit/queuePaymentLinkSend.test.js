/**
 * Recording the provider result back onto BookingPaymentLinkSend.
 *
 * Production regression: the worker passes the enqueued payload to
 * processEmailJob with the send-row id under `payload.data`, while this
 * recorder looked only at the top level. The lookup missed, the row stayed
 * QUEUED, and an hour later the reaper marked three DELIVERED customer emails
 * as EMAIL_DELIVERY_TIMEOUT and notified the supplier that each had failed.
 * These tests pin both payload shapes so the mismatch cannot return.
 */
jest.mock('bullmq', () => ({
  Queue: jest.fn(),
  Worker: jest.fn(() => ({ close: jest.fn().mockResolvedValue() })),
}));

jest.mock('ioredis', () =>
  jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue(),
    on: jest.fn(),
  }))
);

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
  bookingPaymentLinkSend: { update: jest.fn() },
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendPaymentLinkEmail: jest.fn(),
  sendPaymentReminderEmail: jest.fn(),
}));

jest.mock('../../src/core/services/notificationService', () => ({
  sendNotification: jest.fn(),
  cleanupOldNotifications: jest.fn(),
}));

jest.mock('../../src/core/services/auditLogger', () => ({ cleanupOldLogs: jest.fn() }));

jest.mock('../../src/core/services/tourPurge', () => ({ purgeArchivedTours: jest.fn() }));

jest.mock('../../src/core/services/cacheHelper', () => ({
  invalidateKeys: jest.fn(),
  TOUR_POPULAR_KEY: 'tour:popular',
}));

jest.mock('../../src/core/services/eventEmitter', () => ({ emit: jest.fn() }));

process.env.REDIS_URL = 'redis://localhost:6379';

const prisma = require('../../src/core/services/prismaClient');
const emailService = require('../../src/core/services/emailService');
const queue = require('../../src/core/services/queue');

/** The exact shape dispatchEmail enqueues, including the nested id. */
function workerPayload(overrides = {}) {
  return {
    type: 'payment-link',
    bookingId: 'booking_1',
    data: {
      paymentLinkSendId: 'send_1',
      paymentLinkAttemptId: 'attempt_1',
      amount: 9000,
      expiresAt: '2026-10-27T11:38:00.000Z',
      ...overrides.data,
    },
    ...overrides.top,
  };
}

describe('processEmailJob — payment-link delivery is recorded on the send row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findUnique.mockResolvedValue({ id: 'booking_1', customer: {}, tour: {} });
    prisma.bookingPaymentLinkSend.update.mockResolvedValue({});
    emailService.sendPaymentLinkEmail.mockResolvedValue({ success: true, messageId: 'msg_1' });
  });

  it('marks the row SENT when the provider accepts, reading the nested id', async () => {
    await queue.processEmailJob(workerPayload());

    expect(prisma.bookingPaymentLinkSend.update).toHaveBeenCalledWith({
      where: { id: 'send_1' },
      data: expect.objectContaining({
        status: 'SENT',
        sentAt: expect.any(Date),
        providerMessageId: 'msg_1',
        failureCode: null,
        errorMessage: null,
      }),
    });
  });

  it('still records a flat payload that carries the id at the top level', async () => {
    await queue.processEmailJob(
      workerPayload({ top: { paymentLinkSendId: 'send_flat' } })
    );

    expect(prisma.bookingPaymentLinkSend.update).toHaveBeenCalledWith({
      where: { id: 'send_flat' },
      data: expect.objectContaining({ status: 'SENT' }),
    });
  });

  it('forwards the send id to the template as extras', async () => {
    await queue.processEmailJob(workerPayload());

    expect(emailService.sendPaymentLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'booking_1' }),
      expect.objectContaining({
        paymentLinkSendId: 'send_1',
        paymentLinkAttemptId: 'attempt_1',
        amount: 9000,
      })
    );
  });

  it('marks the row FAILED when the provider rejects the message', async () => {
    emailService.sendPaymentLinkEmail.mockResolvedValue({ success: false, reason: 'invalid recipient' });

    await queue.processEmailJob(workerPayload());

    expect(prisma.bookingPaymentLinkSend.update).toHaveBeenCalledWith({
      where: { id: 'send_1' },
      data: expect.objectContaining({
        status: 'FAILED',
        failureCode: 'EMAIL_PROVIDER_REJECTED',
        errorMessage: 'invalid recipient',
      }),
    });
  });

  it('keeps the row queued but records the provider error so the queue can retry', async () => {
    emailService.sendPaymentLinkEmail.mockRejectedValue(new Error('resend unavailable'));

    await expect(queue.processEmailJob(workerPayload())).rejects.toThrow('resend unavailable');

    expect(prisma.bookingPaymentLinkSend.update).toHaveBeenCalledWith({
      where: { id: 'send_1' },
      data: {
        failureCode: 'EMAIL_PROVIDER_ERROR',
        errorMessage: 'resend unavailable',
      },
    });
  });

  it('does not claim delivery for a job that carries no send id, and says so', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await queue.processEmailJob({ type: 'payment-link', bookingId: 'booking_1', data: { amount: 9000 } });

    expect(prisma.bookingPaymentLinkSend.update).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('paymentLinkSendId'));

    errorSpy.mockRestore();
  });

  it('stays silent for non payment-link jobs that have no send id', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.booking.findUnique.mockResolvedValue({ id: 'booking_1' });
    emailService.sendPaymentReminderEmail.mockResolvedValue({ success: true });

    await queue.processEmailJob({ type: 'payment-reminder', bookingId: 'booking_1', data: {} });

    expect(prisma.bookingPaymentLinkSend.update).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('paymentLinkSendId'));

    errorSpy.mockRestore();
  });
});
