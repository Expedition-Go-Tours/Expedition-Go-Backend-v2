/**
 * Tour Helpers - Production Ready
 * Utility functions for tour management and validation
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');

/**
 * Create unique slug for tour
 */
async function createSlug(title, attempt = 0) {
  const baseSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .trim('-'); // Remove leading/trailing hyphens

  const slug = attempt > 0 ? `${baseSlug}-${attempt}` : baseSlug;

  // Check if slug exists
  const existingTour = await prisma.tour.findUnique({
    where: { slug }
  });

  if (existingTour) {
    return createSlug(title, attempt + 1);
  }

  return slug;
}

/**
 * Parse JSON string fields and convert numeric strings in a request body.
 * Called before validation so that checks see proper types (objects, arrays, numbers).
 */
function parseJsonFields(data) {
  if (!data || typeof data !== 'object') return data;

  const jsonFields = ['categorization', 'theme', 'productContent', 'schedulesAndPricing', 'bookingAndTickets', 'tags', 'existingPhotos'];
  for (const field of jsonFields) {
    if (typeof data[field] === 'string') {
      try { data[field] = JSON.parse(data[field]); } catch { /* leave as-is */ }
    }
  }

  // Convert lat/lng from strings to numbers (FormData sends strings)
  if (typeof data.latitude === 'string') {
    const n = parseFloat(data.latitude);
    if (!isNaN(n)) data.latitude = n;
  }
  if (typeof data.longitude === 'string') {
    const n = parseFloat(data.longitude);
    if (!isNaN(n)) data.longitude = n;
  }

  return data;
}

/**
 * Validate tour data structure
 */
