/**
 * Tour Helpers - Production Ready
 * Utility functions for tour management and validation
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const { findBestDiscount } = require('./specialOfferEngine');

/**
 * Create unique slug for tour
 * @param {string} title
 * @param {object} db - Prisma client or transaction client
 * @param {number} attempt
 */
async function createSlug(title, db = prisma, attempt = 0) {
  const baseSlug = (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .trim('-'); // Remove leading/trailing hyphens

  const slug = attempt > 0 ? `${baseSlug}-${attempt}` : baseSlug;

  const existingTour = await db.tour.findUnique({
    where: { slug }
  });

  if (existingTour) {
    return createSlug(title, db, attempt + 1);
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
 * Validate tour data structure — supports both flat 13-step store shape
 * and legacy nested JSON blob shape for backward compatibility.
 */
function validateTourData(data, isPartial = false) {
  const { productSchema } = require('./productSchema');

  try {
    // Use Zod validation schema
    const parsed = isPartial
      ? productSchema.partial().safeParse(data)
      : productSchema.safeParse(data);

    if (!parsed.success) {
      return {
        isValid: false,
        errors: parsed.error.issues.map(e => {
          const path = e.path.join('.');
          return path ? `${path}: ${e.message}` : e.message;
        })
      };
    }

    return {
      isValid: true,
      errors: []
    };
  } catch (error) {
    return {
      isValid: false,
      errors: [`Validation error: ${error.message}`]
    };
  }
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
 * Validate pricing structure — accepts the nested schedulesAndPricing blob
 * or flat store shape. Removed perBooking and maxTravelersPerBooking.
 */
function validatePricing(data) {
  const errors = [];

  try {
    // Support both flat store shape and nested schedulesAndPricing blob
    const travelerDetails = data.travelerDetails || data;
    const pricingSchedules = data.pricingSchedules || data;

    const {
      pricingModel,
      pricingApproach,
      ageGroups,
      minParticipants,
      maxParticipants,
      groupSizes,
      additionalPersonsEnabled,
      additionalPersonPrice,
      maxGroupsPerTimeSlot,
    } = travelerDetails;

    const {
      currency,
      schedules,
    } = pricingSchedules;

    if (pricingModel && !['perPerson', 'perGroup'].includes(pricingModel)) {
      errors.push('Valid pricing model is required (perPerson or perGroup)');
    }

    if (pricingApproach && !['sameForEveryone', 'dependsOnAge'].includes(pricingApproach)) {
      errors.push('Pricing approach must be sameForEveryone or dependsOnAge');
    }

    if (ageGroups && Array.isArray(ageGroups)) {
      for (const ageGroup of ageGroups) {
        if (!ageGroup.name || ageGroup.minAge === undefined || ageGroup.maxAge === undefined) {
          errors.push('Age groups must have name, minAge, and maxAge');
          break;
        }
        if (ageGroup.minAge < 0 || ageGroup.maxAge > 120 || ageGroup.minAge > ageGroup.maxAge) {
          errors.push('Invalid age range in age groups');
          break;
        }
      }
    }

    if (minParticipants !== undefined && (minParticipants < 1 || minParticipants > 100)) {
      errors.push('Min participants must be between 1 and 100');
    }

    if (maxParticipants !== undefined && (maxParticipants < 1 || maxParticipants > 100)) {
      errors.push('Max participants must be between 1 and 100');
    }

    if (minParticipants !== undefined && maxParticipants !== undefined && minParticipants > maxParticipants) {
      errors.push('Min participants cannot exceed max participants');
    }

    if (groupSizes && Array.isArray(groupSizes)) {
      const sorted = [...groupSizes].sort((a, b) => (a.from ?? 0) - (b.from ?? 0))
      for (let i = 0; i < sorted.length; i++) {
        const gs = sorted[i]
        if (gs.from == null || gs.to == null || gs.from < 1 || gs.to > 100) {
          errors.push('Each group size must have from (1-100) and to (1-100)');
          break;
        }
        if (gs.from > gs.to) {
          errors.push('Group size from cannot exceed to');
          break;
        }
        if (i > 0 && gs.from <= sorted[i - 1].to) {
          errors.push('Group sizes must not overlap');
          break;
        }
      }
    }

    if (additionalPersonsEnabled && (additionalPersonPrice === null || additionalPersonPrice === undefined)) {
      errors.push('Additional person price is required when additional persons are enabled');
    }

    if (maxGroupsPerTimeSlot !== undefined && (maxGroupsPerTimeSlot < 1 || maxGroupsPerTimeSlot > 50)) {
      errors.push('Max groups per time slot must be between 1 and 50');
    }

    if (currency && (typeof currency !== 'string' || currency.length !== 3)) {
      errors.push('Valid 3-letter currency code is required');
    }

    if (schedules && Array.isArray(schedules)) {
      for (const schedule of schedules) {
        if (schedule.startDate && schedule.endDate && new Date(schedule.endDate) < new Date(schedule.startDate)) {
          errors.push('Schedule end date must be on or after start date');
          break;
        }
      }
    }

  } catch {
    errors.push('Invalid pricing structure format');
  }

  return errors;
}

/**
 * Regenerate the derived `prices` array on every pricing schedule from the
 * authoritative `travelerDetails` source-of-truth fields. Invoked on write so
 * the stored blob never holds stale, empty, or client-derived prices — the
 * server is the single author of `schedules[].prices`, which is what checkout
 * (`calculateTourPrice`) and the public "from $X" reads consume.
 *
 * Returns the input blob unchanged when it cannot be normalized (missing
 * schedules, non-object, etc.) so callers can pass the result straight to
 * `validateStoredPricing`.
 */
function rebuildSchedulePrices(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return blob;
  const td = blob.travelerDetails || {};
  const ps = blob.pricingSchedules;
  if (!ps || !Array.isArray(ps.schedules)) return blob;

  const cats = (Array.isArray(td.pricingCategories) && td.pricingCategories.length > 0)
    ? td.pricingCategories
    : (Array.isArray(td.ageGroups) ? td.ageGroups : []);
  const groupSizes = Array.isArray(td.groupSizes) ? td.groupSizes : [];
  const pricingModel = td.pricingModel || 'perPerson';
  const pricingApproach = td.pricingApproach || 'dependsOnAge';

  const prices = [];
  if (pricingModel === 'perGroup') {
    for (const gs of groupSizes) {
      if (gs && gs.price != null) {
        prices.push({ label: `Group of ${gs.from}-${gs.to}`, retailPrice: gs.price, groupSize: true });
      }
    }
  } else if (pricingApproach === 'sameForEveryone') {
    if (td.uniformPrice != null) {
      prices.push({ ageGroup: 'Adult', retailPrice: td.uniformPrice });
    }
  } else {
    for (const c of cats) {
      if (c && c.price != null) {
        prices.push({ ageGroup: c.name || c.label, retailPrice: c.price });
      }
    }
  }

  for (const s of ps.schedules) {
    if (s && typeof s === 'object') {
      s.prices = prices.slice();
    }
  }

  return blob;
}

/**
 * Validate the stored schedulesAndPricing blob when a tour is set live
 * (status ACTIVE/PUBLISHED). Mirrors the supplier dashboard's step-14
 * wizard rules: at least one schedule, per-category prices present,
 * group-size prices present, capacity sane, and time slots / weekly
 * hours present per schedule type.
 */
function validateStoredPricing(blob) {
  const errors = [];

  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    errors.push('Pricing and availability data is required');
    return errors;
  }

  const travelerDetails = blob.travelerDetails || {};
  const pricingSchedules = blob.pricingSchedules || {};
  const availability = blob.availability || {};
  const schedules = Array.isArray(pricingSchedules.schedules) ? pricingSchedules.schedules : [];
  const firstSchedule = schedules[0] || {};

  const pricingModel = travelerDetails.pricingModel || firstSchedule.pricingModel || 'perPerson';
  const pricingApproach = travelerDetails.pricingApproach || firstSchedule.pricingApproach || 'dependsOnAge';

  // At least one pricing schedule
  if (schedules.length === 0) {
    errors.push('Add at least one pricing schedule');
  }

  // Date sanity for each schedule
  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    if (s && s.hasEndDate && s.startDate && s.endDate && new Date(s.endDate) < new Date(s.startDate)) {
      errors.push(`Schedule ${i + 1}: end date must be on or after the start date`);
    }
  }

  // Pricing completeness
  const cats = (Array.isArray(travelerDetails.pricingCategories) && travelerDetails.pricingCategories.length > 0)
    ? travelerDetails.pricingCategories
    : (Array.isArray(firstSchedule.pricingCategories) ? firstSchedule.pricingCategories : []);
  const groupSizes = (Array.isArray(travelerDetails.groupSizes) && travelerDetails.groupSizes.length > 0)
    ? travelerDetails.groupSizes
    : (Array.isArray(firstSchedule.groupSizes) ? firstSchedule.groupSizes : []);

  if (pricingModel === 'perGroup') {
    if (groupSizes.length === 0) {
      errors.push('Add at least one group size');
    }
    groupSizes.forEach((gs, i) => {
      if (gs == null) return;
      if (gs.price == null) {
        errors.push(`Group size ${i + 1}: price is required`);
      } else if (typeof gs.price === 'number' && gs.price < 0) {
        errors.push(`Group size ${i + 1}: price must be 0 or greater`);
      }
    });
  } else if (pricingApproach === 'sameForEveryone') {
    const uniformPrice = travelerDetails.uniformPrice != null
      ? travelerDetails.uniformPrice
      : (firstSchedule.uniformPrice != null ? firstSchedule.uniformPrice : null);
    if (uniformPrice == null) {
      errors.push('Enter a price per person');
    } else if (typeof uniformPrice === 'number' && uniformPrice < 0) {
      errors.push('Price per person must be 0 or greater');
    }
  } else {
    // dependsOnAge
    if (cats.length === 0) {
      errors.push('Add at least one pricing category');
    }
    cats.forEach((cat, i) => {
      if (cat == null) return;
      const isFree = cat.ticketNotRequired === true;
      if (cat.price == null && !isFree) {
        errors.push(`Pricing category "${cat.name || i + 1}": price is required`);
      } else if (typeof cat.price === 'number' && cat.price < 0) {
        errors.push(`Pricing category "${cat.name || i + 1}": price must be 0 or greater`);
      }
    });
  }

  // Capacity sanity
  const min = travelerDetails.minParticipants ?? firstSchedule.minParticipants;
  const max = travelerDetails.maxParticipants ?? firstSchedule.maxParticipants;
  if (min != null && max != null && typeof min === 'number' && typeof max === 'number' && min > max) {
    errors.push('Min participants cannot exceed max participants');
  }

  // Schedule type: fixedTimeSlot needs time slots; operatingHours needs weekly hours
  const scheduleType = availability.scheduleType || firstSchedule.type || 'fixedTimeSlot';
  if (scheduleType === 'fixedTimeSlot') {
    const timeSlots = (Array.isArray(availability.timeSlots) && availability.timeSlots.length > 0)
      ? availability.timeSlots
      : (Array.isArray(firstSchedule.timeSlots) ? firstSchedule.timeSlots : []);
    if (timeSlots.length === 0) {
      errors.push('Add at least one time slot');
    }
  } else if (scheduleType === 'operatingHours') {
    const weekly = availability.weeklySchedule || firstSchedule.weeklySchedule;
    const hasAnyHours = weekly && typeof weekly === 'object' &&
      Object.values(weekly).some((slots) => Array.isArray(slots) && slots.length > 0);
    if (!hasAnyHours) {
      errors.push('Add at least one opening hours entry');
    }
  }

  return errors;
}

/**
 * Calculate tour availability for a given date
 * Checks TourDateOverride, daysOfWeek template, and existing bookings.
 */
async function checkTourAvailability(tourId, selectedDate, selectedTime = null) {
  try {
    // Fetch tour with minimal data first
    const tour = await prisma.tour.findUnique({
      where: { id: tourId },
      select: {
        id: true,
        status: true,
        schedulesAndPricing: true,
      }
    });

    if (!tour) {
      return { available: false, reason: 'Tour not found' };
    }

    if (tour.status !== 'ACTIVE') {
      return { available: false, reason: 'Tour is not active' };
    }

    // Fetch override and count bookings in parallel
    const dateObj = new Date(selectedDate);
    const [override, bookingCount] = await Promise.all([
      prisma.tourDateOverride.findFirst({
        where: { tourId, date: dateObj },
        select: { status: true, capacity: true }
      }),
      prisma.booking.aggregate({
        where: {
          tourId,
          selectedDate: dateObj,
          selectedTime: selectedTime ?? undefined,
          status: { in: ['PENDING', 'CONFIRMED'] }
        },
        _count: { id: true }
      })
    ]);

    // Check if date is blocked by override
    if (override?.status === 'BLOCKED') {
      return { available: false, reason: 'Date is blocked', overrideStatus: 'BLOCKED' };
    }
    if (override?.status === 'FULL') {
      return { available: false, reason: 'Date is fully booked', overrideStatus: 'FULL' };
    }

    // Check if operating day
    const schedulesAndPricing = typeof tour.schedulesAndPricing === 'string'
      ? JSON.parse(tour.schedulesAndPricing)
      : tour.schedulesAndPricing;
    const templateDaysOfWeek = schedulesAndPricing?.availability?.daysOfWeek || schedulesAndPricing?.operatingDays || [];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeek = dayNames[dateObj.getDay()];

    if (templateDaysOfWeek.length > 0 && !templateDaysOfWeek.some(d => d.toLowerCase() === dayOfWeek.toLowerCase())) {
      return { available: false, reason: 'Tour does not operate on this day' };
    }

    // Get capacity from override or template
    const maxTravelersFallback = parseInt(await getConfig('booking.max_travelers', '50'));
    const maxCapacity = override?.capacity ?? schedulesAndPricing?.travelerDetails?.maxParticipants ?? maxTravelersFallback;

    const currentBookings = bookingCount._count.id;
    const availableSpots = maxCapacity - currentBookings;

    return {
      available: availableSpots > 0,
      availableSpots,
      maxCapacity,
      currentBookings,
      overrideStatus: override?.status || null,
    };
  } catch (error) {
    console.error('❌ Check availability failed:', error);
    return { available: false, reason: 'Error checking availability' };
  }
}

/**
 * Get tour pricing for specific date and travelers
 */
async function calculateTourPrice(tour, travelers, selectedDate, selectedTime = null, tourOptionKey = null, customerId = null) {
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

    // Calculate total price from the authoritative travelerDetails source of
    // truth, so an empty/stale derived `prices` array can never price a live
    // tour at $0. Any missing/unpriceable traveler fails closed.
    const td = pricing.travelerDetails || {};
    const pricingModel = td.pricingModel || applicableSchedule.pricingModel || 'perPerson';
    const pricingApproach = td.pricingApproach || applicableSchedule.pricingApproach || 'dependsOnAge';

    let subtotal = 0;

    if (pricingModel === 'perGroup') {
      const groupSizes = Array.isArray(td.groupSizes) ? td.groupSizes : [];
      const totalTravelers = Object.values(travelers).reduce((sum, count) => sum + (typeof count === 'number' ? count : 0), 0);
      if (totalTravelers < 1) {
        throw new Error('At least one traveler is required');
      }
      const match = groupSizes.find(gs => gs && totalTravelers >= gs.from && totalTravelers <= gs.to);
      if (!match || match.price == null) {
        throw new Error('No price available for the selected group size');
      }
      subtotal = match.price;
    } else if (pricingApproach === 'sameForEveryone') {
      const uniformPrice = td.uniformPrice != null ? td.uniformPrice : applicableSchedule.uniformPrice;
      if (uniformPrice == null) {
        throw new Error('No pricing available for this tour');
      }
      for (const count of Object.values(travelers)) {
        if (typeof count === 'number' && count > 0) {
          subtotal += uniformPrice * count;
        }
      }
    } else {
      // dependsOnAge — price per traveler, preferring travelerDetails
      // pricingCategories and falling back to the schedule's derived prices
      const cats = (Array.isArray(td.pricingCategories) && td.pricingCategories.length > 0)
        ? td.pricingCategories
        : (Array.isArray(td.ageGroups) ? td.ageGroups : []);
      let priced = false;
      for (const [ageCategory, count] of Object.entries(travelers)) {
        if (typeof count !== 'number' || count <= 0) continue;
        const normalized = ageCategory.toLowerCase().replace(/s$/, '');
        const cat = cats.find(c => {
          const label = String(c.name ?? c.label ?? '').toLowerCase();
          return label === normalized || label === ageCategory.toLowerCase();
        });
        let price = (cat != null && cat.price != null) ? cat.price : null;
        if (price == null && Array.isArray(applicableSchedule.prices)) {
          const label = cat ? (cat.name || cat.label) : null;
          const priceInfo = label
            ? applicableSchedule.prices.find(p => p.ageGroup === label)
            : applicableSchedule.prices.find(p =>
                p.ageGroup?.toLowerCase() === normalized || p.ageGroup?.toLowerCase() === ageCategory.toLowerCase());
          if (priceInfo && priceInfo.retailPrice != null) {
            price = priceInfo.retailPrice;
          }
        }
        if (price != null) {
          subtotal += price * count;
          priced = true;
        }
      }
      if (!priced) {
        throw new Error('No pricing available for this tour');
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

    let appliedOffer = null;

    const totalTravelers = Object.values(travelers).reduce((sum, count) => sum + (typeof count === 'number' ? count : 0), 0);
    const specialOfferResult = await findBestDiscount({
      tourId: tour.id,
      tourOptionKey,
      selectedDate: new Date(selectedDate),
      basePrice: subtotal,
      quantity: totalTravelers,
      customerId,
    }).catch(() => ({ discountAmount: 0, finalPrice: subtotal, appliedOffer: null, discountType: null }));

    const specialDiscount = subtotal - specialOfferResult.finalPrice;
    if (specialDiscount > discount) {
      discount = specialDiscount;
      appliedOffer = specialOfferResult.appliedOffer;
    }

    const total = subtotal - discount;

    return {
      success: true,
      subtotal,
      discount,
      total,
      currency,
      appliedOffer,
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

module.exports = {
  createSlug,
  parseJsonFields,
  validateTourData,
  validateStoredPricing,
  rebuildSchedulePrices,
  checkTourAvailability,
  calculateTourPrice,
};