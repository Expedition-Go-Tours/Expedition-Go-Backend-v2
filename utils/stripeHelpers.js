/**
 * Stripe Integration Helpers - Production Ready
 * Handles Stripe payments, Connect accounts, and webhooks
 * 
 * Features:
 * - Payment Intent creation with commission splits
 * - Stripe Connect account management
 * - Webhook signature verification
 * - Commission calculations
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const crypto = require('crypto');
const Stripe = require('stripe');

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is required to use Stripe.');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-02-24.acacia',
      maxNetworkRetries: 2,
      timeout: 30000,
    });
  }
  return _stripe;
}
const prisma = require('./prismaClient');
const { enqueueEmail, enqueueEvent, enqueueNotification } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const getConfig = require('./getConfig');
const { normalizeCommissionRate } = require('./commission');
const redis = require('./redisClient');
const { invalidateUserCache } = require('../middleware/authMiddleware');
const { travelerCount, parseBlob } = require('./availabilityCore');

/**
 * A valid Stripe Customer ID is a non-empty `cus_...` string.
 */
function isValidStripeCustomerId(id) {
  return typeof id === 'string' && /^cus_[A-Za-z0-9]{3,}$/.test(id);
}

/**
 * Deterministic string form of a JSON value (recursive key sort) so identical
 * logical objects always serialize identically regardless of key insertion
 * order.
 */
function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Create a Payment Intent with commission split
 */
async function createPaymentIntent({
  amount,
  currency = 'USD',
  customerId,
  paymentMethodId,
  metadata = {},
  idempotencyKey,
  confirm = true
}) {
  try {
    // Only attach a customer when we have a real Stripe Customer ID. Stripe
    // rejects an empty string for 'customer' and a PaymentIntent is valid
    // without one, so a user whose async customer creation never completed
    // can still check out.
    const paymentIntentData = {
      amount,
      currency: currency.toLowerCase(),
      payment_method: paymentMethodId,
      confirmation_method: 'manual',
      confirm,
      // Stripe only allows return_url when confirm=true — omit it otherwise
      // (expedition creates with confirm:false and charges via a later
      // confirm() call, where redirects are handled through client_secret).
      ...(confirm ? { return_url: `${process.env.CLIENT_URL}/booking/complete` } : {}),
      metadata
    };
    if (isValidStripeCustomerId(customerId)) {
      paymentIntentData.customer = customerId;
    }

    // Idempotency: an explicit key wins, otherwise derive one from the FINAL
    // request body so the key changes iff the request changes. A hand-picked
    // field list would silently break whenever a body field is added or
    // removed between retries (e.g. a customer attached once async creation
    // completes) — Stripe rejects a reused key with different parameters.
    const options = idempotencyKey
      ? { idempotencyKey }
      : { idempotencyKey: `pi-create:${crypto.createHash('sha256').update(canonicalStringify(paymentIntentData)).digest('hex')}` };
    const paymentIntent = await getStripe().paymentIntents.create(paymentIntentData, options);

    console.log(` Payment Intent created: ${paymentIntent.id} for amount: ${amount}`);
    return paymentIntent;
  } catch (error) {
    console.error(' Payment Intent creation failed:', error);
    throw new Error(`Failed to create payment: ${error.message}`);
  }
}

/**
 * Create a hosted Stripe Checkout Session for an expedition booking.
 *
 * Pay-now bookings redirect the customer to Stripe's hosted payment page; the
 * `checkout.session.completed` webhook reconciles the booking (attaches the
 * session's PaymentIntent and settles it through the same idempotent path as
 * PaymentIntents). Pay-later payment links reuse this with an `expiresAt`.
 *
 * @param {object} opts
 * @param {number} opts.amount - total in minor units (e.g. cents)
 * @param {string} [opts.currency] - ISO currency code (default 'USD')
 * @param {string} opts.bookingId - Booking id (client_reference_id + metadata)
 * @param {string} [opts.tourTitle] - product name shown on the payment page
 * @param {string} [opts.customerId] - Stripe Customer id (optional)
 * @param {string} [opts.customerEmail] - fallback email when no customer
 * @param {Date} [opts.expiresAt] - session expiry (pay-later payment links)
 * @returns {Promise<object>} the Stripe Checkout Session
 */
