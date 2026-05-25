/**
 * Tour Filter Builder - Production Ready
 * Scalable filter system for tour search and discovery
 * 
 * Features:
 * - Category, theme, and location filtering
 * - Price range filtering
 * - Rating and review filtering
 * - Date availability filtering
 * - Duration filtering
 * - Multi-criteria search
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

/**
 * Build comprehensive tour filters from query parameters
 * @param {Object} queryParams - Request query parameters
 * @returns {Object} Prisma where clause
 */
function buildTourFilters(queryParams) {
  const {
    // Category & Theme
    category,
    subcategory,
    activityType,
    theme,
    primaryTheme,
    secondaryTheme,
    
    // Location
    location,
    city,
    country,
    region,
    
    // Pricing
    minPrice,
    maxPrice,
    currency = 'USD',
    priceRange, // 'budget', 'moderate', 'luxury'
    
    // Rating & Reviews
    minRating,
    minReviews,
    
    // Duration
    minDuration,
    maxDuration,
    durationType, // 'hours', 'days'
    
    // Availability
    availableDate,
    dayOfWeek,
    
    // Features
    instantConfirmation,
    freeCancellation,
    
    // Search
    search,
    tags,
    
    // Supplier
    supplierId,
    verifiedOnly,
    
    // Status
    status = 'ACTIVE'
  } = queryParams;

  const where = {
    status,
    supplier: {
      supplierProfile: {
        status: verifiedOnly === 'true' ? 'ACTIVE' : { in: ['ACTIVE', 'APPROVED'] }
      }
    }
  };

  const andConditions = [];

  // ================================
  // CATEGORY FILTERS
  // ================================
  
  if (category || subcategory || activityType) {
    if (category) {
      andConditions.push({ category: { equals: category, mode: 'insensitive' } });
    }
    if (subcategory) {
      andConditions.push({ subcategory: { equals: subcategory, mode: 'insensitive' } });
    }
    if (activityType) {
      andConditions.push({ activityType: { equals: activityType, mode: 'insensitive' } });
    }
  }

  // ================================
  // THEME FILTERS
  // ================================

  if (theme || primaryTheme || secondaryTheme) {
    if (primaryTheme) {
      andConditions.push({ primaryTheme: { equals: primaryTheme, mode: 'insensitive' } });
    }

    if (secondaryTheme) {
      andConditions.push({
        secondaryThemes: {
          some: { theme: { equals: secondaryTheme, mode: 'insensitive' } }
        }
      });
    }

    // Generic theme search (searches both primary and secondary)
    if (theme && !primaryTheme && !secondaryTheme) {
      andConditions.push({
        OR: [
          { primaryTheme: { equals: theme, mode: 'insensitive' } },
          {
            secondaryThemes: {
              some: { theme: { equals: theme, mode: 'insensitive' } }
            }
          }
        ]
      });
    }
  }

  // ================================
  // LOCATION FILTERS
  // ================================
  
  if (location || city || country || region) {
    if (location) {
      // Search across indexed location columns
      andConditions.push({
        OR: [
          { city: { contains: location, mode: 'insensitive' } },
          { country: { contains: location, mode: 'insensitive' } },
          { region: { contains: location, mode: 'insensitive' } },
          {
            productContent: {
              path: ['meetingPoint', 'address'],
              string_contains: location
            }
          }
        ]
      });
    }
    
    if (city) {
      andConditions.push({ city: { equals: city, mode: 'insensitive' } });
    }
    
    if (country) {
      andConditions.push({ country: { equals: country, mode: 'insensitive' } });
    }
    
    if (region) {
      andConditions.push({ region: { equals: region, mode: 'insensitive' } });
    }
  }

  // ================================
  // PRICE FILTERS
  // ================================
  
  if (minPrice || maxPrice || priceRange) {
    const priceFilter = buildPriceFilter(minPrice, maxPrice, priceRange, currency);
    if (priceFilter) {
      andConditions.push(priceFilter);
    }
  }

  // ================================
  // RATING & REVIEW FILTERS
  // ================================
  
  if (minRating) {
    where.averageRating = { gte: parseFloat(minRating) };
  }
  
  if (minReviews) {
    where.reviewCount = { gte: parseInt(minReviews) };
  }

  // ================================
  // DURATION FILTERS
  // ================================
  
  if (minDuration || maxDuration || durationType) {
    const durationFilter = buildDurationFilter(minDuration, maxDuration, durationType);
    if (durationFilter) {
      andConditions.push(durationFilter);
    }
  }

  // ================================
  // AVAILABILITY FILTERS
  // ================================
  
  if (availableDate) {
    andConditions.push({
      schedulesAndPricing: {
        path: ['availability', 'startDate'],
        lte: availableDate
      }
    });
    
    andConditions.push({
      schedulesAndPricing: {
        path: ['availability', 'endDate'],
        gte: availableDate
      }
    });
  }
  
  if (dayOfWeek) {
    andConditions.push({
      schedulesAndPricing: {
        path: ['availability', 'daysOfWeek'],
        array_contains: dayOfWeek
      }
    });
  }

  // ================================
  // FEATURE FILTERS
  // ================================
  
  if (instantConfirmation === 'true') {
    andConditions.push({
      bookingAndTickets: {
        path: ['instantConfirmation'],
        equals: true
      }
    });
  }
  
  if (freeCancellation === 'true') {
    andConditions.push({
      bookingAndTickets: {
        path: ['cancellationPolicy', 'type'],
        equals: 'flexible'
      }
    });
  }

  // ================================
  // SEARCH FILTERS
  // ================================
  
  if (search) {
    andConditions.push({
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { tags: { has: search } }
      ]
    });
  }
  
  if (tags) {
    const tagArray = Array.isArray(tags) ? tags : tags.split(',');
    andConditions.push({
      tags: {
        hasSome: tagArray
      }
    });
  }

  // ================================
  // SUPPLIER FILTERS
  // ================================
  
  if (supplierId) {
    where.supplierId = supplierId;
  }

  // ================================
  // COMBINE ALL CONDITIONS
  // ================================
  
  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}

