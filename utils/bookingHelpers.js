/**
 * Booking Helpers - Production Ready
 * Utility functions for booking management
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');

/**
 * Generate unique booking number
 */
async function generateBookingNumber() {
  const prefix = 'TB'; // Tour Booking
  const timestamp = Date.now().toString().slice(-8); // Last 8 digits of timestamp
  const random = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 random chars
  
  let bookingNumber = `${prefix}${timestamp}${random}`;
  
  // Ensure uniqueness
  let attempt = 0;
  while (attempt < 10) {
    const existing = await prisma.booking.findUnique({
      where: { bookingNumber }
    });
    
    if (!existing) {
      return bookingNumber;
    }
    
    // Generate new number if collision
    attempt++;
    const newRandom = Math.random().toString(36).substring(2, 6).toUpperCase();
    bookingNumber = `${prefix}${timestamp}${newRandom}`;
  }
  
  // Fallback with UUID if still colliding
  const { v4: uuidv4 } = require('uuid');
  return `${prefix}${uuidv4().replace(/-/g, '').substring(0, 10).toUpperCase()}`;
}

/**
 * Validate traveler information
 */
function validateTravelerInfo(travelers) {
  const errors = [];

  if (!travelers || typeof travelers !== 'object') {
    errors.push('Traveler information is required');
    return { isValid: false, errors, totalTravelers: 0 };
  }

  const totalTravelers = (travelers.adults || 0) + (travelers.children || 0) + (travelers.youth || 0);
  if (totalTravelers === 0) {
    errors.push('At least one traveler is required');
  }

  if (!travelers.phoneNumber || !/^\+?[\d\s\-()]{6,20}$/.test(travelers.phoneNumber)) {
    errors.push('A valid phone number (WhatsApp) is required for contact');
  }

  if (!travelers.location || travelers.location.trim().length < 3) {
    errors.push('Your location (city/country) is required');
  }

  return {
    isValid: errors.length === 0,
    errors,
    totalTravelers
  };
}

/**
 * Calculate booking totals including taxes and fees
 */
function calculateBookingTotals(subtotal, currency = 'USD', promoCode = null) {
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
  
  // Calculate platform fees (2.9% + $0.30)
  fees = (subtotal * 0.029) + 0.30;
  
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
async function checkBookingConflicts(supplierId, selectedDate, selectedTime, excludeBookingId = null) {
  try {
    const where = {
      tour: {
        supplierId
      },
      selectedDate: new Date(selectedDate),
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
      selectedDate: {
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
          total: true,
          supplierPayout: true,
          commissionAmount: true
        },
        _avg: {
          total: true
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
        total: revenueStats._sum.total || 0,
        supplierPayout: revenueStats._sum.supplierPayout || 0,
        commission: revenueStats._sum.commissionAmount || 0,
        average: revenueStats._avg.total || 0
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
      date: booking.selectedDate,
      time: booking.selectedTime
    },
    travelers: booking.travelers,
    pricing: {
      subtotal: booking.subtotal,
      taxes: booking.taxes,
      fees: booking.fees,
      total: booking.total,
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
  const bookingDate = new Date(booking.selectedDate);
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
 * Calculate refund amount based on cancellation policy
 */
function calculateRefundAmount(booking, tour, cancellationDate = new Date()) {
  const bookingDate = new Date(booking.selectedDate);
  const hoursUntilBooking = (bookingDate - cancellationDate) / (1000 * 60 * 60);
  
  const policy = tour.bookingAndTickets?.cancellationPolicy;
  
  if (!policy) {
    // Default policy: full refund if more than 24 hours
    return {
      refundAmount: hoursUntilBooking >= 24 ? parseFloat(booking.total) : 0,
      refundPercentage: hoursUntilBooking >= 24 ? 100 : 0,
      reason: hoursUntilBooking >= 24 ? 'Full refund (24+ hours notice)' : 'No refund (less than 24 hours)'
    };
  }
  
  // Apply tour-specific cancellation policy
  const windowHours = policy.cancellationWindowHours || 24;
  
  if (hoursUntilBooking < windowHours) {
    return {
      refundAmount: 0,
      refundPercentage: 0,
      reason: `No refund within ${windowHours} hours of tour`
    };
  }
  
  // Full refund if outside window
  return {
    refundAmount: parseFloat(booking.total),
    refundPercentage: 100,
    reason: 'Full refund available'
  };
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
        selectedDate: {
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
  calculateBookingTotals,
  checkBookingConflicts,
  getBookingStats,
  generateBookingConfirmation,
  canModifyBooking,
  calculateRefundAmount,
  getUpcomingBookings
};