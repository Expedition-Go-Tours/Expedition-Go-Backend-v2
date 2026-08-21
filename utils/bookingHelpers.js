/**
 * Booking Helpers - Production Ready
 * Utility functions for booking management
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');
const getConfig = require('./getConfig');

/**
 * Generate unique booking number
 */
async function generateBookingNumber(prefix = 'TRA') {
  const year = new Date().getFullYear();
  const timestamp = Date.now().toString().slice(-8);

  const counter = await prisma.$transaction(async (tx) => {
    const row = await tx.bookingCounter.upsert({
      where: { prefix_year: { prefix, year } },
      create: { prefix, year, count: 1 },
      update: { count: { increment: 1 } },
    });
    return row.count;
  });

  return `${prefix}-${timestamp}-${year}-${String(counter).padStart(2, '0')}`;
}

/**
 * Validate traveler information
 */
function validateTravelerInfo(travelers, opts = {}) {
  const errors = [];

  if (!travelers || typeof travelers !== 'object') {
    errors.push('Traveler information is required');
    return { isValid: false, errors, totalTravelers: 0 };
  }

  const { travelerCount } = require('./availabilityCore');
  const totalTravelers = travelerCount(travelers);
  if (totalTravelers === 0) {
    errors.push('At least one traveler is required');
  }

  if (!travelers.phoneNumber) {
    errors.push('A valid phone number (WhatsApp) is required for contact');
  } else {
    const { validatePhone } = require('./phoneValidation');
    const result = validatePhone(travelers.phoneNumber);
    if (!result.isValid) {
      errors.push('A valid phone number is required. Use international format (e.g., +12025551234)');
    }
  }

  // Location is required for address-based pickup flows. Area-based pickup
  // (Expedition storefront) validates location via resolvePickupSelection
  // instead, so callers can skip this check with { requireLocation: false }.
  if (opts.requireLocation !== false && (!travelers.location || travelers.location.trim().length < 3)) {
    errors.push('Your location (city/country) is required');
  }

  return {
    isValid: errors.length === 0,
    errors,
    totalTravelers
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email.trim());
}

/**
 * Calculate booking totals including taxes and fees
 */
async function calculateBookingTotals(subtotal, currency = 'USD', promoCode = null) {
  let total = subtotal;
  let taxes = 0;
  let fees = 0;
  let discount = 0;
  
  // Calculate taxes (simplified - in production, use tax service)
  const taxRates = {
    'USD': 0.08, // 8% for US
    'EUR': 0.20, // 20% VAT for EU
    'GBP': 0.20, // 20% VAT for UK
    'CAD': 0.13, // 13% HST for Canada
  };
  
  const taxRate = taxRates[currency] || 0;
  taxes = subtotal * taxRate;
  
  // Calculate platform fees from system config
  fees = parseFloat(await getConfig('commission.platform_fee', '2.50'));
  
  // Apply promo code discount (simplified)
  if (promoCode) {
    // In production, validate promo code against database
    discount = subtotal * 0.10; // 10% discount example
  }
  
  total = subtotal + taxes + fees - discount;
  
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    taxes: Math.round(taxes * 100) / 100,
    fees: Math.round(fees * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    total: Math.round(total * 100) / 100,
    currency
  };
}

/**
 * Check booking conflicts for supplier
 */
async function checkBookingConflicts(supplierId, travelDate, selectedTime, excludeBookingId = null) {
  try {
    const where = {
      tour: {
        supplierId
      },
      travelDate: new Date(travelDate),
      status: {
        in: ['PENDING', 'CONFIRMED']
      }
    };
    
    if (selectedTime) {
      where.selectedTime = selectedTime;
    }
    
    if (excludeBookingId) {
      where.id = {
        not: excludeBookingId
      };
    }
    
    const conflictingBookings = await prisma.booking.findMany({
      where,
      include: {
        tour: {
          select: {
            title: true
          }
        },
        customer: {
          select: {
            name: true,
            email: true
          }
        }
      }
    });
    
    return {
      hasConflicts: conflictingBookings.length > 0,
      conflicts: conflictingBookings
    };
  } catch (error) {
    console.error('❌ Check booking conflicts failed:', error);
    return { hasConflicts: false, conflicts: [] };
  }
}

/**
 * Get booking statistics for date range
 */
async function getBookingStats(supplierId = null, startDate, endDate) {
  try {
    const where = {
      travelDate: {
        gte: new Date(startDate),
        lte: new Date(endDate)
      }
    };
    
    if (supplierId) {
      where.tour = {
        supplierId
      };
    }
    
    const [
      totalBookings,
      bookingsByStatus,
      revenueStats,
      dailyBookings
    ] = await Promise.all([
      prisma.booking.count({ where }),
      
      prisma.booking.groupBy({
        by: ['status'],
        where,
        _count: true
      }),
      
      prisma.booking.aggregate({
        where: {
          ...where,
          status: 'CONFIRMED'
        },
        _sum: {
          grossAmount: true,
          supplierPayout: true,
          platformCommission: true
        },
        _avg: {
          grossAmount: true
        }
      }),
      
      prisma.$queryRaw`
        SELECT 
          DATE("selectedDate") as date,
          COUNT(*) as bookings,
          SUM(CASE WHEN status = 'CONFIRMED' THEN "total" ELSE 0 END) as revenue
        FROM "Booking" b
        ${supplierId ? `JOIN "Tour" t ON b."tourId" = t.id` : ''}
        WHERE b."selectedDate" >= ${new Date(startDate)}
          AND b."selectedDate" <= ${new Date(endDate)}
          ${supplierId ? `AND t."supplierId" = ${supplierId}` : ''}
        GROUP BY DATE("selectedDate")
        ORDER BY date
      `
    ]);
    
    return {
      totalBookings,
      bookingsByStatus,
      revenue: {
        total: revenueStats._sum.grossAmount || 0,
        supplierPayout: revenueStats._sum.supplierPayout || 0,
        commission: revenueStats._sum.platformCommission || 0,
        average: revenueStats._avg.grossAmount || 0
      },
      dailyTrend: dailyBookings
    };
  } catch (error) {
    console.error('❌ Get booking stats failed:', error);
    throw error;
  }
}

