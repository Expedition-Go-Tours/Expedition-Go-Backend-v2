/**
 * Booking Controller - Production Ready
 * Handles tour bookings, payments, and booking management
 * 
 * Features:
 * - Tour booking with Stripe integration
 * - Cart functionality
 * - Booking management and cancellations
 * - Commission calculations
 * - Real-time notifications via WebSocket
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { createPaymentIntent, createRefund, calculateCommission } = require('../utils/stripeHelpers');
const { generateBookingNumber, validateTravelerInfo, evaluateCancellationPolicy } = require('../utils/bookingHelpers');
const { checkTourAvailability, calculateTourPrice } = require('../utils/tourHelpers');
const { evaluateBookingAvailability, resolveSlotCutoffHours, cutoffLabel, getTourTimezone, zonedDateKey, zonedTimeToUtc, toDateKey } = require('../utils/availabilityCore');
const { enqueueNotification, enqueueEmail, enqueueEvent } = require('../utils/queue');
const getConfig = require('../utils/getConfig');
const { generatePrintableTicketHtml } = require('../utils/emailService');
const { logActivity } = require('../utils/auditLogger');
const logger = require('../utils/logger');

// ================================
// CART MANAGEMENT
// ================================

/**
 * Add tour to cart
 */
exports.addToCart = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const {
    tourId,
    selectedDate,
    selectedTime,
    travelers
  } = req.body;

  // Validate tour exists and is bookable
  const tour = await prisma.tour.findFirst({
    where: {
      id: tourId,
      status: 'ACTIVE',
      supplier: {
        supplierProfile: {
          status: 'ACTIVE'
        }
      }
    },
    include: {
      schedulesAndPricing: true
    }
  });

  if (!tour) {
    return next(new AppError('Tour not found or not available for booking', 404));
  }

  // Fail fast: the date (+ slot) must be bookable and have room for this party
  // before it can ever sit in the cart.
  const availability = await checkTourAvailability(tourId, selectedDate, { selectedTime, travelers });
  if (!availability.available) {
    return next(new AppError(availability.reason || 'Tour is not available on the selected date', 400));
  }

  // Calculate pricing based on tour's pricing model (includes special offers)
  const pricingCalculation = await calculateTourPrice(tour, travelers, selectedDate, selectedTime || null, null, customerId)
    .catch(() => ({ success: false, error: 'Unable to calculate pricing' }));
  
  if (!pricingCalculation.success) {
    return next(new AppError(pricingCalculation.error, 400));
  }

  const discount = pricingCalculation.discount || 0;
  const appliedOffer = pricingCalculation.appliedOffer || null;

  // Set cart expiration (2 hours from now)
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const normalizedTime = selectedTime || '';

  // Create or update cart item
  const cartItem = await prisma.cartItem.upsert({
    where: {
      customerId_tourId_selectedDate_selectedTime: {
        customerId,
        tourId,
        selectedDate: new Date(selectedDate),
        selectedTime: normalizedTime
      }
    },
    update: {
      travelers,
      subtotal: pricingCalculation.subtotal,
      total: pricingCalculation.total,
      discounts: discount,
      appliedOfferId: appliedOffer?.id || null,
      expiresAt
    },
    create: {
      customerId,
      tourId,
      selectedDate: new Date(selectedDate),
      selectedTime: normalizedTime,
      travelers,
      subtotal: pricingCalculation.subtotal,
      total: pricingCalculation.total,
      currency: pricingCalculation.currency,
      discounts: discount,
      appliedOfferId: appliedOffer?.id || null,
      expiresAt
    },
    include: {
      tour: {
        select: {
          id: true,
          title: true,
          photos: true,
          supplier: {
            select: {
              name: true
            }
          }
        }
      }
    }
  });

  res.status(201).json({
    status: 'success',
    data: { cartItem }
  });

  enqueueEvent({ name: 'cart.added', userId: customerId, req, resource: 'Tour', resourceId: tourId, properties: { total: pricingCalculation.total, currency: pricingCalculation.currency, travelers } });
});