async function createCheckoutSession({
  amount,
  currency = 'USD',
  bookingId,
  tourTitle,
  customerId,
  customerEmail,
  expiresAt,
  successPath,
}) {
  if (!bookingId) throw new Error('bookingId is required to create a Checkout Session');
  if (!amount || amount <= 0) throw new Error('amount must be a positive value in minor units');

  // `successPath` lets callers customize where Stripe redirects after payment.
  // When omitted, falls back to the legacy /booking/confirmation/:bookingId.
  // Use {CHECKOUT_SESSION_ID} for the Stripe-generated session id template.
  const successUrl = successPath
    ? `${process.env.CLIENT_URL}${successPath}`
    : `${process.env.CLIENT_URL}/booking/confirmation/${bookingId}`;
  const cancelUrl = `${process.env.CLIENT_URL}/booking`;

  return getStripe().checkout.sessions.create({
    mode: 'payment',
    client_reference_id: bookingId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: amount,
          product_data: { name: tourTitle || 'Expedition booking' },
        },
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { bookingIds: bookingId, source: 'expedition' },
    payment_intent_data: { metadata: { bookingIds: bookingId, source: 'expedition' } },
    ...(customerId ? { customer: customerId } : {}),
    ...((!customerId && customerEmail) ? { customer_email: customerEmail } : {}),
    ...(expiresAt ? { expires_at: Math.floor(expiresAt.getTime() / 1000) } : {}),
  });
}

/**
 * Resolve the booking id(s) a Checkout Session belongs to. Sessions created by
 * this app set `metadata.bookingIds`; `client_reference_id` is the fallback.
 */
function resolveSessionBookingIds(session) {
  const meta = session?.metadata?.bookingIds;
  if (typeof meta === 'string') return meta.split(',').map((s) => s.trim()).filter(Boolean);
  if (session?.client_reference_id) return [session.client_reference_id];
  return [];
}

/**
 * Create a Stripe Customer for a user and persist the ID on the User row.
 *
 * Idempotent per user for 24h via the idempotency key — concurrent checkouts
 * and queue retries resolve to the same Customer instead of duplicating it.
 *
 * @param {{ userId: string, email?: string, name?: string }} data
 * @returns {Promise<string>} the Stripe customer ID
 */
async function createStripeCustomer({ userId, email, name }) {
  const customer = await getStripe().customers.create(
    {
      email,
      name,
      metadata: { userId, source: 'local_auth' },
    },
    { idempotencyKey: `create-customer:${userId}` }
  );

  await prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

/**
 * Ensure a user has a Stripe Customer, creating one lazily if missing.
 *
 * Returns the existing/created customer ID, or `null` when one could not be
 * produced — the caller may then charge WITHOUT a customer (graceful
 * degradation), since a PaymentIntent does not require one.
 *
 * Concurrency: a short-lived Redis lock (SET NX) serializes creation per user
 * so two simultaneous checkouts cannot create duplicate customers. When Redis
 * is unavailable the lock is skipped and creation is attempted directly (the
 * idempotency key still guards duplicates). If another request holds the lock,
 * we poll briefly for the freshly persisted ID before giving up.
 */
async function ensureStripeCustomer(user) {
  if (!user || !user.id) return null;
  if (isValidStripeCustomerId(user.stripeCustomerId)) {
    return user.stripeCustomerId;
  }

  const lockKey = `stripe:customer-lock:${user.id}`;
  const acquired = await redis.setnx(lockKey, 10);

  const createAndPersist = async () => {
    try {
      const customerId = await createStripeCustomer({
        userId: user.id,
        email: user.email,
        name: user.name,
      });
      invalidateUserCache(user.id);
      return customerId;
    } catch (err) {
      console.error(`[Stripe] Failed to create customer for user ${user.id}:`, err.message);
      notifyAdmin({
        type: 'STRIPE_CUSTOMER_CREATE_FAILED',
        title: 'Stripe customer creation failed',
        message: `Could not create a Stripe customer for user ${user.id} (${user.email || 'no email'}). Checkout proceeded without a customer.`,
        data: { userId: user.id },
      }).catch(() => {});
      return null;
    }
  };

  if (acquired === true) {
    try {
      return await createAndPersist();
    } finally {
      await redis.del(lockKey).catch(() => {});
    }
  }

  if (acquired === null) {
    // Redis unavailable — cannot lock. Attempt creation directly (best-effort).
    return createAndPersist();
  }

  // Lock held by a concurrent request — wait for it to persist the customer.
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { stripeCustomerId: true },
      });
      if (fresh && isValidStripeCustomerId(fresh.stripeCustomerId)) {
        return fresh.stripeCustomerId;
      }
    } catch {
      // transient read failure — keep polling
    }
  }

  return null;
}

