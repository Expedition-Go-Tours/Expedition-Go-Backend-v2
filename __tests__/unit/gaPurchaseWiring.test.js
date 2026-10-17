/**
 * GA4 wiring: the exactly-once settlement hook must report each settled booking
 * to the Measurement Protocol service. The service itself gates on consent and
 * credentials (see ga4Measurement.test.js); this pins that the hook actually
 * calls it, so a refactor cannot silently stop reporting revenue.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  tour: { findUnique: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueWebhookRetry: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(async () => {}),
}));
jest.mock('../../src/core/services/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
  sendViaBot: jest.fn(() => Promise.resolve()),
  updateWebhookUrl: jest.fn(() => Promise.resolve()),
  WEBHOOKS: {},
}));
jest.mock('../../src/core/services/channelEmbeds', () => ({
  salesBookingConfirmed: jest.fn(() => ({ content: 'new booking', opts: {} })),
}));
jest.mock('../../src/core/services/ga4Measurement', () => ({
  sendPurchase: jest.fn(() => Promise.resolve()),
  sendRefund: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/eventEmitter', () => ({ emit: jest.fn() }));
jest.mock('../../src/core/services/redisClient', () => ({ setnx: jest.fn(async () => null), del: jest.fn(async () => undefined) }));
jest.mock('../../src/core/services/emailService', () => ({}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, defaultValue) => Promise.resolve(defaultValue)));
jest.mock('stripe', () => jest.fn(() => ({})));

const { notifyBookingsSettled } = require('../../src/core/services/stripeHelpers');
const { sendPurchase } = require('../../src/core/services/ga4Measurement');

const settledBooking = {
  id: 'booking-1',
  bookingNumber: 'GH-1001',
  customerId: 'customer-1',
  tourId: 'tour-1',
  source: 'GHANA',
  status: 'CONFIRMED',
  paymentStatus: 'SUCCEEDED',
  paymentTiming: 'now',
  grossAmount: 250,
  supplierPayout: 200,
  platformCommission: 50,
  currency: 'GHS',
  gaClientId: '1234567890.1700000000',
  analyticsConsent: true,
  tour: { id: 'tour-1', title: 'Cape Coast Tour', supplierId: 'supplier-1' },
};

describe('notifyBookingsSettled → GA4 purchase', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports each settled booking exactly once', () => {
    notifyBookingsSettled([settledBooking], { source: 'webhook' });
    expect(sendPurchase).toHaveBeenCalledTimes(1);
    expect(sendPurchase).toHaveBeenCalledWith(settledBooking);
  });

  it('reports every booking in a batch', () => {
    const second = { ...settledBooking, id: 'booking-2', bookingNumber: 'GH-1002' };
    notifyBookingsSettled([settledBooking, second], { source: 'system' });
    expect(sendPurchase).toHaveBeenCalledTimes(2);
    expect(sendPurchase).toHaveBeenNthCalledWith(2, second);
  });

  it('reports nothing when there are no settled bookings', () => {
    notifyBookingsSettled([], {});
    expect(sendPurchase).not.toHaveBeenCalled();
  });
});