/**
 * Get user's cart
 */
exports.getCart = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;

  // Remove expired items first
  await prisma.cartItem.deleteMany({
    where: {
      customerId,
      expiresAt: {
        lt: new Date()
      }
    }
  });

  // Get current cart items
  const cartItems = await prisma.cartItem.findMany({
    where: { customerId },
    include: {
      tour: {
        select: {
          id: true,
          title: true,
          photos: true,
          supplier: {
            select: {
              name: true
            }
          }
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  // Calculate cart totals
  const cartTotal = cartItems.reduce((sum, item) => sum + parseFloat(item.total), 0);
  const itemCount = cartItems.length;

  res.status(200).json({
    status: 'success',
    data: {
      cartItems,
      summary: {
        itemCount,
        cartTotal,
        currency: cartItems[0]?.currency || 'USD'
      }
    }
  });
});

/**
 * Remove item from cart
 */
exports.removeFromCart = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const customerId = req.user.id;

  const deletedItem = await prisma.cartItem.deleteMany({
    where: {
      id,
      customerId
    }
  });

  if (deletedItem.count === 0) {
    return next(new AppError('Cart item not found', 404));
  }

  enqueueEvent({ name: 'cart.removed', userId: customerId, req, resource: 'CartItem', resourceId: id });

  res.status(204).json({
    status: 'success',
    data: null
  });
});

/**
 * Clear entire cart
 */
exports.clearCart = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;

  await prisma.cartItem.deleteMany({
    where: { customerId }
  });

  enqueueEvent({ name: 'cart.cleared', userId: customerId, req, resource: 'Cart' });

  res.status(204).json({
    status: 'success',
    data: null
  });
});

// ================================
// BOOKING PROCESS
// ================================

/**
 * Create booking from cart or direct booking
 */
