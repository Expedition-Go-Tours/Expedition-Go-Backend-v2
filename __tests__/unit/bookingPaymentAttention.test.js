/**
 * Server-authoritative booking attention.
 *
 * These tests pin the facts suppliers are allowed to see: unconfirmed payment
 * is never rendered as paid, a live link is identifiable, a scheduled retry is
 * not an action, and terminal capacity loss is information only.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  bookingPaymentAttempt: { findMany: jest.fn() },
  bookingPaymentLinkSend: { findMany: jest.fn() },
}));

const {
  buildBookingAttention,
} = require('../../src/core/services/bookingAttentionService');
const {
  assessEligibility,
  computeSessionExpiry,
} = require('../../src/core/services/paymentLinkService');

const NOW = new Date('2026-10-30T12:00:00.000Z');

function booking(overrides = {}) {
  return {
    id: 'booking_1',
    bookingNumber: 'TRG-1-2026-1',
    status: 'CONFIRMED',
    paymentTiming: 'later',
    paymentStatus: 'PENDING',
    origin: 'MARKETPLACE',
    grossAmount: '120.00',
    currency: 'USD',
    travelDate: new Date('2026-11-01T00:00:00.000Z'),
    selectedTime: '09:00',
    tour: {
      bookingAndTickets: JSON.stringify({
        availability: { timezone: 'Africa/Accra' },
        perSlotCutoff: true,
      }),
    },
    customer: { email: 'customer@example.com' },
    ...overrides,
  };
}

const flags = { base: true, supplier: true, recovery: true, chat: true };

function attention(overrides = {}, snapshot = {}, options = {}) {
  return buildBookingAttention(booking(overrides), snapshot, {
    canManage: true,
    flags,
    now: NOW,
    ...options,
  });
}

describe('booking attention projection', () => {
  it('keeps an ordinary unpaid pay-later reservation unconfirmed while allowing a proactive link', () => {
    const result = attention();

    expect(result.level).toBe('INFO');
    expect(result.reasonCode).toBe('PAYMENT_NOT_CONFIRMED');
    expect(result.payment.confirmed).toBe(false);
    expect(result.payment.confirmationState).toBe('UNCONFIRMED');
    expect(result.payment.amountDue).toEqual({ amount: 120, currency: 'USD' });
    expect(result.link.emailState).toBe('NOT_SENT');
    expect(result.link.canSend).toBe(true);
    expect(result.actions).toEqual([{ code: 'SEND_PAYMENT_LINK', label: 'Send payment link' }]);
  });

  it('asks for a link when 3DS blocks the automatic charge', () => {
    const result = attention({
      requiresPaymentActionAt: NOW,
      paymentFailureCode: 'AUTHENTICATION_REQUIRED',
    });

    expect(result.level).toBe('ACTION_REQUIRED');
    expect(result.code).toBe('PAYMENT_ACTION_REQUIRED');
    expect(result.reasonCode).toBe('AUTHENTICATION_REQUIRED');
    expect(result.message).toMatch(/payment has not been confirmed/i);
    expect(result.payment.failureReason).toMatch(/3D Secure/i);
    expect(result.actions.map((a) => a.code)).toEqual(['SEND_PAYMENT_LINK']);
  });

  it('shows an emailed live link with resend and regenerate, never a fresh send', () => {
    const result = attention({}, {
      attempts: [{
        id: 'attempt_1',
        source: 'SUPPLIER_LINK',
        status: 'ACTIVE',
        expiresAt: new Date('2026-10-31T12:00:00.000Z'),
        createdAt: NOW,
      }],
      sends: [{
        id: 'send_1',
        attemptId: 'attempt_1',
        channel: 'EMAIL',
        status: 'SENT',
        sentAt: NOW,
        createdAt: NOW,
      }],
    });

    expect(result.link.active).toBe(true);
    expect(result.link.emailState).toBe('SENT');
    expect(result.link.canSend).toBe(false);
    expect(result.actions.map((a) => a.code)).toEqual([
      'RESEND_PAYMENT_LINK',
      'REGENERATE_PAYMENT_LINK',
    ]);
    expect(result.message).toMatch(/secure payment link was emailed/i);
  });

  it('offers no action while Stripe is still creating the session', () => {
    const result = attention({}, {
      attempts: [{
        id: 'attempt_creating',
        source: 'SUPPLIER_LINK',
        status: 'CREATING',
        expiresAt: new Date('2026-10-31T12:00:00.000Z'),
        createdAt: NOW,
      }],
      sends: [],
    });

    expect(result.link.active).toBe(false);
    expect(result.link.canSend).toBe(false);
    expect(result.link.canResend).toBe(false);
    expect(result.link.canRegenerate).toBe(false);
    expect(result.code).toBe('PAYMENT_PROCESSING');
    expect(result.reasonCode).toBe('PAYMENT_LINK_PREPARING');
    expect(result.title).toBe('Preparing secure link');
    expect(result.actions).toEqual([]);
  });

  it('lets a supplier email a live customer-created link that has no send record', () => {
    const result = attention({}, {
      attempts: [{
        id: 'attempt_customer',
        source: 'CUSTOMER_PAY_NOW',
        status: 'ACTIVE',
        expiresAt: new Date('2026-10-31T12:00:00.000Z'),
        createdAt: NOW,
      }],
      sends: [],
    });

    expect(result.link.emailState).toBe('NOT_SENT');
    expect(result.link.canSend).toBe(true);
    expect(result.link.canResend).toBe(false);
    expect(result.actions.map((a) => a.code)).toContain('SEND_PAYMENT_LINK');
  });

  it('reports a scheduled automatic retry without asking the supplier to act', () => {
    const result = attention({
      paymentFailureCode: 'CARD_DECLINED_RETRYING',
      nextRetryAt: new Date('2026-10-30T13:00:00.000Z'),
    });

    expect(result.code).toBe('PAYMENT_FAILED');
    expect(result.title).toBe('Payment retrying');
    expect(result.payment.retrying).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it('reports an exhausted decline as a safe actionable failure', () => {
    const result = attention({
      requiresPaymentActionAt: NOW,
      paymentFailureCode: 'CARD_DECLINED',
      nextRetryAt: null,
    });

    expect(result.code).toBe('PAYMENT_ACTION_REQUIRED');
    expect(result.reasonCode).toBe('CARD_DECLINED');
    expect(result.payment.failureReason).toBe('The saved card was declined.');
    expect(result.actions.map((a) => a.code)).toEqual(['SEND_PAYMENT_LINK']);
  });

  it('does not hide an unpaid completed or no-show booking behind the terminal state', () => {
    const completed = attention({ status: 'COMPLETED' });
    expect(completed.level).toBe('ACTION_REQUIRED');
    expect(completed.code).toBe('PAYMENT_ACTION_REQUIRED');
    expect(completed.reasonCode).toBe('PAYMENT_NOT_CONFIRMED');
    expect(completed.actions).toEqual([]);

    const noShow = attention({ status: 'NO_SHOW' });
    expect(noShow.code).toBe('PAYMENT_ACTION_REQUIRED');
    expect(noShow.actions).toEqual([]);
  });

  it('marks terminal cancelled capacity as unavailable without resurrection actions', () => {
    const result = attention({
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancellationCode: 'OVERBOOKED',
    });

    expect(result.level).toBe('CRITICAL');
    expect(result.code).toBe('RESERVATION_UNAVAILABLE');
    expect(result.payment.confirmed).toBe(false);
    expect(result.actions).toEqual([]);
  });

  it('does not expose link actions when the permission or feature flag is absent', () => {
    const noPermission = attention({
      requiresPaymentActionAt: NOW,
      paymentFailureCode: 'AUTHENTICATION_REQUIRED',
    }, {}, { canManage: false });
    expect(noPermission.code).toBe('PAYMENT_ACTION_REQUIRED');
    expect(noPermission.actions).toEqual([]);

    const flagOff = attention({
      requiresPaymentActionAt: NOW,
      paymentFailureCode: 'AUTHENTICATION_REQUIRED',
    }, {}, { flags: { base: false, supplier: false, recovery: false, chat: false } });
    expect(flagOff.actions).toEqual([]);
  });

  it('does not offer a link when the customer has no email address', () => {
    const result = attention({
      customer: null,
      leadTravelerEmail: null,
      requiresPaymentActionAt: NOW,
      paymentFailureCode: 'AUTHENTICATION_REQUIRED',
    });

    expect(result.link.customerEmailOnFile).toBe(false);
    expect(result.actions).toEqual([]);
  });

  it('warns when the payment window closes within 24 hours', () => {
    const result = attention({
      travelDate: new Date('2026-10-31T00:00:00.000Z'),
      selectedTime: '09:00',
    });

    expect(result.level).toBe('WARNING');
    expect(result.code).toBe('RESERVATION_AT_RISK');
    expect(result.reasonCode).toBe('PAYMENT_WINDOW_CLOSING');
    expect(result.actions.map((a) => a.code)).toEqual(['SEND_PAYMENT_LINK']);
  });

  it('still allows a resend in the final two hours while a live session remains', () => {
    const now = new Date('2026-10-30T14:30:00.000Z');
    const result = attention({
      travelDate: new Date('2026-10-30T16:00:00.000Z'),
      selectedTime: '16:00',
    }, {
      attempts: [{
        id: 'attempt_1',
        status: 'ACTIVE',
        expiresAt: new Date('2026-10-30T16:00:00.000Z'),
        createdAt: new Date('2026-10-30T12:00:00.000Z'),
      }],
      sends: [{
        id: 'send_1',
        attemptId: 'attempt_1',
        status: 'SENT',
        sentAt: new Date('2026-10-30T12:00:00.000Z'),
        createdAt: new Date('2026-10-30T12:00:00.000Z'),
      }],
    }, { now });

    expect(result.link.active).toBe(true);
    expect(result.link.canSend).toBe(false);
    expect(result.link.canRegenerate).toBe(false);
    expect(result.link.canResend).toBe(true);
    expect(result.actions.map((a) => a.code)).toEqual(['RESEND_PAYMENT_LINK']);
    expect(result.actions.some((a) => a.code === 'REGENERATE_PAYMENT_LINK')).toBe(false);
  });

  it('does not offer regenerate once Stripe has less than 30 minutes left', () => {
    const result = attention({
      travelDate: new Date('2026-10-30T14:20:00.000Z'),
      selectedTime: '16:00',
      // deadline is 14:00Z, so this is already outside the issue window.
      paymentFailureCode: 'CARD_DECLINED',
      requiresPaymentActionAt: NOW,
    }, {
      attempts: [{
        id: 'attempt_1',
        status: 'ACTIVE',
        expiresAt: new Date('2026-10-30T14:00:00.000Z'),
        createdAt: NOW,
      }],
      sends: [{
        id: 'send_1',
        attemptId: 'attempt_1',
        status: 'SENT',
        sentAt: NOW,
        createdAt: NOW,
      }],
    }, { now: new Date('2026-10-30T14:30:00.000Z') });

    // The live attempt is expired by `now`, so it is not live. The failure is
    // actionable only as information; no new link can be issued this close.
    expect(result.link.active).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.nextStep).toMatch(/window has closed/i);
  });
});

describe('payment-link eligibility and session window', () => {
  it('computes expiry as the earlier of 24 hours and the activity cutoff', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const deadline = new Date('2026-10-30T20:00:00.000Z');
    expect(computeSessionExpiry(now, deadline).toISOString()).toBe('2026-10-30T20:00:00.000Z');

    const farDeadline = new Date('2026-11-01T20:00:00.000Z');
    expect(computeSessionExpiry(now, farDeadline).toISOString()).toBe('2026-10-31T12:00:00.000Z');
  });

  it('refuses a non-marketplace or already-settled booking', () => {
    expect(assessEligibility(booking({ origin: 'SUPPLIER_CREATED' }), { now: NOW }).reasonCode)
      .toBe('NOT_MARKETPLACE_BOOKING');
    expect(assessEligibility(booking({ paymentStatus: 'SUCCEEDED' }), { now: NOW }).reasonCode)
      .toBe('PAYMENT_ALREADY_SETTLED');
  });

  it('accepts an unpaid marketplace reservation with an email before the cutoff', () => {
    const result = assessEligibility(booking(), { now: NOW });
    expect(result.eligible).toBe(true);
    expect(result.customerEmail).toBe('customer@example.com');
    expect(result.deadlineAt.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(result.sessionExpiresAt.getTime()).toBeLessThanOrEqual(result.deadlineAt.getTime());
  });

  it('refuses once the activity has started, even with an email', () => {
    const result = assessEligibility(booking(), {
      now: new Date('2026-11-01T09:30:00.000Z'),
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('ACTIVITY_STARTED');
  });

  it('uses the selected clock time even when the tour uses a day-level cutoff', () => {
    const result = assessEligibility(booking({
      tour: {
        bookingAndTickets: JSON.stringify({
          availability: { timezone: 'Africa/Accra' },
          perSlotCutoff: false,
        }),
      },
    }), { now: new Date('2026-11-01T06:00:00.000Z') });

    expect(result.eligible).toBe(true);
    expect(result.activityStart.toISOString()).toBe('2026-11-01T09:00:00.000Z');
    expect(result.deadlineAt.toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });
});
