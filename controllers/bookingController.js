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
const { createPaymentIntent, createRefund, calculateCommission, getStripe, ensureStripeCustomer } = require('../utils/stripeHelpers');
const { generateBookingNumber, validateTravelerInfo, evaluateCancellationPolicy } = require('../utils/bookingHelpers');
const { checkTourAvailability, calculateTourPrice } = require('../utils/tourHelpers');
const { Prisma } = require('@prisma/client');
const { evaluateBookingAvailability, resolveSlotCutoffHours, cutoffLabel, getTourTimezone, zonedDateKey, zonedTimeToUtc, toDateKey, travelerCount, parseBlob } = require('../utils/availabilityCore');
const { enqueueNotification, enqueueEmail, enqueueEvent } = require('../utils/queue');
const { resolvePickupSelection } = require('../utils/geoUtils');
const getConfig = require('../utils/getConfig');
const { detachBookingFromActiveRequests } = require('../utils/financeHelpers');
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
    travelDate,
    selectedTime,
    travelers,
    promoCode
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
  const availability = await checkTourAvailability(tourId, travelDate, { selectedTime, travelers });
  if (!availability.available) {
    return next(new AppError(availability.reason || 'Tour is not available on the selected date', 400));
  }

  // Calculate pricing based on tour's pricing model (includes special offers)
  const pricingCalculation = await calculateTourPrice(tour, travelers, travelDate, selectedTime || null, null, customerId, promoCode || null)
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
        travelDate: new Date(travelDate),
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
      travelDate: new Date(travelDate),
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
    travelDate,
    selectedTime,
    travelers,
    specialRequests,
    paymentMethodId,
    useCart = false,
    promoCode,
    pickup,
    paymentTiming = 'now',
  } = req.body;

  if (paymentTiming !== 'now' && paymentTiming !== 'later') {
    return next(new AppError("paymentTiming must be 'now' or 'later'", 400));
  }

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
        item.travelDate.toISOString().split('T')[0],
        { selectedTime: item.selectedTime || null, travelers: item.travelers }
      );
      if (!availability.available) {
        return next(new AppError(
          `"${item.tour.title}" is no longer available on ${item.travelDate.toISOString().split('T')[0]}${item.selectedTime ? ` at ${item.selectedTime}` : ''} (${availability.reason || 'no availability'})`,
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
        item.travelDate.toISOString().split('T')[0],
        item.selectedTime || null,
        null,
        customerId,
        promoCode || null
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
        travelDate: item.travelDate,
        selectedTime: item.selectedTime,
        travelers: item.travelers,
        subtotal: pricing.subtotal,
        total: pricing.total,
        currency: pricing.currency,
        discounts: pricing.discount || 0,
        appliedOfferId: pricing.appliedOffer?.id || item.appliedOfferId || null,
        offerName: pricing.appliedOffer?.name || null,
        offerPromoCode: pricing.appliedOffer?.promoCode || null,
        offerDiscountType: pricing.appliedOffer?.discountType || null,
        offerDiscountPct: pricing.appliedOffer?.discountPercentage || null,
        offerDiscountFix: pricing.appliedOffer?.fixedDiscountValue || null,
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

    const pricingCalculation = await calculateTourPrice(tour, travelers, travelDate, selectedTime || null, null, customerId, promoCode || null)
      .catch(() => ({ success: false, error: 'Unable to calculate pricing' }));
    
    if (!pricingCalculation.success) {
      return next(new AppError(pricingCalculation.error, 400));
    }

    const discount = pricingCalculation.discount || 0;
    const appliedOffer = pricingCalculation.appliedOffer || null;

    // Check availability for the selected date (+ slot), enforcing capacity for this party
    const availability = await checkTourAvailability(tourId, travelDate, { selectedTime, travelers });
    if (!availability.available) {
      return next(new AppError(availability.reason || 'Tour is not available on the selected date', 400));
    }

    bookingItems = [{
      tourId: tour.id,
      tour,
      travelDate: new Date(travelDate),
      selectedTime: selectedTime || null,
      travelers,
      subtotal: pricingCalculation.subtotal,
      total: pricingCalculation.total,
      currency: pricingCalculation.currency,
      discounts: discount,
      appliedOfferId: appliedOffer?.id || null,
      offerName: appliedOffer?.name || null,
      offerPromoCode: appliedOffer?.promoCode || null,
      offerDiscountType: appliedOffer?.discountType || null,
      offerDiscountPct: appliedOffer?.discountPercentage || null,
      offerDiscountFix: appliedOffer?.fixedDiscountValue || null,
    }];
  }

  // Validate pickup selection (direct bookings only — cart items cannot carry
  // a per-item pickup selection). The snapshot is re-validated against the
  // tour's current pickup config so a stale/garbage payload can never be
  // charged.
  let pickupSnapshot = null;
  if (pickup) {
    if (useCart) {
      return next(new AppError('Pickup selection is only supported for direct bookings', 400));
    }
    const pickupConfig = parseBlob(bookingItems[0]?.tour?.bookingAndTickets) || {};
    const pickupResult = resolvePickupSelection(pickup, pickupConfig);
    if (!pickupResult.ok) {
      return next(new AppError(pickupResult.error, 400));
    }
    pickupSnapshot = pickupResult.pickup;
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

    const dateAt = new Date(item.travelDate);
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

    const totalTravelers = travelerCount(item.travelers);
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
  // A client-supplied idempotency key wins; otherwise createPaymentIntent
  // derives one from the final request body (unique per distinct charge, so a
  // retry that gained a Stripe customer can never collide with the earlier
  // customer-less request).
  const idempotencyKey = req.headers['idempotency-key'];
  // Attach a Stripe customer if one exists or can be created lazily; `null`
  // means "charge without a customer" (PaymentIntents don't require one).
  const stripeCustomerId = await ensureStripeCustomer(req.user);
  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amount: Math.round(totalAmount * 100),
      currency: bookingItems[0].currency,
      customerId: stripeCustomerId,
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
      const dateKey = item.travelDate instanceof Date
        ? item.travelDate.toISOString().split('T')[0]
        : String(item.travelDate).slice(0, 10);
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
          travelDate: item.travelDate,
          selectedTime: item.selectedTime,
          travelers: item.travelers,
          subtotal: item.subtotal,
          grossAmount: item.total,
          discounts: item.discounts || 0,
          currency: item.currency,
          commissionRate: commission.rate,
          platformCommission: commission.amount,
          supplierPayout: commission.supplierPayout,
          specialRequests,
          ...(pickupSnapshot && { pickup: pickupSnapshot }),
          stripePaymentIntentId: paymentIntent.id,
          paymentStatus: 'PROCESSING',
          paymentTiming,
          ...(item.appliedOfferId && { appliedOfferId: item.appliedOfferId }),
          offerName: item.offerName || null,
          offerPromoCode: item.offerPromoCode || null,
          offerDiscountType: item.offerDiscountType || null,
          offerDiscountPct: item.offerDiscountPct || null,
          offerDiscountFix: item.offerDiscountFix || null,
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

  // Update Stripe PaymentIntent metadata with real booking IDs (fire-and-forget).
  // Wrapped defensively so a missing/failing getStripe() (e.g. the helper not
  // being available in some runtime contexts) never fails the booking request.
  try {
    getStripe().paymentIntents.update(paymentIntent.id, {
      metadata: {
        customerId,
        bookingIds: result.bookings.map(b => b.id).join(',')
      }
    }).catch(err => {
      console.error(` Failed to update PaymentIntent metadata for ${paymentIntent.id}:`, err.message);
    });
  } catch (err) {
    console.error(` Failed to update PaymentIntent metadata for ${paymentIntent.id}:`, err.message);
  }

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
        total: parseFloat(booking.grossAmount),
        currency: booking.currency,
        supplierPayout: parseFloat(booking.supplierPayout),
        commissionAmount: parseFloat(booking.platformCommission),
        travelerCount: travelerCount(booking.travelers),
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
        total: parseFloat(booking.grossAmount),
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
        clientSecret: result.paymentIntent.client_secret,
        status: result.paymentIntent.status
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
    travelDate: booking.travelDate,
    selectedTime: booking.selectedTime,
    travelers: booking.travelers,
    total: booking.grossAmount,
    currency: booking.currency,
    subtotal: booking.subtotal,
    taxes: booking.taxes,
    meetingPoint: ticketData.meetingPoint || null,
    pickup: booking.pickup || null,
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
 * GET /bookings/:id/cancellation-quote
 * Read-only preview of what cancelling now would mean for this booking:
 * policy outcome, refund amount, and a customer-facing message. Lets the
 * storefront show exact terms BEFORE the customer commits to cancelling.
 */
exports.getCancellationQuote = catchAsync(async (req, res, next) => {
  const booking = await prisma.booking.findFirst({
    where: { id: req.params.id, customerId: req.user.id },
    include: { tour: { select: { title: true, bookingAndTickets: { select: { cancellationPolicy: true } } } } },
  });
  if (!booking) return next(new AppError('Booking not found', 404));

  const cancellableStatuses = ['PENDING', 'CONFIRMED'];
  if (!cancellableStatuses.includes(booking.status)) {
    return res.status(200).json({
      status: 'success',
      data: {
        quote: {
          canCancel: false,
          allowed: false,
          refundAmount: 0,
          refundPercentage: 0,
          reason: `This booking is ${booking.status.toLowerCase()} and can no longer be cancelled`,
          windowHours: null,
        },
      },
    });
  }

  if (booking.payoutStatus === 'PAID') {
    return res.status(200).json({
      status: 'success',
      data: {
        quote: {
          canCancel: false,
          allowed: false,
          refundAmount: 0,
          refundPercentage: 0,
          reason: 'This booking has already been settled — contact support to request a refund',
          windowHours: null,
        },
      },
    });
  }

  const check = evaluateCancellationPolicy(booking, booking.tour);

  res.status(200).json({
    status: 'success',
    data: {
      quote: {
        canCancel: check.allowed,
        allowed: check.allowed,
        refundAmount: check.refundAmount,
        refundPercentage: check.refundPercentage,
        reason: check.reason,
        windowHours: check.windowHours,
      },
    },
  });
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

  // Settled bookings have left the platform's hands — refunds go through
  // support, not self-service.
  if (booking.payoutStatus === 'PAID') {
    return next(new AppError('This booking has already been settled — contact support to request a refund', 400));
  }

  // Check cancellation policy
  const cancellationCheck = evaluateCancellationPolicy(booking, booking.tour);
  if (!cancellationCheck.allowed) {
    return next(new AppError(cancellationCheck.reason, 400));
  }

  const needsRefund = booking.paymentStatus === 'SUCCEEDED' && cancellationCheck.refundAmount > 0;

  // Process cancellation in transaction — Stripe refund happens AFTER commit
  // so a slow/failing Stripe call doesn't hold the DB connection open.
  const result = await prisma.$transaction(async (tx) => {
    // Update booking status
    const updatedBooking = await tx.booking.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancellationReason: reason,
        cancelledAt: new Date(),
        payoutStatus: 'CANCELLED'
      }
    });

    // Close any payout that was queued when the payment succeeded.
    if (needsRefund) {
      await tx.payout.updateMany({
        where: { bookingId: id, status: 'PENDING' },
        data: { status: 'CANCELLED', processedAt: new Date() },
      });
    }

    // Finance v2: detach from any active payout request so the supplier's
    // pending request total no longer includes this booking.
    await detachBookingFromActiveRequests(tx, id);

    // Decrement spotsSold for applied special offer (one per traveler — the
    // same count that was incremented at confirmation time)
    if (booking.appliedOfferId) {
      const travelerCountValue = travelerCount(booking.travelers);
      await tx.specialOffer.update({
        where: { id: booking.appliedOfferId },
        data: { spotsSold: { decrement: travelerCountValue } },
      });
    }

    return updatedBooking;
  });

  // Attempt Stripe refund OUTSIDE the transaction. Only mark REFUNDED on success.
  let refundSucceeded = false;
  if (needsRefund) {
    try {
      const refundAmountCents = Math.round(parseFloat(cancellationCheck.refundAmount) * 100);
      await createRefund(booking.stripePaymentIntentId, refundAmountCents);
      refundSucceeded = true;
      await prisma.booking.update({
        where: { id },
        data: {
          paymentStatus: 'REFUNDED',
          refundAmount: cancellationCheck.refundAmount,
          refundedAt: new Date()
        }
      });
    } catch (refundErr) {
      console.error(` Stripe refund failed for booking ${id}:`, refundErr.message);
      // Booking is already CANCELLED but paymentStatus stays SUCCEEDED so
      // the refund can be retried manually from the admin dashboard.
    }
  }

  // Send cancellation email + notifications through the queue
  enqueueEmail({ type: 'booking-cancellation', bookingId: booking.id, refundAmount: refundSucceeded ? cancellationCheck.refundAmount : 0 }).catch((err) => console.error('[Email] Booking cancellation email failed:', err.message));

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
    metadata: { reason, refundAmount: refundSucceeded ? cancellationCheck.refundAmount : 0, refundSucceeded }
  }).catch((err) => logger.warn('[booking] logActivity failed:', err?.message));

  enqueueEvent({
    name: 'booking.cancelled',
    userId: customerId,
    req,
    resource: 'Booking',
    resourceId: booking.id,
    properties: { reason, refundAmount: cancellationCheck.refundAmount, tourId: booking.tourId, total: parseFloat(booking.grossAmount) },
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

  const [bookings, totalCount, aggregates] = await Promise.all([
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
            photos: true,
            bookingAndTickets: true,
          }
        },
        appliedOffer: {
          select: {
            id: true,
            name: true,
            offerType: true,
            discountType: true,
            discountPercentage: true,
            fixedDiscountValue: true,
            promoCode: true,
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.booking.count({ where }),
    prisma.booking.aggregate({
      where,
      _sum: { grossAmount: true, supplierPayout: true, platformCommission: true },
    }),
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      bookings,
      summary: {
        totalRevenue: Number(aggregates._sum.grossAmount || 0),
        totalSupplierPayout: Number(aggregates._sum.supplierPayout || 0),
        totalCommission: Number(aggregates._sum.platformCommission || 0),
      },
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
 * Get supplier's upcoming bookings that carry a pickup selection
 * (GetYourGuide-style pickup planner).
 */
exports.getPickupPlanner = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const { from, to, status, page = 1, limit = 50, tourId } = req.query;

  // Verify supplier status
  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: supplierId }
  });
  if (!supplierProfile || supplierProfile.status !== 'ACTIVE') {
    return next(new AppError('Access denied', 403));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fromDate = from ? new Date(from) : today;
  const toDate = to
    ? new Date(to)
    : new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    return next(new AppError('Invalid date range', 400));
  }

  const where = {
    tour: { supplierId },
    // Only bookings with a stored pickup snapshot (JSON column is DB NULL otherwise).
    pickup: { not: Prisma.DbNull },
    travelDate: { gte: fromDate, lte: toDate },
    ...(status ? { status } : {}),
    ...(tourId ? { tourId } : {}),
  };

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
      orderBy: [{ travelDate: 'asc' }, { selectedTime: 'asc' }],
      skip,
      take: parseInt(limit)
    }),
    prisma.booking.count({ where })
  ]);

  // Flag bookings where the customer deferred pickup selection so the
  // supplier dashboard can display a clear "pending" indicator instead
  // of blank pickup fields.
  const enriched = bookings.map((b) => {
    const p = b.pickup && typeof b.pickup === 'object' ? b.pickup : null;
    if (p && p.pickupLater) {
      return { ...b, pickupDeferred: true };
    }
    return b;
  });

  res.status(200).json({
    status: 'success',
    data: {
      bookings: enriched,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        totalCount,
        limit: parseInt(limit)
      }
    }
  });
});