exports.createBooking = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const {
    tourId,
    selectedDate,
    selectedTime,
    travelers,
    specialRequests,
    paymentMethodId,
    useCart = false
  } = req.body;

  // Validate traveler contact info
  const travelerValidation = validateTravelerInfo(travelers);
  if (!travelerValidation.isValid) {
    return next(new AppError(`Traveler information: ${travelerValidation.errors.join(', ')}`, 400));
  }

  let bookingItems = [];

  if (useCart) {
    // Book all items in cart
    const cartItems = await prisma.cartItem.findMany({
      where: {
        customerId,
        expiresAt: { gt: new Date() }
      },
      include: {
        tour: {
          include: {
            supplier: {
              include: {
                supplierProfile: true
              }
            }
          }
        }
      }
    });

    if (cartItems.length === 0) {
      return next(new AppError('Cart is empty or expired', 400));
    }

    // Recheck availability for each cart item
    for (const item of cartItems) {
      const availability = await checkTourAvailability(
        item.tourId,
        item.selectedDate.toISOString().split('T')[0],
        { selectedTime: item.selectedTime || null, travelers: item.travelers }
      );
      if (!availability.available) {
        return next(new AppError(
          `"${item.tour.title}" is no longer available on ${item.selectedDate.toISOString().split('T')[0]}${item.selectedTime ? ` at ${item.selectedTime}` : ''} (${availability.reason || 'no availability'})`,
          400
        ));
      }
    }

    // Recompute pricing server-side for every cart item. The cart `total` is a
    // snapshot taken at add-to-cart time; the amount a customer actually pays
    // must reflect the tour's current pricing at checkout, so a price change
    // after the item was added is honored and a stale/garbage snapshot can
    // never be charged.
    const recomputedItems = [];
    for (const item of cartItems) {
      const pricing = await calculateTourPrice(
        item.tour,
        item.travelers,
        item.selectedDate.toISOString().split('T')[0],
        item.selectedTime || null,
        null,
        customerId
      ).catch(() => ({ success: false, error: 'Unable to calculate pricing' }));

      if (!pricing.success) {
        return next(new AppError(`"${item.tour.title}": ${pricing.error}`, 400));
      }
      if (!Number.isFinite(pricing.subtotal) || !Number.isFinite(pricing.total) || pricing.total <= 0) {
        return next(new AppError(`"${item.tour.title}" has invalid pricing`, 400));
      }

      recomputedItems.push({
        tourId: item.tourId,
        tour: item.tour,
        selectedDate: item.selectedDate,
        selectedTime: item.selectedTime,
        travelers: item.travelers,
        subtotal: pricing.subtotal,
        total: pricing.total,
        currency: pricing.currency,
        discounts: pricing.discount || 0,
        appliedOfferId: pricing.appliedOffer?.id || item.appliedOfferId || null
      });
    }
    bookingItems = recomputedItems;
  } else {
    // Direct booking
    const tour = await prisma.tour.findFirst({
      where: {
        id: tourId,
        status: 'ACTIVE'
      },
      include: {
        supplier: {
          include: {
            supplierProfile: true
          }
        }
      }
    });

    if (!tour) {
      return next(new AppError('Tour not found or not available', 404));
    }

    const pricingCalculation = await calculateTourPrice(tour, travelers, selectedDate, selectedTime || null, null, customerId)
      .catch(() => ({ success: false, error: 'Unable to calculate pricing' }));
    
    if (!pricingCalculation.success) {
      return next(new AppError(pricingCalculation.error, 400));
    }

    const discount = pricingCalculation.discount || 0;
    const appliedOffer = pricingCalculation.appliedOffer || null;

    // Check availability for the selected date (+ slot), enforcing capacity for this party
    const availability = await checkTourAvailability(tourId, selectedDate, { selectedTime, travelers });
    if (!availability.available) {
      return next(new AppError(availability.reason || 'Tour is not available on the selected date', 400));
    }

    bookingItems = [{
      tourId: tour.id,
      tour,
      selectedDate: new Date(selectedDate),
      selectedTime: selectedTime || null,
      travelers,
      subtotal: pricingCalculation.subtotal,
      total: pricingCalculation.total,
      currency: pricingCalculation.currency,
      discounts: discount,
      appliedOfferId: appliedOffer?.id || null
    }];
  }

  // Validate all suppliers are active
  for (const item of bookingItems) {
    if (item.tour.supplier.supplierProfile.status !== 'ACTIVE') {
      return next(new AppError(`Supplier for tour "${item.tour.title}" is not active`, 400));
    }
  }

  // Validate booking rules from system config (fetched in parallel)
  const [minAdvanceHours, maxAdvanceDays, systemMaxTravelers] = await Promise.all([
    getConfig('booking.min_advance_hours', '24').then(v => parseInt(v)),
    getConfig('booking.max_advance_days', '365').then(v => parseInt(v)),
    getConfig('booking.max_travelers', '50').then(v => parseInt(v)),
  ]);
  const now = new Date();

  for (const item of bookingItems) {
    // Per-tour advance cutoff (bookingAndTickets.minAdvanceBookingHours) wins
    // over the system default. When a slot is booked and the tour uses per-slot
    // cutoffs, the clock starts at the slot time instead of midnight.
    const parsedBt = typeof item.tour.bookingAndTickets === 'string'
      ? (() => { try { return JSON.parse(item.tour.bookingAndTickets); } catch { return null; } })()
      : item.tour.bookingAndTickets;
    const perSlotCutoff = !!parsedBt?.perSlotCutoff;
    // Builder writes cutoffMinutes (minutes); resolveSlotCutoffHours handles
    // per-slot overrides (keyed by slot start time), legacy
    // minAdvanceBookingHours rows and the system default.
    const effectiveCutoff = resolveSlotCutoffHours(parsedBt, item.selectedTime, minAdvanceHours);
    const tourTz = getTourTimezone(parsedBt);

    const dateAt = new Date(item.selectedDate);
    let startAt;
    if (item.selectedTime && perSlotCutoff) {
      // Anchor the cutoff clock to the slot's local wall clock in the tour's
      // timezone (default UTC keeps current behavior).
      const localDate = zonedDateKey(toDateKey(dateAt), tourTz);
      startAt = zonedTimeToUtc(`${localDate} ${item.selectedTime}`, tourTz);
    } else {
      startAt = new Date(Date.UTC(dateAt.getUTCFullYear(), dateAt.getUTCMonth(), dateAt.getUTCDate()));
    }

    const hoursUntilTour = (startAt - now) / (1000 * 60 * 60);
    const daysUntilTour = hoursUntilTour / 24;

    if (hoursUntilTour < effectiveCutoff) {
      return next(new AppError(
        `Bookings must be made at least ${cutoffLabel(effectiveCutoff)} before the tour start time`,
        400
      ));
    }

    if (daysUntilTour > maxAdvanceDays) {
      return next(new AppError(
        `Bookings can only be made up to ${maxAdvanceDays} days in advance`,
        400
      ));
    }

    const totalTravelers = (item.travelers.adults || 0) + (item.travelers.children || 0) + (item.travelers.infants || 0);
    if (totalTravelers > systemMaxTravelers) {
      return next(new AppError(
        `Total travelers (${totalTravelers}) exceeds the maximum of ${systemMaxTravelers} per booking`,
        400
      ));
    }
  }

  // Calculate total amount for Stripe — guard against NaN/zero so a malformed
  // price can never reach the payment provider.
  const totalAmount = bookingItems.reduce((sum, item) => sum + item.total, 0);
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return next(new AppError('Booking total must be greater than 0', 400));
  }

  // Create Stripe PaymentIntent FIRST (outside DB transaction — avoids holding connection open during network I/O)
  const idempotencyKey = req.headers['idempotency-key'] || `booking:${customerId}:${Date.now()}`;
  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amount: Math.round(totalAmount * 100),
      currency: bookingItems[0].currency,
      customerId: req.user.stripeCustomerId,
      paymentMethodId,
      idempotencyKey,
      metadata: {
        customerId,
        bookingIds: 'placeholder'
      }
    });
  } catch (err) {
    return next(new AppError(`Payment failed: ${err.message}`, 400));
  }

  // Create bookings in transaction (short — DB only, no network I/O)
  const result = await prisma.$transaction(async (tx) => {
    // 1. Lock tour rows with FOR UPDATE to prevent race conditions.
    //    Sorted ids keep lock ordering consistent and avoid deadlocks between
    //    multi-tour carts. Every write path (both checkouts + override writes)
    //    takes the tour lock first, which serializes all capacity decisions.
    const sortedTourIds = [...new Set(bookingItems.map((i) => i.tourId))].sort();
    for (const id of sortedTourIds) {
      const [lockedTour] = await tx.$queryRawUnsafe(
        `SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE`,
        id
      );
      if (!lockedTour) {
        throw new Error(`Tour ${id} not found`);
      }
    }

    // 2. Check capacity atomically for each item (shared availability core:
    //    traveler-based sum incl. PENDING, TourDateOverride, closed days,
    //    per-slot capacity and per-group cap).
    for (const item of bookingItems) {
      const dateKey = item.selectedDate instanceof Date
        ? item.selectedDate.toISOString().split('T')[0]
        : String(item.selectedDate).slice(0, 10);
      const evalResult = await evaluateBookingAvailability(tx, item.tour, dateKey, item.selectedTime || null, item.travelers);
      if (!evalResult.ok) {
        throw new Error(evalResult.reason);
      }
    }

    const bookings = [];

    for (const item of bookingItems) {
      const bookingNumber = await generateBookingNumber();
      const commission = await calculateCommission(item.total, item.tour.supplier.supplierProfile);
      
      const booking = await tx.booking.create({
        data: {
          bookingNumber,
          customerId,
          tourId: item.tourId,
          selectedDate: item.selectedDate,
          selectedTime: item.selectedTime,
          travelers: item.travelers,
          subtotal: item.subtotal,
          total: item.total,
          discounts: item.discounts || 0,
          currency: item.currency,
          commissionRate: commission.rate,
          commissionAmount: commission.amount,
          supplierPayout: commission.supplierPayout,
          specialRequests,
          stripePaymentIntentId: paymentIntent.id,
          paymentStatus: 'PROCESSING',
          ...(item.appliedOfferId && { appliedOfferId: item.appliedOfferId }),
          status: 'PENDING'
        },
        include: {
          tour: {
            select: {
              title: true,
              supplier: {
                select: {
                  name: true
                }
              }
            }
          }
        }
      });

      bookings.push(booking);
    }

    // Clear cart if used
    if (useCart) {
      await tx.cartItem.deleteMany({
        where: { customerId }
      });
    }

    return { bookings, paymentIntent };
  }).catch(async (err) => {
    // Transaction failed — refund the PaymentIntent since card was already charged
    try {
      await createRefund(paymentIntent.id);
      console.log(` Auto-refunded PaymentIntent ${paymentIntent.id} after failed booking transaction`);
    } catch (refundErr) {
      console.error(` Failed to auto-refund PaymentIntent ${paymentIntent.id}:`, refundErr.message);
    }
    throw err; // Re-throw so catchAsync handles it
  });

  // Update Stripe PaymentIntent metadata with real booking IDs (fire-and-forget)
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  stripe.paymentIntents.update(paymentIntent.id, {
    metadata: {
      customerId,
      bookingIds: result.bookings.map(b => b.id).join(',')
    }
  }).catch(err => {
    console.error(` Failed to update PaymentIntent metadata for ${paymentIntent.id}:`, err.message);
  });

  // Send notifications through the queue (async)
  for (const booking of result.bookings) {
    enqueueNotification({
      userId: booking.tour.supplier.id,
      type: 'BOOKING_CONFIRMED',
      title: 'New Booking Received',
      message: `You have a new booking for "${booking.tour.title}"`,
      data: { bookingId: booking.id }
    }).catch((err) => console.error('[Notification] enqueueNotification (booking supplier) failed:', err.message));
  }

  // Emit analytics events for every created booking (via queue)
  for (const booking of result.bookings) {
    enqueueEvent({
      name: 'booking.initiated',
      userId: customerId,
      req,
      resource: 'Booking',
      resourceId: booking.id,
      properties: {
        tourId: booking.tourId,
        tourTitle: booking.tour.title,
        total: parseFloat(booking.total),
        currency: booking.currency,
        supplierPayout: parseFloat(booking.supplierPayout),
        commissionAmount: parseFloat(booking.commissionAmount),
        travelerCount: (booking.travelers?.adults || 0) + (booking.travelers?.children || 0) + (booking.travelers?.infants || 0),
        status: booking.status,
      },
    });

    logActivity({
      userId: customerId,
      action: 'booking.created',
      resource: 'Booking',
      resourceId: booking.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: {
        tourId: booking.tourId,
        tourTitle: booking.tour.title,
        total: parseFloat(booking.total),
        currency: booking.currency,
        status: booking.status,
      },
    });
  }

  res.status(201).json({
    status: 'success',
    data: {
      bookings: result.bookings,
      paymentIntent: {
        id: result.paymentIntent.id,
        clientSecret: result.paymentIntent.client_secret
      }
    }
  });
});