/**
 * Create a Stripe refund for a PaymentIntent
 */
async function createRefund(paymentIntentId, amount = null) {
  try {
    const refundData = { payment_intent: paymentIntentId };
    if (amount !== null) {
      refundData.amount = amount;
    }
    const refund = await getStripe().refunds.create(refundData);
    console.log(` Refund created: ${refund.id} for PaymentIntent: ${paymentIntentId}`);
    return refund;
  } catch (error) {
    console.error(' Refund creation failed:', error);
    throw new Error(`Failed to create refund: ${error.message}`);
  }
}

/**
 * Try to cancel a PaymentIntent before deleting a tour.
 *
 * Returns:
 *   { ok: true }            — intent is canceled (or was already canceled)
 *   { ok: false, reason }   — cannot prove it is cancelable, caller must block:
 *                             'status_succeeded' | 'status_processing' |
 *                             'cancel_failed' | 'unavailable'
 *
 * Never throws. If we cannot PROVE the intent is canceled we report failure,
 * because the alternative is silently cancelling a booking whose money may
 * be in flight.
 */
async function cancelPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return { ok: true };

  let intent;
  try {
    intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
  } catch (error) {
    console.error('[Stripe] PaymentIntent retrieve failed:', paymentIntentId, error.message);
    return { ok: false, reason: 'unavailable' };
  }

  if (intent.status === 'canceled') return { ok: true };
  if (intent.status === 'succeeded' || intent.status === 'processing') {
    return { ok: false, reason: `status_${intent.status}` };
  }

  try {
    await getStripe().paymentIntents.cancel(paymentIntentId);
    return { ok: true };
  } catch (error) {
    console.error('[Stripe] PaymentIntent cancel failed:', paymentIntentId, error.message);
    return { ok: false, reason: 'cancel_failed' };
  }
}

/**
 * Calculate commission based on supplier tier and booking amount
 */
async function calculateCommission(bookingAmount, supplierProfile) {
  const amount = parseFloat(bookingAmount);

  // Normalize the config value: tolerates both "0.15" and "15" so a
  // percentage-style config can never overflow Decimal(5,4).
  const defaultRate = normalizeCommissionRate(await getConfig('commission.default_rate', '0.15'));
  let commissionRate = defaultRate;

  // Adjust rate based on supplier performance
  // Use totalBookings + 1 since this booking hasn't been counted yet
  const bookingCount = supplierProfile.totalBookings + 1;
  if (bookingCount > 100) {
    commissionRate = Math.max(0.01, defaultRate - 0.03);
  } else if (bookingCount > 50) {
    commissionRate = Math.max(0.01, defaultRate - 0.02);
  } else if (supplierProfile.averageRating && supplierProfile.averageRating >= 4.8) {
    commissionRate = Math.max(0.01, defaultRate - 0.01);
  }

  const commissionAmount = amount * commissionRate;
  const supplierPayout = amount - commissionAmount;

  return {
    rate: commissionRate,
    amount: commissionAmount,
    supplierPayout: supplierPayout
  };
}