/**
 * Build price filter based on range or specific values
 */
function buildPriceFilter(minPrice, maxPrice, priceRange) {
  // Define price ranges
  const priceRanges = {
    budget: { min: 0, max: 50 },
    moderate: { min: 50, max: 150 },
    luxury: { min: 150, max: 999999 }
  };

  let min = minPrice ? parseFloat(minPrice) : null;
  let max = maxPrice ? parseFloat(maxPrice) : null;

  // Apply predefined range if specified
  if (priceRange && priceRanges[priceRange]) {
    min = min || priceRanges[priceRange].min;
    max = max || priceRanges[priceRange].max;
  }

  if (!min && !max) return null;

  // Build filter for adult price in pricing schedules
  const conditions = [];

  if (min !== null) {
    conditions.push({
      schedulesAndPricing: {
        path: ['pricing', 'adult'],
        gte: min
      }
    });
  }

  if (max !== null) {
    conditions.push({
      schedulesAndPricing: {
        path: ['pricing', 'adult'],
        lte: max
      }
    });
  }

  return conditions.length > 0 ? { AND: conditions } : null;
}

/**
 * Build duration filter
 */
function buildDurationFilter(minDuration, maxDuration, durationType = 'hours') {
  const conditions = [];

  // Convert hours/days to minutes for column comparison
  const toMinutes = (val) => {
    const n = parseInt(val);
    return durationType === 'days' ? n * 1440 : n * 60;
  };

  if (minDuration) {
    conditions.push({ durationMinutes: { gte: toMinutes(minDuration) } });
  }

  if (maxDuration) {
    conditions.push({ durationMinutes: { lte: toMinutes(maxDuration) } });
  }

  return conditions.length > 0 ? { AND: conditions } : null;
}

/**
 * Build sort options from query parameters
 */
function buildSortOptions(sortBy = 'createdAt', sortOrder = 'desc') {
  const validSortFields = {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    title: 'title',
    price: 'schedulesAndPricing', // Special handling needed
    rating: 'averageRating',
    reviews: 'reviewCount',
    bookings: 'totalBookings',
    popularity: 'viewCount',
    relevance: 'createdAt', // Re-ranked by FTS in controller
    nearest: 'createdAt'    // Re-ranked by geo in controller
  };

  const field = validSortFields[sortBy] || 'createdAt';
  const order = sortOrder === 'asc' ? 'asc' : 'desc';

  return { [field]: order };
}

/**
 * Get available filter options (for filter UI)
 */
async function getAvailableFilterOptions(prisma) {
  try {
    // Get unique categories, themes, and locations from active tours
    const tours = await prisma.tour.findMany({
      where: { status: 'ACTIVE' },
      select: {
        category: true,
        subcategory: true,
        activityType: true,
        primaryTheme: true,
        tags: true,
        city: true,
        country: true,
        region: true,
        secondaryThemes: { select: { theme: true } },
      }
    });

    const categories = new Set();
    const subcategories = new Set();
    const activityTypes = new Set();
    const primaryThemes = new Set();
    const secondaryThemes = new Set();
    const cities = new Set();
    const countries = new Set();
    const regions = new Set();
    const allTags = new Set();

    tours.forEach(tour => {
      // Extract categorization
      if (tour.category) categories.add(tour.category);
      if (tour.subcategory) subcategories.add(tour.subcategory);
      if (tour.activityType) activityTypes.add(tour.activityType);

      // Extract themes
      if (tour.primaryTheme) primaryThemes.add(tour.primaryTheme);
      if (tour.secondaryThemes?.length) {
        tour.secondaryThemes.forEach(st => secondaryThemes.add(st.theme));
      }

      // Extract locations
      if (tour.city) cities.add(tour.city);
      if (tour.country) countries.add(tour.country);
      if (tour.region) regions.add(tour.region);

      // Extract tags
      if (tour.tags && Array.isArray(tour.tags)) {
        tour.tags.forEach(tag => allTags.add(tag));
      }
    });

    return {
      categories: Array.from(categories).sort(),
      subcategories: Array.from(subcategories).sort(),
      activityTypes: Array.from(activityTypes).sort(),
      themes: {
        primary: Array.from(primaryThemes).sort(),
        secondary: Array.from(secondaryThemes).sort()
      },
      locations: {
        cities: Array.from(cities).sort(),
        countries: Array.from(countries).sort(),
        regions: Array.from(regions).sort()
      },
      tags: Array.from(allTags).sort(),
      priceRanges: [
        { label: 'Budget', value: 'budget', range: '$0 - $50' },
        { label: 'Moderate', value: 'moderate', range: '$50 - $150' },
        { label: 'Luxury', value: 'luxury', range: '$150+' }
      ],
      durations: [
        { label: 'Short (< 3 hours)', value: 'short', hours: { max: 3 } },
        { label: 'Half Day (3-6 hours)', value: 'half-day', hours: { min: 3, max: 6 } },
        { label: 'Full Day (6-12 hours)', value: 'full-day', hours: { min: 6, max: 12 } },
        { label: 'Multi-Day', value: 'multi-day', days: { min: 1 } }
      ]
    };
  } catch (error) {
    console.error('❌ Get filter options failed:', error);
    return null;
  }
}