/**
 * Update a booking's pickup details (suppliers only) and notify the customer.
 */
exports.updateBookingPickup = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const { id } = req.params;
  const { pickupTime, pickupPlace, instructions, locationName, areaName, lat, lng } = req.body;

  const booking = await prisma.booking.findFirst({
    where: { id, tour: { supplierId } },
    include: { customer: { select: { id: true, name: true, email: true } } }
  });

  if (!booking) {
    return next(new AppError('Booking not found or access denied', 404));
  }

  const current = typeof booking.pickup === 'string'
    ? (() => { try { return JSON.parse(booking.pickup); } catch { return null; } })()
    : booking.pickup || {};

  const updatedPickup = {
    ...current,
    ...(pickupTime !== undefined ? { time: String(pickupTime) } : {}),
    ...(pickupPlace !== undefined ? { place: String(pickupPlace) } : {}),
    ...(instructions !== undefined ? { instructions: String(instructions) } : {}),
    ...(locationName !== undefined ? { locationName: String(locationName) } : {}),
    ...(areaName !== undefined ? { areaName: String(areaName) } : {}),
    ...(lat !== undefined ? { lat: lat !== null ? Number(lat) : null } : {}),
    ...(lng !== undefined ? { lng: lng !== null ? Number(lng) : null } : {}),
    updatedBy: req.user.id,
    updatedAt: new Date().toISOString(),
  };

  const updatedBooking = await prisma.booking.update({
    where: { id },
    data: { pickup: updatedPickup }
  });

  // Notify the customer (in-app + email).
  enqueueNotification({
    userId: booking.customerId,
    type: 'BOOKING_STATUS_UPDATED',
    title: 'Pickup details updated',
    message: 'Your pickup details have been updated by the supplier. Please check your booking.',
    data: { bookingId: booking.id, pickup: true }
  }).catch((err) => console.error('[Notification] enqueueNotification (pickup update) failed:', err.message));

  enqueueEmail({ type: 'pickup-details-updated', bookingId: booking.id })
    .catch((err) => console.error('[Email] pickup-details-updated failed:', err.message));

  logActivity({
    userId: supplierId,
    action: 'booking.pickup_updated',
    resource: 'Booking',
    resourceId: id,
    metadata: { hadPickup: !!booking.pickup }
  }).catch((err) => logger.warn('[booking] logActivity failed:', err?.message));

  res.status(200).json({
    status: 'success',
    data: { booking: updatedBooking }
  });
});