/**
 * Generate booking confirmation data
 */
function generateBookingConfirmation(booking, tour, customer) {
  return {
    bookingNumber: booking.bookingNumber,
    customer: {
      name: customer.name,
      email: customer.email
    },
    tour: {
      title: tour.title,
      supplier: tour.supplier.name,
      photos: tour.photos
    },
    schedule: {
      date: booking.travelDate,
      time: booking.selectedTime
    },
    travelers: booking.travelers,
    pricing: {
      subtotal: booking.subtotal,
      taxes: booking.taxes,
      fees: booking.fees,
      total: booking.grossAmount,
      currency: booking.currency
    },
    specialRequests: booking.specialRequests,
    status: booking.status,
    createdAt: booking.createdAt
  };
}

/**
 * Check if booking can be modified
 */
function canModifyBooking(booking, tour) {
  // Can't modify if already completed, cancelled, or refunded
  if (['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(booking.status)) {
    return {
      canModify: false,
      reason: 'Booking cannot be modified in current status'
    };
  }
  
  // Check modification cutoff time
  const now = new Date();
  const bookingDate = new Date(booking.travelDate);
  const hoursUntilBooking = (bookingDate - now) / (1000 * 60 * 60);
  
  const cutoffHours = tour.bookingAndTickets?.modificationCutoffHours || 24;
  
  if (hoursUntilBooking < cutoffHours) {
    return {
      canModify: false,
      reason: `Modifications not allowed within ${cutoffHours} hours of tour`
    };
  }
  
  return {
    canModify: true,
    reason: null
  };
}

/**
 * Evaluate a booking against its tour's cancellation policy.
 * Single source of truth for cancellation eligibility and refund amounts.
 *
 * - all_sales_final: cancellation allowed, but never refunded
 * - standard/custom: allowed outside cancellationWindowHours, refunded by refundPercentage
 * - A cancellationWindowHours of 0 is valid (window is open); it must not fall back to 24
 */
function evaluateCancellationPolicy(booking, tour, cancellationDate = new Date()) {
  const bookingDate = new Date(booking.travelDate);
  const hoursUntilBooking = (bookingDate - cancellationDate) / (1000 * 60 * 60);

  const policy = tour?.bookingAndTickets?.cancellationPolicy;

  if (!policy) {
    // Default policy: full refund if more than 24 hours
    const eligible = Number.isFinite(hoursUntilBooking) && hoursUntilBooking >= 24;
    return {
      allowed: eligible,
      refundAmount: eligible ? parseFloat(booking.grossAmount) : 0,
      refundPercentage: eligible ? 100 : 0,
      reason: eligible ? 'Full refund (24+ hours notice)' : 'No refund (less than 24 hours)',
      windowHours: 24
    };
  }

  const type = policy.type || 'standard';
  const windowHours = Number.isFinite(policy.cancellationWindowHours) ? policy.cancellationWindowHours : 24;
  const refundPercentage = Number.isFinite(policy.refundPercentage) ? policy.refundPercentage : 100;

  if (type === 'all_sales_final') {
    return {
      allowed: true,
      refundAmount: 0,
      refundPercentage: 0,
      reason: 'No refund - all sales final',
      windowHours: 0
    };
  }

  if (!Number.isFinite(hoursUntilBooking) || hoursUntilBooking < windowHours) {
    return {
      allowed: false,
      refundAmount: 0,
      refundPercentage: 0,
      reason: `Cancellation not allowed within ${windowHours} hours of tour`,
      windowHours
    };
  }

  const refundAmount = Math.round(parseFloat(booking.grossAmount) * (refundPercentage / 100) * 100) / 100;
  return {
    allowed: true,
    refundAmount,
    refundPercentage,
    reason: refundPercentage >= 100 ? 'Full refund available' : `Partial refund (${refundPercentage}%) available`,
    windowHours
  };
}

/**
 * Calculate refund amount based on cancellation policy
 */
function calculateRefundAmount(booking, tour, cancellationDate = new Date()) {
  const { refundAmount, refundPercentage, reason } = evaluateCancellationPolicy(booking, tour, cancellationDate);
  return { refundAmount, refundPercentage, reason };
}

/**
 * Get upcoming bookings for reminders
 */
async function getUpcomingBookings(hoursAhead = 24) {
  try {
    const reminderTime = new Date();
    reminderTime.setHours(reminderTime.getHours() + hoursAhead);
    
    const bookings = await prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        travelDate: {
          gte: new Date(),
          lte: reminderTime
        }
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true
          }
        },
        tour: {
          select: {
            title: true,
            supplier: {
              select: {
                name: true,
                phone: true,
                email: true
              }
            }
          }
        }
      }
    });
    
    return bookings;
  } catch (error) {
    console.error('❌ Get upcoming bookings failed:', error);
    return [];
  }
}

module.exports = {
  generateBookingNumber,
  validateTravelerInfo,
  isValidEmail,
  calculateBookingTotals,
  checkBookingConflicts,
  getBookingStats,
  generateBookingConfirmation,
  canModifyBooking,
  evaluateCancellationPolicy,
  calculateRefundAmount,
  getUpcomingBookings
};