/**
 * Validate filter parameters
 */
function validateFilterParams(queryParams) {
  const errors = [];

  // Validate price range
  if (queryParams.minPrice && isNaN(parseFloat(queryParams.minPrice))) {
    errors.push('minPrice must be a valid number');
  }
  if (queryParams.maxPrice && isNaN(parseFloat(queryParams.maxPrice))) {
    errors.push('maxPrice must be a valid number');
  }
  if (queryParams.minPrice && queryParams.maxPrice) {
    if (parseFloat(queryParams.minPrice) > parseFloat(queryParams.maxPrice)) {
      errors.push('minPrice cannot be greater than maxPrice');
    }
  }

  // Validate rating
  if (queryParams.minRating) {
    const rating = parseFloat(queryParams.minRating);
    if (isNaN(rating) || rating < 0 || rating > 5) {
      errors.push('minRating must be between 0 and 5');
    }
  }

  // Validate geo params
  if (queryParams.lat !== undefined || queryParams.lng !== undefined) {
    const lat = parseFloat(queryParams.lat);
    const lng = parseFloat(queryParams.lng);
    if (isNaN(lat) || lat < -90 || lat > 90) errors.push('lat must be a number between -90 and 90');
    if (isNaN(lng) || lng < -180 || lng > 180) errors.push('lng must be a number between -180 and 180');
    if (queryParams.radius && (isNaN(parseFloat(queryParams.radius)) || parseFloat(queryParams.radius) <= 0)) {
      errors.push('radius must be a positive number');
    }
  }

  // Validate pagination
  if (queryParams.page && (isNaN(parseInt(queryParams.page)) || parseInt(queryParams.page) < 1)) {
    errors.push('page must be a positive integer');
  }
  if (queryParams.limit && (isNaN(parseInt(queryParams.limit)) || parseInt(queryParams.limit) < 1)) {
    errors.push('limit must be a positive integer');
  }

  // Validate sort order
  if (queryParams.sortOrder && !['asc', 'desc'].includes(queryParams.sortOrder)) {
    errors.push('sortOrder must be either "asc" or "desc"');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Find tour IDs within a radius of a point using PostGIS ST_DWithin
 * @param {Object} prisma - Prisma client
 * @param {number} lat - Center latitude
 * @param {number} lng - Center longitude
 * @param {number} radiusKm - Search radius in kilometers (default 50)
 * @returns {Promise<string[]>} Array of tour IDs within radius
 */
async function findNearbyTourIds(prisma, lat, lng, radiusKm = 50) {
  const radiusMeters = radiusKm * 1000;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE location_geom IS NOT NULL AND ST_DWithin(
        location_geom,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )`,
      lng, lat, radiusMeters
    );
    return rows.map(r => r.id);
  } catch {
    return [];
  }
}

/**
 * Get distances for a list of tour IDs from a point
 * @param {Object} prisma - Prisma client
 * @param {number} lat - Origin latitude
 * @param {number} lng - Origin longitude
 * @param {string[]} tourIds - Array of tour IDs
 * @returns {Promise<Map<string, number>>} Map of tourId -> distance in km
 */
async function getTourDistances(prisma, lat, lng, tourIds) {
  if (!tourIds.length) return new Map();
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, ST_DistanceSphere(
        location_geom::geometry,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)
      ) / 1000.0 AS distance_km
      FROM "Tour"
      WHERE id = ANY($3) AND location_geom IS NOT NULL`,
      lng, lat, tourIds
    );
    return new Map(rows.map(r => [r.id, Math.round(parseFloat(r.distance_km) * 10) / 10]));
  } catch {
    return new Map();
  }
}

module.exports = {
  buildTourFilters,
  buildSortOptions,
  getAvailableFilterOptions,
  validateFilterParams,
  findNearbyTourIds,
  getTourDistances
};