/**
 * Update booking status (suppliers only)
 */
exports.updateBookingStatus = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { status, supplierNotes, reason } = req.body;
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

  // ── Guard: reject PENDING→CONFIRMED when activity date has passed ──
  if (booking.status === 'PENDING' && status === 'CONFIRMED') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(booking.travelDate) < today) {
      return next(new AppError('Cannot confirm a booking with a past activity date. Cancel this booking instead.', 400));
    }
  }

  // ── Supplier-initiated cancellation ──
  if (status === 'CANCELLED') {
    const result = await prisma.$transaction(async (tx) => {
      const updateData = {
        status: 'CANCELLED',
        cancellationReason: reason || null,
        cancelledAt: new Date(),
        payoutStatus: 'CANCELLED',
        supplierNotes,
        updatedAt: new Date(),
      };

      // Process refund if payment was successful
      let refundAmount = 0;
      if (booking.paymentStatus === 'SUCCEEDED') {
        const cancellationCheck = evaluateCancellationPolicy(booking, booking.tour);
        refundAmount = cancellationCheck.refundAmount;

        if (refundAmount > 0) {
          try {
            const refundAmountCents = Math.round(refundAmount * 100);
            await createRefund(booking.stripePaymentIntentId, refundAmountCents);
          } catch (refundErr) {
            console.error(`[Booking] Stripe refund failed for booking ${id}:`, refundErr.message);
          }

          updateData.paymentStatus = 'REFUNDED';
          updateData.refundAmount = refundAmount;
          updateData.refundedAt = new Date();

          // Cancel pending payout rows
          await tx.payout.updateMany({
            where: { bookingId: id, status: 'PENDING' },
            data: { status: 'CANCELLED', processedAt: new Date() },
          });
        }
      }

      const updatedBooking = await tx.booking.update({
        where: { id },
        data: updateData,
      });

      // Finance v2: detach from any active payout request
      await detachBookingFromActiveRequests(tx, id);

      // Decrement spotsSold for applied special offer
      if (booking.appliedOfferId) {
        const travelerCountValue = travelerCount(booking.travelers);
        await tx.specialOffer.update({
          where: { id: booking.appliedOfferId },
          data: { spotsSold: { decrement: travelerCountValue } },
        });
      }

      return { updatedBooking, refundAmount };
    });

    // Send supplier-cancelled-booking email to customer (fire-and-forget)
    enqueueEmail({
      type: 'supplier-cancelled-booking',
      bookingId: booking.id,
      reason,
      refundAmount: result.refundAmount,
    }).catch((err) => console.error('[Email] supplier-cancelled-booking failed:', err.message));

    // Notify customer in-app
    enqueueNotification({
      userId: booking.customerId,
      type: 'BOOKING_CANCELLED',
      title: 'Booking Cancelled',
      message: `Your booking "${booking.tour.title}" has been cancelled by the supplier`,
      data: { bookingId: booking.id }
    }).catch((err) => console.error('[Notification] enqueueNotification (supplier cancel) failed:', err.message));

    // Log activity
    logActivity({
      userId: supplierId,
      action: 'booking.cancelled',
      resource: 'Booking',
      resourceId: booking.id,
      metadata: { reason, refundAmount: result.refundAmount }
    }).catch((err) => logger.warn('[booking] logActivity failed:', err?.message));

    enqueueEvent({
      name: 'booking.cancelled',
      userId: supplierId,
      req,
      resource: 'Booking',
      resourceId: booking.id,
      properties: { reason, refundAmount: result.refundAmount, tourId: booking.tourId },
    });

    return res.status(200).json({
      status: 'success',
      data: { booking: result.updatedBooking }
    });
  }

  // ── Non-cancellation status transitions ──
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

  // Manual-confirmation flow: when a supplier accepts a previously-awaiting
  // (paid PENDING) booking, the customer receives the confirmation email.
  if (status === 'CONFIRMED' && booking.status === 'PENDING' && booking.paymentStatus === 'SUCCEEDED') {
    enqueueEmail({ type: 'booking-confirmed', bookingId: booking.id })
      .catch((err) => console.error('[Email] booking-confirmed (manual accept) failed:', err.message));
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

