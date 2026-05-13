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
    const categorizationFilter = {};
    
    if (category) {
      categorizationFilter.path = ['category'];
      categorizationFilter.equals = category;
      andConditions.push({ categorization: categorizationFilter });
    }
    
    if (subcategory) {
      andConditions.push({
        categorization: {
          path: ['subcategory'],
          equals: subcategory
        }
      });
    }
    
    if (activityType) {
      andConditions.push({
        categorization: {
          path: ['activityType'],
          equals: activityType
        }
      });
    }
  }

  // ================================
  // THEME FILTERS
  // ================================
  
  if (theme || primaryTheme || secondaryTheme) {
    if (primaryTheme) {
      andConditions.push({
        theme: {
          path: ['primary'],
          equals: primaryTheme
        }
      });
    }
    
    if (secondaryTheme) {
      andConditions.push({
        theme: {
          path: ['secondary'],
          array_contains: secondaryTheme
        }
      });
    }
    
    // Generic theme search (searches both primary and secondary)
    if (theme && !primaryTheme && !secondaryTheme) {
      andConditions.push({
        OR: [
          {
            theme: {
              path: ['primary'],
              equals: theme
            }
          },
          {
            theme: {
              path: ['secondary'],
              array_contains: theme
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
      // Search across multiple location fields
      andConditions.push({
        OR: [
          {
            productContent: {
              path: ['location', 'city'],
              string_contains: location
            }
          },
          {
            productContent: {
              path: ['location', 'country'],
              string_contains: location
            }
          },
          {
            productContent: {
              path: ['location', 'region'],
              string_contains: location
            }
          },
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
      andConditions.push({
        productContent: {
          path: ['location', 'city'],
          equals: city
        }
      });
    }
    
    if (country) {
      andConditions.push({
        productContent: {
          path: ['location', 'country'],
          equals: country
        }
      });
    }
    
    if (region) {
      andConditions.push({
        productContent: {
          path: ['location', 'region'],
          equals: region
        }
      });
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
function buildPriceFilter(minPrice, maxPrice, priceRange, currency) {
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

  if (minDuration) {
    conditions.push({
      schedulesAndPricing: {
        path: ['duration', durationType],
        gte: parseInt(minDuration)
      }
    });
  }

  if (maxDuration) {
    conditions.push({
      schedulesAndPricing: {
        path: ['duration', durationType],
        lte: parseInt(maxDuration)
      }
    });
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
    popularity: 'viewCount'
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
        categorization: true,
        theme: true,
        productContent: true,
        tags: true
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
      if (tour.categorization?.category) categories.add(tour.categorization.category);
      if (tour.categorization?.subcategory) subcategories.add(tour.categorization.subcategory);
      if (tour.categorization?.activityType) activityTypes.add(tour.categorization.activityType);

      // Extract themes
      if (tour.theme?.primary) primaryThemes.add(tour.theme.primary);
      if (tour.theme?.secondary && Array.isArray(tour.theme.secondary)) {
        tour.theme.secondary.forEach(t => secondaryThemes.add(t));
      }

      // Extract locations
      if (tour.productContent?.location?.city) cities.add(tour.productContent.location.city);
      if (tour.productContent?.location?.country) countries.add(tour.productContent.location.country);
      if (tour.productContent?.location?.region) regions.add(tour.productContent.location.region);

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

module.exports = {
  buildTourFilters,
  buildSortOptions,
  getAvailableFilterOptions,
  validateFilterParams
};