/**
 * Process Stripe webhook events
 *
 * Idempotency is guaranteed by wrapping the entire flow in a single
 * $transaction.  The stripeEvent upsert + business logic + processed
 * flag update happen atomically.  If the transaction rolls back,
 * the event remains un-processed and a retry is safe.
 *
 * Side-effects (emails, admin notifications, analytics) run AFTER
 * the transaction commits so they are never emitted for a rolled-back
 * event.
 */
async function processStripeWebhook(event) {
  console.log(` Processing Stripe webhook: ${event.type}`);

  let bookings = [];
  let oversoldBookings = [];
  let cancelledBookings = [];
  let reconciledPaymentIntentId = null;

  await prisma.$transaction(async (tx) => {
    // Re-check inside the transaction — serialized by Postgres, no race
    const existingEvent = await tx.stripeEvent.findUnique({
      where: { stripeEventId: event.id }
    });

    if (existingEvent && existingEvent.processed) {
      console.log(` Event ${event.id} already processed, skipping`);
      return;
    }

    // Upsert event record (creates on first call, updates on concurrent duplicate)
    await tx.stripeEvent.upsert({
      where: { stripeEventId: event.id },
      update: { data: event },
      create: {
        stripeEventId: event.id,
        eventType: event.type,
        data: event,
        processed: false
      }
    });

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const result = await handlePaymentSucceeded(event.data.object, tx);
        bookings = result.bookings;
        oversoldBookings = result.oversold;
        reconciledPaymentIntentId = event.data.object?.id;
        break;
      }

      case 'payment_intent.payment_failed':
        await handlePaymentFailed(event.data.object, tx);
        break;

      case 'checkout.session.completed': {
        const session = event.data.object;
        // ── Draft-based hold (pay-now) ──────────────────────────────
        // If the session's metadata.bookingIds refers to a CheckoutDraft
        // (not a Booking), materialize it into a real Booking.
        const draftId = resolveSessionBookingIds(session)[0];
        const draftRow = draftId
          ? await tx.checkoutDraft.findUnique({ where: { id: draftId } }).catch(() => null)
          : null;
        if (draftRow) {
          const { materializeHold } = require('./checkoutHold');
          const result = await materializeHold(draftId, session, session.payment_intent);
          if (result.ok) {
            bookings = [result.booking];
          } else if (result.oversold) {
            // Capacity vanished mid-hold — auto-refund the PI.
            oversoldBookings = [{ stripePaymentIntentId: session.payment_intent }];
          }
          reconciledPaymentIntentId = session.payment_intent || null;
          break;
        }
        // ── Legacy flow (booking created before session) ────────────
        const bookingIds = resolveSessionBookingIds(session);
        if (bookingIds.length > 0 && session?.payment_intent) {
          await tx.booking.updateMany({
            where: { id: { in: bookingIds }, paymentStatus: 'PENDING', paidAt: null },
            data: {
              stripePaymentIntentId: session.payment_intent,
              ...(session.id ? { stripeCheckoutSessionId: session.id } : {}),
            },
          });
          const result = await handlePaymentSucceeded(
            { id: session.payment_intent, metadata: { bookingIds: bookingIds.join(',') } },
            tx
          );
          bookings = result.bookings;
          oversoldBookings = result.oversold;
          reconciledPaymentIntentId = session.payment_intent;
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object;
        // ── Draft-based hold (pay-now) ──────────────────────────────
        // Release the hold (seats freed immediately).
        const draftId = resolveSessionBookingIds(session)[0];
        const draftRow = draftId
          ? await tx.checkoutDraft.findUnique({ where: { id: draftId } }).catch(() => null)
          : null;
        if (draftRow && draftRow.status === 'HOLDING') {
          await tx.checkoutDraft.update({
            where: { id: draftId },
            data: { status: 'EXPIRED' },
          });
          break;
        }
        // ── Legacy flow (booking created before session) ────────────
        const bookingIds = resolveSessionBookingIds(session);
        if (bookingIds.length > 0) {
          const cancelled = await tx.booking.updateMany({
            where: { id: { in: bookingIds }, status: 'PENDING', paymentStatus: 'PENDING', paidAt: null },
            data: {
              status: 'CANCELLED',
              paymentStatus: 'FAILED',
              cancellationReason: 'Payment session expired before completion',
              cancelledAt: new Date(),
            },
          });
          if (cancelled.count > 0) {
            cancelledBookings = await tx.booking.findMany({
              where: { id: { in: bookingIds } },
              include: {
                customer: true,
                tour: { select: { id: true, title: true, supplierId: true } },
              },
            });
          }
        }
        break;
      }

      default:
        console.log(` Unhandled event type: ${event.type}`);
    }

    // Mark processed INSIDE the same transaction.
    // If this line is reached, the transaction commits everything atomically.
    // A concurrent duplicate would have its upsert succeed but the stripeEvent
    // already has processed=false here; however Postgres serialization ensures
    // only one transaction commits — the others fail and retry.
    await tx.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: { processed: true }
    });
  });

  // ── Side effects run AFTER the transaction committed ──────────────
  // These are fire-and-forget; failures are caught and logged but do
  // not affect the booking state (which is already committed).

  for (const booking of bookings) {
    const isExpedition = booking.source === 'EXPEDITION';
    const chargedReservation = booking.paymentTiming === 'later';
    // Manual-confirmation tour: customer gets "payment received — awaiting
    // confirmation" instead of a confirmation email.
    const manualHold = (parseBlob(booking.tour?.bookingAndTickets) || {}).instantConfirmation === false;

    // A reserve-now-pay-later booking being charged gets a distinct "your
    // reservation was charged" email for the customer and supplier instead of
    // the pay-now "new confirmed booking" confirmation.
    enqueueEmail(manualHold
      ? { type: 'awaiting-confirmation', bookingId: booking.id }
      : chargedReservation
        ? { type: 'pay-later-charged', bookingId: booking.id }
        : { type: 'booking-confirmed', bookingId: booking.id })
      .catch((err) => console.error(`[Email] ${manualHold ? 'Awaiting confirmation' : chargedReservation ? 'Reservation charge' : 'Booking confirmation'} failed:`, err.message));
    enqueueEmail(chargedReservation
      ? { type: 'supplier-pay-later-charged', bookingId: booking.id }
      : { type: 'supplier-new-booking', bookingId: booking.id })
      .catch((err) => console.error(`[Email] ${chargedReservation ? 'Supplier reservation charge' : 'Supplier notification'} failed:`, err.message));

    if (isExpedition) {
      notifyAdmin({
        type: 'BOOKING_CONFIRMED',
        title: 'Expedition Booking Confirmed',
        message: `Booking #${booking.bookingNumber} — $${parseFloat(booking.grossAmount).toFixed(2)} for "${booking.tour.title}" has been confirmed`,
        data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.grossAmount, source: 'expedition' },
      }).catch((err) => console.error('[AdminNotification] Expedition notification failed:', err.message));
    } else {
      notifyAdmin({
        type: 'PAYOUT_NEEDS_APPROVAL',
        title: 'New Payout Pending',
        message: `Booking #${booking.bookingNumber}: $${parseFloat(booking.supplierPayout).toFixed(2)} payout awaiting approval`,
        data: { bookingId: booking.id, tourTitle: booking.tour?.title, amount: booking.supplierPayout },
      }).catch((err) => console.error('[AdminNotification] Payout notification failed:', err.message));
    }

    enqueueEvent({
      name: isExpedition ? 'expedition.booking_completed' : 'booking.completed',
      userId: booking.customerId,
      resource: 'Booking',
      resourceId: booking.id,
      properties: {
        tourId: booking.tourId,
        total: parseFloat(booking.grossAmount),
        currency: booking.currency,
        supplierPayout: parseFloat(booking.supplierPayout),
        commissionAmount: parseFloat(booking.platformCommission),
        supplierId: booking.tour?.supplierId,
        paymentIntentId: reconciledPaymentIntentId || event.data.object?.id,
      },
      source: isExpedition ? 'expedition' : 'webhook',
    });
  }

  // ── Oversold offer capacity: refund immediately ─────────────────────
  // The booking was cancelled inside the transaction; money must go back
  // to the customer. Best-effort: failures are logged so an operator can
  // follow up, but they never affect the already-committed booking state.
  for (const booking of oversoldBookings) {
    createRefund(booking.stripePaymentIntentId)
      .then((refund) => {
        console.log(` Refunded oversold booking ${booking.id}: ${refund.id}`);
        enqueueEmail({
          type: 'refund-completed',
          bookingId: booking.id,
          data: { refundReference: refund.id, refundedAt: new Date().toISOString() },
        }).catch(() => {});
      })
      .catch((err) => {
        console.error(`[Oversold] Booking ${booking.id} cancelled but refund failed: ${err.message}`);
        notifyAdmin({
          type: 'REFUND_NEEDS_ATTENTION',
          title: 'Oversold Offer Refund Pending',
          message: `Booking #${booking.bookingNumber} was cancelled (offer capacity exceeded) but the Stripe refund failed: ${err.message}`,
          data: { bookingId: booking.id, paymentIntentId: booking.stripePaymentIntentId },
        }).catch(() => {});
      });
  }

  // ── Expired Checkout Sessions: cancelled bookings ──────────────────────
  // The booking was cancelled inside the transaction; these side effects run
  // only after the commit. Fire-and-forget like the settlement notifications.
  for (const booking of cancelledBookings) {
    enqueueNotification({
      userId: booking.customerId,
      type: 'BOOKING_CANCELLED',
      title: 'Booking Not Completed',
      message: `Your booking for "${booking.tour?.title || 'the tour'}" was cancelled because payment was not completed. You can rebook anytime.`,
      data: { bookingId: booking.id },
    }).catch((err) => console.error('[Webhook] Cancellation notification failed:', err.message));

    enqueueEvent({
      name: 'booking.expired',
      userId: booking.customerId,
      resource: 'Booking',
      resourceId: booking.id,
      properties: { tourId: booking.tourId, reason: 'checkout session expired', source: 'stripe' },
    }).catch(() => {});
  }

  return { success: true, message: 'Event processed' };
}