/**
 * Get user's bookings
 */
exports.getMyBookings = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const { status, page = 1, limit = 10 } = req.query;

  const where = { customerId };
  if (status) {
    where.status = status;
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [bookings, totalCount] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        tour: {
          select: {
            id: true,
            title: true,
            photos: true,
            supplier: {
              select: {
                name: true,
                photoURL: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.booking.count({ where })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      bookings,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      }
    }
  });
});

/**
 * Get single booking details
 */
exports.getBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const customerId = req.user.id;

  const booking = await prisma.booking.findFirst({
    where: {
      id,
      customerId
    },
    include: {
      tour: {
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              photoURL: true,
              phone: true,
              email: true
            }
          }
        }
      },
      review: true
    }
  });

  if (!booking) {
    return next(new AppError('Booking not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { booking }
  });
});

/**
 * Get printable ticket HTML page
 */
exports.getBookingTicket = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true, email: true } },
      tour: {
        select: {
          title: true,
          description: true,
          photos: true,
          productContent: true,
          bookingAndTickets: true,
          supplier: { select: { name: true, email: true, phone: true } }
        }
      }
    }
  });

  if (!booking) {
    return next(new AppError('Booking not found', 404));
  }

  const product = booking.tour.productContent || {};
  const ticketData = booking.tour.bookingAndTickets || {};

  const html = generatePrintableTicketHtml({
    bookingNumber: booking.bookingNumber,
    status: booking.status,
    customerName: booking.customer.name,
    tourTitle: booking.tour.title,
    tourDescription: booking.tour.description,
    selectedDate: booking.selectedDate,
    selectedTime: booking.selectedTime,
    travelers: booking.travelers,
    total: booking.total,
    currency: booking.currency,
    subtotal: booking.subtotal,
    taxes: booking.taxes,
    meetingPoint: ticketData.meetingPoint || null,
    checkInProcess: ticketData.checkInProcess || null,
    cancellationPolicy: ticketData.cancellationPolicy || null,
    included: product.included || [],
    whatToBring: product.whatToBring || [],
    highlights: product.highlights || [],
    restrictions: product.restrictions || null,
    supplierName: booking.tour.supplier.name,
    supportEmail: process.env.SUPPORT_EMAIL
  });

  res.type('html').send(html);
});