function validateTourData(data, isPartial = false) {
  const errors = [];

  // Pre-parse JSON string fields so validation sees objects/arrays/numbers, not strings
  parseJsonFields(data);

  if (!isPartial) {
    // Required fields for new tours
    if (!data.title || data.title.trim().length === 0) {
      errors.push('Title is required');
    }

    if (!data.description || data.description.trim().length < 50) {
      errors.push('Description must be at least 50 characters');
    }

    if (!data.categorization) {
      errors.push('Categorization is required');
    }

    if (!data.schedulesAndPricing) {
      errors.push('Schedules and pricing information is required');
    }
  }

  // Validate title length
  if (data.title && data.title.length > 200) {
    errors.push('Title must be less than 200 characters');
  }

  // Validate description length
  if (data.description && data.description.length > 5000) {
    errors.push('Description must be less than 5000 characters');
  }

  // Validate coordinates
  if (data.latitude !== undefined && (typeof data.latitude !== 'number' || data.latitude < -90 || data.latitude > 90)) {
    errors.push('Latitude must be a number between -90 and 90');
  }
  if (data.longitude !== undefined && (typeof data.longitude !== 'number' || data.longitude < -180 || data.longitude > 180)) {
    errors.push('Longitude must be a number between -180 and 180');
  }
  if ((data.latitude !== undefined) !== (data.longitude !== undefined)) {
    errors.push('Both latitude and longitude must be provided together');
  }

  // Validate photos array
  if (data.photos && !Array.isArray(data.photos)) {
    errors.push('Photos must be an array');
  }

  if (data.photos && data.photos.length > 20) {
    errors.push('Maximum 20 photos allowed');
  }

  // Validate tags
  if (data.tags && !Array.isArray(data.tags)) {
    errors.push('Tags must be an array');
  }

  if (data.tags && data.tags.length > 10) {
    errors.push('Maximum 10 tags allowed');
  }

  // Validate categorization structure
  if (data.categorization) {
    if (!validateCategorization(data.categorization)) {
      errors.push('Invalid categorization structure');
    }
  }

  // Validate pricing structure
  if (data.schedulesAndPricing) {
    const pricingErrors = validatePricing(data.schedulesAndPricing);
    errors.push(...pricingErrors);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate categorization structure
 */
function validateCategorization(categorization) {
  try {
    // Basic structure validation
    if (typeof categorization !== 'object') return false;

    // Validate top-level transportMode (nested object: { air: [...], land: [...], water: [...] })
    if (categorization.transportMode) {
      if (typeof categorization.transportMode !== 'object' || Array.isArray(categorization.transportMode)) return false;
      const { air, land, water } = categorization.transportMode;
      if (air && !Array.isArray(air)) return false;
      if (land && !Array.isArray(land)) return false;
      if (water && !Array.isArray(water)) return false;
    }

    // Validate tour categorization
    if (categorization.tour) {
      const { transportModes } = categorization.tour;
      
      if (transportModes) {
        if (transportModes.airTransport && !Array.isArray(transportModes.airTransport)) return false;
        if (transportModes.landTransport && !Array.isArray(transportModes.landTransport)) return false;
        if (transportModes.waterTransport && !Array.isArray(transportModes.waterTransport)) return false;
      }
    }

    // Validate activity categorization
    if (categorization.activity) {
      const { activitiesIncluded } = categorization.activity;
      if (activitiesIncluded && !Array.isArray(activitiesIncluded)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Validate pricing structure
 */
function validatePricing(schedulesAndPricing) {
  const errors = [];

  try {
    // Validate traveler details
    if (!schedulesAndPricing.travelerDetails) {
      errors.push('Traveler details are required');
      return errors;
    }

    const { pricingModel, maxTravelersPerBooking, ageGroups } = schedulesAndPricing.travelerDetails;

    if (!pricingModel || !['group', 'perPerson', 'perBooking'].includes(pricingModel)) {
      errors.push('Valid pricing model is required (group, perPerson, or perBooking)');
    }

    if (!maxTravelersPerBooking || maxTravelersPerBooking < 1 || maxTravelersPerBooking > 50) {
      errors.push('Max travelers per booking must be between 1 and 50');
    }

    if (!ageGroups || !Array.isArray(ageGroups) || ageGroups.length === 0) {
      errors.push('At least one age group is required');
    }

    // Validate age groups
    if (ageGroups) {
      for (const ageGroup of ageGroups) {
        if (!ageGroup.label || ageGroup.minAge === undefined || ageGroup.maxAge === undefined) {
          errors.push('Age groups must have label, minAge, and maxAge');
          break;
        }
        if (ageGroup.minAge < 0 || ageGroup.maxAge > 120 || ageGroup.minAge > ageGroup.maxAge) {
          errors.push('Invalid age range in age groups');
          break;
        }
      }
    }

    // Validate pricing schedules
    if (!schedulesAndPricing.pricingSchedules) {
      errors.push('Pricing schedules are required');
      return errors;
    }

    const { currency, schedules } = schedulesAndPricing.pricingSchedules;

    if (!currency || currency.length !== 3) {
      errors.push('Valid 3-letter currency code is required');
    }

    if (!schedules || !Array.isArray(schedules) || schedules.length === 0) {
      errors.push('At least one pricing schedule is required');
    }

    // Validate individual schedules
    if (schedules) {
      for (const schedule of schedules) {
        if (!schedule.startDate) {
          errors.push('Schedule start date is required');
          break;
        }

        if (!schedule.prices || !Array.isArray(schedule.prices) || schedule.prices.length === 0) {
          errors.push('Schedule must have at least one price');
          break;
        }

        // Validate prices
        for (const price of schedule.prices) {
          if (!price.ageGroup || price.retailPrice === undefined || price.retailPrice < 0) {
            errors.push('Invalid price structure');
            break;
          }
        }
      }
    }

  } catch {
    errors.push('Invalid pricing structure format');
  }

  return errors;
}

/**
 * Calculate tour availability for a given date
 */
async function checkTourAvailability(tourId, selectedDate, selectedTime = null) {
  try {
    const tour = await prisma.tour.findUnique({
      where: { id: tourId },
      include: {
        bookings: {
          where: {
            selectedDate: new Date(selectedDate),
            selectedTime: selectedTime,
            status: {
              in: ['PENDING', 'CONFIRMED']
            }
          }
        }
      }
    });

    if (!tour) {
      return { available: false, reason: 'Tour not found' };
    }

    if (tour.status !== 'ACTIVE') {
      return { available: false, reason: 'Tour is not active' };
    }

    // Get max capacity from tour settings
    const maxCapacity = tour.schedulesAndPricing?.travelerDetails?.maxTravelersPerBooking || 10;
    
    // Calculate current bookings
    const currentBookings = tour.bookings.reduce((total, booking) => {
      const travelers = booking.travelers;
      return total + (travelers.adults || 0) + (travelers.children || 0) + (travelers.infants || 0);
    }, 0);

    const availableSpots = maxCapacity - currentBookings;

    return {
      available: availableSpots > 0,
      availableSpots,
      maxCapacity,
      currentBookings
    };
  } catch (error) {
    console.error('❌ Check availability failed:', error);
    return { available: false, reason: 'Error checking availability' };
  }
}

/**
 * Get tour pricing for specific date and travelers
 */
function calculateTourPrice(tour, travelers, selectedDate, selectedTime = null) {
  try {
    const pricing = tour.schedulesAndPricing;
    if (!pricing || !pricing.pricingSchedules) {
      throw new Error('No pricing information available');
    }

    const { schedules, currency } = pricing.pricingSchedules;
    
    // Find applicable schedule
    const applicableSchedule = schedules.find(schedule => {
      const startDate = new Date(schedule.startDate);
      const endDate = schedule.endDate ? new Date(schedule.endDate) : null;
      const bookingDate = new Date(selectedDate);

      if (bookingDate < startDate) return false;
      if (endDate && bookingDate > endDate) return false;

      // Check day of week if specified
      if (schedule.prices[0]?.days && schedule.prices[0].days.length > 0) {
        const dayName = bookingDate.toLocaleDateString('en-US', { weekday: 'long' });
        if (!schedule.prices[0].days.includes(dayName)) return false;
      }

      // Check time if specified
      if (selectedTime && schedule.prices[0]?.times && schedule.prices[0].times.length > 0) {
        if (!schedule.prices[0].times.includes(selectedTime)) return false;
      }

      return true;
    });

    if (!applicableSchedule) {
      throw new Error('No pricing available for selected date/time');
    }

    // Calculate total price
    let subtotal = 0;
    const ageGroups = pricing.travelerDetails.ageGroups;

    for (const [ageCategory, count] of Object.entries(travelers)) {
      if (count > 0) {
        const ageGroup = ageGroups.find(ag => ag.label.toLowerCase() === ageCategory.toLowerCase());
        if (ageGroup) {
          const priceInfo = applicableSchedule.prices.find(p => p.ageGroup === ageGroup.label);
          if (priceInfo) {
            subtotal += priceInfo.retailPrice * count;
          }
        }
      }
    }

    // Apply promotions if any
    let discount = 0;
    if (pricing.promotions && pricing.promotions.length > 0) {
      const activePromotions = pricing.promotions.filter(promo => {
        if (!promo.isActive) return false;
        
        const now = new Date();
        const startDate = new Date(promo.startDate);
        const endDate = new Date(promo.endDate);
        
        return now >= startDate && now <= endDate;
      });

      // Apply best promotion
      for (const promo of activePromotions) {
        let promoDiscount = 0;
        
        if (promo.type === 'percentage') {
          promoDiscount = subtotal * (promo.discountValue / 100);
        } else if (promo.type === 'fixedAmount') {
          promoDiscount = promo.discountValue;
        }

        if (promo.maximumDiscountAmount) {
          promoDiscount = Math.min(promoDiscount, promo.maximumDiscountAmount);
        }

        discount = Math.max(discount, promoDiscount);
      }
    }

    const total = subtotal - discount;

    return {
      success: true,
      subtotal,
      discount,
      total,
      currency,
      breakdown: {
        travelers,
        applicableSchedule: applicableSchedule.startDate
      }
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Search tours with filters
 */
async function searchTours({
  query,
  category,
  theme,
  location,
  minPrice,
  maxPrice,
  rating,
  startDate,
  endDate,
  sortBy = 'relevance',
  page = 1,
  limit = 12
}) {
  try {
    const where = {
      status: 'ACTIVE',
      supplier: {
        supplierProfile: {
          status: 'ACTIVE'
        }
      }
    };

    // Text search
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { tags: { has: query } }
      ];
    }

    // Category filter
    if (category) {
      where.categorization = {
        path: ['tour', 'category'],
        equals: category
      };
    }

    // Theme filter
    if (theme) {
      where.theme = {
        path: ['mainTheme'],
        equals: theme
      };
    }

    // Rating filter
    if (rating) {
      where.averageRating = { gte: parseFloat(rating) };
    }

    // Date availability filter (simplified)
    if (startDate && endDate) {
      // This would require more complex logic to check actual availability
      // For now, we'll just ensure the tour has active schedules
    }

    // Sorting
    let orderBy = { createdAt: 'desc' };
    switch (sortBy) {
      case 'price_low':
        // This would require complex JSON path queries for pricing
        orderBy = { createdAt: 'desc' };
        break;
      case 'price_high':
        orderBy = { createdAt: 'desc' };
        break;
      case 'rating':
        orderBy = { averageRating: 'desc' };
        break;
      case 'popularity':
        orderBy = { totalBookings: 'desc' };
        break;
      default:
        orderBy = { createdAt: 'desc' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [tours, totalCount] = await Promise.all([
      prisma.tour.findMany({
        where,
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              photoURL: true,
              supplierProfile: {
                select: {
                  averageRating: true,
                  totalBookings: true
                }
              }
            }
          },
          _count: {
            select: {
              reviews: true,
              bookings: true
            }
          }
        },
        orderBy,
        skip,
        take: parseInt(limit)
      }),
      prisma.tour.count({ where })
    ]);

    const totalPages = Math.ceil(totalCount / parseInt(limit));

    return {
      tours,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      },
      filters: {
        query,
        category,
        theme,
        location,
        minPrice,
        maxPrice,
        rating,
        sortBy
      }
    };

  } catch (error) {
    console.error('❌ Tour search failed:', error);
    throw error;
  }
}

module.exports = {
  createSlug,
  parseJsonFields,
  validateTourData,
  checkTourAvailability,
  calculateTourPrice,
  searchTours
};