/**
 * Handle successful payment
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 * @param {object} [tx] - Optional Prisma transaction client.
 *   When provided, all DB operations use this client (called from
 *   within the parent transaction in processStripeWebhook).
 *   When omitted, creates its own transaction (standalone call).
 * @returns {Promise<Array>} Array of booking records (for side effects)
 */
async function handlePaymentSucceeded(paymentIntent, tx = null) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  let bookings;
  const oversoldBookings = [];

  const dbWork = async (client) => {
    // Try to find bookings by metadata.bookingIds (main flow: bookings exist before PI)
    if (bookingIds.length > 0) {
      const updatedBookings = await client.booking.updateMany({
        where: {
          id: { in: bookingIds },
          stripePaymentIntentId: paymentIntent.id,
          // Still-unsettled bookings may be paid out:
          //  - normal flow: status PENDING until the webhook settles it
          //  - reserve-now-pay-later: status CONFIRMED from creation but
          //    paymentStatus stays PENDING until the deferred charge lands.
          // A booking the supplier already cancelled must never be
          // resurrected by a late webhook, so we gate on paymentStatus.
          paymentStatus: { in: ['PENDING', 'PROCESSING'] },
          OR: [{ status: 'PENDING' }, { paymentTiming: 'later' }],
        },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'SUCCEEDED',
          paidAt: new Date()
        }
      });

      console.log(` Updated ${updatedBookings.count} bookings to CONFIRMED`);

      if (updatedBookings.count > 0) {
        bookings = await client.booking.findMany({
          where: { id: { in: bookingIds } },
          include: {
            customer: true,
            tour: { include: { supplier: true, bookingAndTickets: true } }
          }
        });
      }
    }

    // Fallback: find expedition booking by stripePaymentIntentId
    // (booking was created after PI confirmation, metadata updated async)
    if (!bookings || bookings.length === 0) {
      // Match PENDING *and* PROCESSING: TRAVIO checkouts create bookings with
      // paymentStatus PROCESSING, Expedition uses PENDING. Reserve-now-pay-later
      // bookings are CONFIRMED from creation but stay PENDING payment-wise until
      // the deferred charge lands, so they are matched here too. A booking that
      // is still awaiting settlement is confirmable.
      const updated = await client.booking.updateMany({
        where: {
          stripePaymentIntentId: paymentIntent.id,
          paymentStatus: { in: ['PENDING', 'PROCESSING'] },
          OR: [{ status: 'PENDING' }, { paymentTiming: 'later' }]
        },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'SUCCEEDED',
          paidAt: new Date()
        }
      });

      if (updated.count > 0) {
        console.log(` Updated ${updated.count} expedition bookings to CONFIRMED`);
        bookings = await client.booking.findMany({
          where: { stripePaymentIntentId: paymentIntent.id },
          include: {
            customer: true,
            tour: { include: { supplier: true, bookingAndTickets: true } }
          }
        });
      }
    }

    if (!bookings || bookings.length === 0) {
      console.log(' No bookings found for payment intent:', paymentIntent.id);
      return;
    }

    // Manual-confirmation tours: the money is captured but the booking must NOT
    // be auto-confirmed — it stays PENDING (paid) until the supplier accepts it
    // via the dashboard. The updateMany above claimed the rows as CONFIRMED, so
    // re-hold the manual ones here (same transaction).
    const manualHoldIds = (bookings || [])
      .filter((b) => (parseBlob(b.tour?.bookingAndTickets) || {}).instantConfirmation === false)
      .map((b) => b.id);
    if (manualHoldIds.length > 0) {
      const reverted = await client.booking.updateMany({
        where: { id: { in: manualHoldIds } },
        data: { status: 'PENDING' },
      });
      console.log(` ${reverted.count} booking(s) held PENDING for manual confirmation`);
      for (const b of bookings) {
        if (manualHoldIds.includes(b.id)) b.status = 'PENDING';
      }
    }

    for (const booking of bookings) {
      const manualHold = manualHoldIds.includes(booking.id);
      await client.notification.create({
        data: {
          userId: booking.customerId,
          type: manualHold ? 'BOOKING_AWAITING_CONFIRMATION' : 'BOOKING_CONFIRMED',
          title: manualHold ? 'Payment received — awaiting confirmation' : 'Booking Confirmed',
          message: manualHold
            ? `Your payment for "${booking.tour.title}" was received. The tour provider will confirm your booking shortly.`
            : `Your booking for "${booking.tour.title}" has been confirmed!`,
          data: { bookingId: booking.id }
        }
      });

      await client.notification.create({
        data: {
          userId: booking.tour.supplierId,
          type: 'BOOKING_CONFIRMED',
          title: 'New Booking Received',
          message: `You have a new booking for "${booking.tour.title}"`,
          data: { bookingId: booking.id }
        }
      });

      await client.supplierProfile.update({
        where: { userId: booking.tour.supplierId },
        data: {
          totalBookings: { increment: 1 },
          totalEarnings: { increment: booking.supplierPayout }
        }
      });

      await client.tour.update({
        where: { id: booking.tourId },
        data: {
          totalBookings: { increment: 1 },
          totalRevenue: { increment: booking.grossAmount }
        }
      });

      if (booking.appliedOfferId) {
        const travelerCountValue = travelerCount(booking.travelers);
        const offer = await client.specialOffer.findUnique({
          where: { id: booking.appliedOfferId },
          select: { capacityType: true, maxSpots: true, spotsSold: true },
        });

        if (offer?.capacityType === 'CAPPED') {
          // Atomic capacity guard: consume the spots only if they are actually
          // available. A plain read-then-increment can oversell when two
          // payments for the same capped offer confirm concurrently.
          const consumed = await client.$executeRaw`
            UPDATE "SpecialOffer"
            SET "spotsSold" = "spotsSold" + ${travelerCountValue}
            WHERE id = ${booking.appliedOfferId}
              AND "spotsSold" + ${travelerCountValue} <= "maxSpots"
          `;

          if (consumed === 0) {
            // The offer sold out between checkout and payment. Revoke the
            // booking and refund so the customer never pays for a discount
            // that no longer exists (refund is issued after commit).
            await client.booking.update({
              where: { id: booking.id },
              data: {
                status: 'CANCELLED',
                paymentStatus: 'FAILED',
                paidAt: null,
                cancellationReason: 'Offer capacity was exhausted before payment could be confirmed',
                cancelledAt: new Date(),
              },
            });
            oversoldBookings.push(booking);
            bookings = bookings.filter((b) => b.id !== booking.id);
            continue;
          }
        } else {
          await client.specialOffer.update({
            where: { id: booking.appliedOfferId },
            data: { spotsSold: { increment: travelerCountValue } },
          });
        }
      }

      // Finance v2: no per-booking Payout rows are created here anymore.
      // Bookings start with payoutStatus PENDING; the earnings-eligibility
      // sweep flips them to ELIGIBLE after travel date, and immutable ledger
      // Payout rows are only written when a supplier payout request completes.
    }
  };

  if (tx) {
    await dbWork(tx);
  } else {
    await prisma.$transaction(dbWork);
  }

  return { bookings: bookings || [], oversold: oversoldBookings };
}