/**
 * Cancel booking
 */
exports.cancelBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;
  const customerId = req.user.id;

  const booking = await prisma.booking.findFirst({
    where: {
      id,
      customerId,
      status: { in: ['PENDING', 'CONFIRMED'] }
    },
    include: {
      tour: {
        include: {
          supplier: true
        }
      }
    }
  });

  if (!booking) {
    return next(new AppError('Booking not found or cannot be cancelled', 404));
  }

  // Check cancellation policy
  const cancellationCheck = evaluateCancellationPolicy(booking, booking.tour);
  if (!cancellationCheck.allowed) {
    return next(new AppError(cancellationCheck.reason, 400));
  }

  // Process cancellation in transaction
  const result = await prisma.$transaction(async (tx) => {
    // Update booking status
    const updatedBooking = await tx.booking.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancellationReason: reason,
        cancelledAt: new Date()
      }
    });

    // Process refund if payment was successful
    if (booking.paymentStatus === 'SUCCEEDED' && cancellationCheck.refundAmount > 0) {
      // Call Stripe refund API
      try {
        const refundAmountCents = Math.round(parseFloat(cancellationCheck.refundAmount) * 100);
        await createRefund(booking.stripePaymentIntentId, refundAmountCents);
      } catch (refundErr) {
        console.error(` Stripe refund failed for booking ${id}:`, refundErr.message);
        // Continue — booking is cancelled in the DB; refund can be retried manually
      }

      await tx.booking.update({
        where: { id },
        data: {
          paymentStatus: 'REFUNDED',
          refundAmount: cancellationCheck.refundAmount,
          refundedAt: new Date()
        }
      });
    }

    // Decrement spotsSold for applied special offer
    if (booking.appliedOfferId) {
      await tx.specialOffer.update({
        where: { id: booking.appliedOfferId },
        data: { spotsSold: { decrement: 1 } },
      });
    }

    return updatedBooking;
  });

  // Send cancellation email + notifications through the queue
  enqueueEmail({ type: 'booking-cancellation', bookingId: booking.id, refundAmount: cancellationCheck.refundAmount }).catch((err) => console.error('[Email] Booking cancellation email failed:', err.message));

  enqueueNotification({
    userId: booking.tour.supplier.id,
    type: 'BOOKING_CANCELLED',
    title: 'Booking Cancelled',
    message: `Booking for "${booking.tour.title}" has been cancelled`,
    data: { bookingId: booking.id }
  }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

  // Log activity (fire-and-forget)
  logActivity({
    userId: customerId,
    action: 'booking.cancelled',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason, refundAmount: cancellationCheck.refundAmount }
  }).catch((err) => logger.warn('[booking] logActivity failed:', err?.message));

  enqueueEvent({
    name: 'booking.cancelled',
    userId: customerId,
    req,
    resource: 'Booking',
    resourceId: booking.id,
    properties: { reason, refundAmount: cancellationCheck.refundAmount, tourId: booking.tourId, total: parseFloat(booking.total) },
  });

  res.status(200).json({
    status: 'success',
    data: { booking: result }
  });
});

