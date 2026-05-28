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
const { createPaymentIntent, calculateCommission } = require('../utils/stripeHelpers');
const { generateBookingNumber, validateTravelerInfo } = require('../utils/bookingHelpers');
const { enqueueNotification, enqueueEmail } = require('../utils/queue');
const { generatePrintableTicketHtml } = require('../utils/emailService');
const { logActivity } = require('../utils/auditLogger');
const event = require('../utils/eventEmitter');

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

  // Calculate pricing based on tour's pricing model
  const pricingCalculation = calculateTourPricing(tour, travelers, selectedDate, null);
  
  if (!pricingCalculation.success) {
    return next(new AppError(pricingCalculation.error, 400));
  }

  // Set cart expiration (2 hours from now)
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

  // Create or update cart item
  const cartItem = await prisma.cartItem.upsert({
    where: {
      customerId_tourId_selectedDate_selectedTime: {
        customerId,
        tourId,
        selectedDate: new Date(selectedDate),
        selectedTime: ''
      }
    },
    update: {
      travelers,
      subtotal: pricingCalculation.subtotal,
      total: pricingCalculation.total,
      expiresAt
    },
    create: {
      customerId,
      tourId,
      selectedDate: new Date(selectedDate),
      selectedTime: '',
      travelers,
      subtotal: pricingCalculation.subtotal,
      total: pricingCalculation.total,
      currency: pricingCalculation.currency,
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

  event.emit({ name: 'cart.added', userId: customerId, req, resource: 'Tour', resourceId: tourId, properties: { total: pricingCalculation.total, currency: pricingCalculation.currency, travelers } });
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

  event.emit({ name: 'cart.removed', userId: customerId, req, resource: 'CartItem', resourceId: id });

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

  event.emit({ name: 'cart.cleared', userId: customerId, req, resource: 'Cart' });

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

    bookingItems = cartItems.map(item => ({
      tourId: item.tourId,
      tour: item.tour,
      selectedDate: item.selectedDate,
      selectedTime: item.selectedTime,
      travelers: item.travelers,
      subtotal: parseFloat(item.subtotal),
      total: parseFloat(item.total),
      currency: item.currency
    }));
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

    const pricingCalculation = calculateTourPricing(tour, travelers, selectedDate, null);
    
    if (!pricingCalculation.success) {
      return next(new AppError(pricingCalculation.error, 400));
    }

    bookingItems = [{
      tourId: tour.id,
      tour,
      selectedDate: new Date(selectedDate),
      selectedTime: null,
      travelers,
      subtotal: pricingCalculation.subtotal,
      total: pricingCalculation.total,
      currency: pricingCalculation.currency
    }];
  }

  // Validate all suppliers are active
  for (const item of bookingItems) {
    if (item.tour.supplier.supplierProfile.status !== 'ACTIVE') {
      return next(new AppError(`Supplier for tour "${item.tour.title}" is not active`, 400));
    }
  }

  // Create bookings in transaction
  const result = await prisma.$transaction(async (tx) => {
    const bookings = [];
    let totalAmount = 0;

    for (const item of bookingItems) {
      const bookingNumber = await generateBookingNumber();
      const commission = calculateCommission(item.total, item.tour.supplier.supplierProfile);
      
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
          currency: item.currency,
          commissionRate: commission.rate,
          commissionAmount: commission.amount,
          supplierPayout: commission.supplierPayout,
          specialRequests,
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
      totalAmount += item.total;
    }

    // Create Stripe PaymentIntent (platform collects 100%, payouts handled via Payout model)
    const paymentIntent = await createPaymentIntent({
      amount: Math.round(totalAmount * 100),
      currency: bookingItems[0].currency,
      customerId: req.user.stripeCustomerId,
      paymentMethodId,
      metadata: {
        customerId,
        bookingIds: bookings.map(b => b.id).join(',')
      }
    });

    // Update bookings with payment intent ID
    await tx.booking.updateMany({
      where: {
        id: { in: bookings.map(b => b.id) }
      },
      data: {
        stripePaymentIntentId: paymentIntent.id,
        paymentStatus: 'PROCESSING'
      }
    });

    // Clear cart if used
    if (useCart) {
      await tx.cartItem.deleteMany({
        where: { customerId }
      });
    }

    return { bookings, paymentIntent };
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

  // Emit analytics events for every created booking
  for (const booking of result.bookings) {
    event.emit({
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
  const cancellationCheck = checkCancellationPolicy(booking);
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
    if (booking.paymentStatus === 'SUCCEEDED') {
      // Refund logic will be handled by Stripe webhook
      // For now, just mark as refund pending
      await tx.booking.update({
        where: { id },
        data: {
          paymentStatus: 'REFUNDED',
          refundAmount: cancellationCheck.refundAmount,
          refundedAt: new Date()
        }
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

  // Log activity
  await logActivity({
    userId: customerId,
    action: 'booking.cancelled',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason, refundAmount: cancellationCheck.refundAmount }
  });

  event.emit({
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
  const supplierId = req.user.id;
  const { status, tourId, page = 1, limit = 10 } = req.query;

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
  const supplierId = req.user.id;

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

  // Log activity
  await logActivity({
    userId: supplierId,
    action: 'booking.status_updated',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { oldStatus: booking.status, newStatus: status }
  });

  event.emit({
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

/**
 * Calculate tour pricing based on travelers and date
 */
function calculateTourPricing(tour, travelers) {
  try {
    const pricing = tour.schedulesAndPricing;
    
    if (!pricing || !pricing.schedules || pricing.schedules.length === 0) {
      return { success: false, error: 'Unable to calculate pricing' };
    }
    
    let subtotal = 0;
    const currency = pricing.currency || 'USD';
    
    const schedule = pricing.schedules[0];
    if (!schedule.prices || schedule.prices.length === 0) {
      return { success: false, error: 'Unable to calculate pricing' };
    }
    
    const basePrice = schedule.prices[0].retailPrice || 0;
    subtotal = basePrice * (travelers.adults || 1);
    
    return {
      success: true,
      subtotal,
      total: subtotal,
      currency
    };
  } catch {
    return {
      success: false,
      error: 'Unable to calculate pricing'
    };
  }
}

/**
 * Check if booking can be cancelled and calculate refund
 */
function checkCancellationPolicy(booking) {
  const now = new Date();
  const bookingDate = new Date(booking.selectedDate);
  const hoursUntilBooking = (bookingDate - now) / (1000 * 60 * 60);
  
  // Get cancellation policy from tour
  const policy = booking.tour.bookingAndTickets?.cancellationPolicy;
  
  if (!policy) {
    return {
      allowed: true,
      refundAmount: parseFloat(booking.total),
      reason: 'Full refund available'
    };
  }
  
  // Implement cancellation policy logic
  const windowHours = policy.cancellationWindowHours || 24;
  
  if (hoursUntilBooking < windowHours) {
    return {
      allowed: false,
      reason: `Cancellation not allowed within ${windowHours} hours of tour`
    };
  }
  
  return {
    allowed: true,
    refundAmount: parseFloat(booking.total),
    reason: 'Full refund available'
  };
}

module.exports = exports;