/**
 * Handle failed payment
 *
 * @param {object} paymentIntent - Stripe PaymentIntent object
 * @param {object} [tx] - Optional Prisma transaction client
 */
async function handlePaymentFailed(paymentIntent, tx = null) {
  const bookingIds = paymentIntent.metadata.bookingIds?.split(',') || [];
  const client = tx || prisma;

  if (bookingIds.length > 0) {
    await client.booking.updateMany({
      where: {
        id: { in: bookingIds },
        stripePaymentIntentId: paymentIntent.id,
        paymentStatus: { in: ['PENDING', 'PROCESSING'] },
        OR: [{ status: 'PENDING' }, { paymentTiming: 'later' }]
      },
      data: {
        status: 'CANCELLED',
        paymentStatus: 'FAILED',
        cancellationReason: 'Payment failed',
        cancelledAt: new Date()
      }
    });

    console.log(` Marked ${bookingIds.length} bookings as CANCELLED due to payment failure`);
    return { success: true, message: `${bookingIds.length} bookings cancelled` };
  }

  // Fallback: find expedition booking by stripePaymentIntentId
  const updated = await client.booking.updateMany({
    where: {
      stripePaymentIntentId: paymentIntent.id,
      paymentStatus: { in: ['PENDING', 'PROCESSING'] },
      OR: [{ status: 'PENDING' }, { paymentTiming: 'later' }]
    },
    data: {
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancellationReason: 'Payment failed',
      cancelledAt: new Date()
    }
  });

  if (updated.count > 0) {
    console.log(` Marked ${updated.count} expedition bookings as CANCELLED due to payment failure`);
  }

  return { success: true, message: `${updated.count} bookings cancelled` };
}

/**
 * Verify Stripe webhook signature
 */
function verifyWebhookSignature(payload, signature, endpointSecret) {
  try {
    return getStripe().webhooks.constructEvent(payload, signature, endpointSecret);
  } catch (error) {
    console.error(' Webhook signature verification failed:', error.message);
    throw new Error('Invalid webhook signature');
  }
}

module.exports = {
  getStripe,
  createPaymentIntent,
  createStripeCustomer,
  ensureStripeCustomer,
  createCheckoutSession,
  resolveSessionBookingIds,
  createRefund,
  cancelPaymentIntent,
  calculateCommission,
  processStripeWebhook,
  handlePaymentSucceeded,
  handlePaymentFailed,
  verifyWebhookSignature,
};