// ================================
// SUPPLIER BOOKING MANAGEMENT
// ================================

/**
 * Get supplier's bookings
 */
exports.getSupplierBookings = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const { status, tourId, customerId, page = 1, limit = 10 } = req.query;

  // Verify supplier status
  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: supplierId }
  });
  if (!supplierProfile || supplierProfile.status !== 'ACTIVE') {
    return next(new AppError('Access denied', 403));
  }

  const where = {
    tour: {
      supplierId
    }
  };

  if (status) where.status = status;
  if (tourId) where.tourId = tourId;
  if (customerId) where.customerId = customerId;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [bookings, totalCount] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photoURL: true
          }
        },
        tour: {
          select: {
            id: true,
            title: true,
            photos: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.booking.count({ where })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      bookings,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      }
    }
  });
});

/**
 * Update booking status (suppliers only)
 */
exports.updateBookingStatus = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { status, supplierNotes } = req.body;
  const supplierId = req.supplierId;

  const booking = await prisma.booking.findFirst({
    where: {
      id,
      tour: {
        supplierId
      }
    },
    include: {
      customer: true,
      tour: true
    }
  });

  if (!booking) {
    return next(new AppError('Booking not found or access denied', 404));
  }

  const VALID_TRANSITIONS = {
    PENDING:   ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
    COMPLETED: [],
    CANCELLED: ['REFUNDED'],
    REFUNDED:  [],
    NO_SHOW:   [],
  };

  const allowed = VALID_TRANSITIONS[booking.status] || [];
  if (!allowed.includes(status)) {
    return next(new AppError(
      `Cannot transition booking from ${booking.status} to ${status}. Allowed: ${allowed.join(', ') || 'none'}`,
      400
    ));
  }

  const updatedBooking = await prisma.booking.update({
    where: { id },
    data: {
      status,
      supplierNotes,
      updatedAt: new Date()
    }
  });

  // Send notification to customer
  const statusMessages = {
    CONFIRMED: 'Your booking has been confirmed',
    COMPLETED: 'Your tour has been completed',
    NO_SHOW: 'Marked as no-show'
  };

  if (statusMessages[status]) {
    enqueueNotification({
      userId: booking.customerId,
      type: 'BOOKING_CONFIRMED',
      title: 'Booking Update',
      message: statusMessages[status],
      data: { bookingId: booking.id }
    }).catch((err) => console.error('[Notification] enqueueNotification (booking update) failed:', err.message));
  }

  // Log activity (fire-and-forget)
  logActivity({
    userId: supplierId,
    action: 'booking.status_updated',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { oldStatus: booking.status, newStatus: status }
  }).catch((err) => logger.warn('[booking] logActivity failed:', err?.message));

  enqueueEvent({
    name: `booking.status_${status.toLowerCase()}`,
    userId: supplierId,
    req,
    resource: 'Booking',
    resourceId: booking.id,
    properties: { oldStatus: booking.status, newStatus: status, tourId: booking.tourId },
  });

  res.status(200).json({
    status: 'success',
    data: { booking: updatedBooking }
  });
});

// ================================
// HELPER FUNCTIONS
// ================================

module.exports = exports;