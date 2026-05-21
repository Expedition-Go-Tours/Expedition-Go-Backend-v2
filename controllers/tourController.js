/**
 * Tour Controller - Production Ready
 * Handles tour CRUD operations, search, filtering, and analytics
 * 
 * Features:
 * - Tour creation/management (suppliers only)
 * - Public tour browsing and search
 * - Tour analytics and statistics
 * - Image upload integration with Cloudinary
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { deleteCloudinaryImage } = require('../utils/cloudinaryHelper');
const { createSlug, validateTourData } = require('../utils/tourHelpers');
const { logActivity } = require('../utils/auditLogger');
const { cloudinaryUrl } = require('../utils/imageOptimizer');
const { 
  buildTourFilters, 
  buildSortOptions, 
  getAvailableFilterOptions,
  validateFilterParams,
  findNearbyTourIds,
  getTourDistances
} = require('../utils/tourFilterBuilder');
const { getPopularByCategory } = require('../utils/popularityScorer');
const { rankTourIdsBySearch } = require('../utils/fullTextSearch');
const cache = require('../utils/cacheHelper');
const crypto = require('crypto');
const event = require('../utils/eventEmitter');

// ================================
// PUBLIC TOUR ENDPOINTS
// ================================

/**
 * Get all tours with filtering, sorting, and pagination
 * Public endpoint - no authentication required
 */
exports.getAllTours = catchAsync(async (req, res, next) => {
  const {
    page = 1,
    limit = 12,
    sortBy: rawSortBy,
    sortOrder = 'desc',
    lat, lng, radius, search
  } = req.query;

  const sortBy = search && !rawSortBy ? 'relevance' : (rawSortBy || 'createdAt');

  const validation = validateFilterParams(req.query);
  if (!validation.isValid) {
    return next(new AppError(`Invalid filters: ${validation.errors.join(', ')}`, 400));
  }

  const hasGeo = lat && lng;
  const cacheKey = 'tours:list:' + crypto.createHash('md5').update(JSON.stringify(req.query)).digest('hex');

  const result = await cache.getOrSet(cacheKey, async () => {
    const where = buildTourFilters(req.query);
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Apply geo-spatial filter
    if (hasGeo) {
      const nearbyIds = await findNearbyTourIds(prisma, parseFloat(lat), parseFloat(lng), parseFloat(radius) || 50);
      if (nearbyIds.length === 0) {
        const totalPages = Math.ceil(0 / parseInt(limit));
        return {
          status: 'success',
          data: {
            tours: [],
            pagination: {
              currentPage: parseInt(page), totalPages, totalCount: 0,
              hasNextPage: false, hasPrevPage: false, limit: parseInt(limit)
            },
            appliedFilters: {
              category: req.query.category, theme: req.query.theme,
              location: req.query.location, priceRange: req.query.priceRange,
              minRating: req.query.minRating, search: req.query.search,
              geo: { lat: parseFloat(lat), lng: parseFloat(lng), radiusKm: parseFloat(radius) || 50 }
            }
          }
        };
      }
      where.id = { in: nearbyIds };
    }

    const orderBy = sortBy === 'nearest' && hasGeo ? { createdAt: 'desc' } : buildSortOptions(sortBy, sortOrder);

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

    // Compute distances for geo queries
    let distMap = new Map();
    if (hasGeo) {
      distMap = await getTourDistances(prisma, parseFloat(lat), parseFloat(lng), tours.map(t => t.id));
    }

    let optimizedTours = tours.map((tour) => {
      const t = {
        ...tour,
        photos: Array.isArray(tour.photos)
          ? tour.photos.map((url) => cloudinaryUrl(url, 800))
          : tour.photos,
        coverPhoto: tour.coverPhoto ? cloudinaryUrl(tour.coverPhoto, 800) : null,
        supplier: {
          ...tour.supplier,
          photoURL: tour.supplier.photoURL
            ? cloudinaryUrl(tour.supplier.photoURL, 150)
            : tour.supplier.photoURL,
        },
      };
      if (hasGeo) {
        t.distanceKm = distMap.get(tour.id) || null;
      }
      return t;
    });

    // Sort by nearest in application code
    if (sortBy === 'nearest' && hasGeo) {
      optimizedTours.sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
    }

    // Re-rank by full-text search relevance
    if (sortBy === 'relevance' && search) {
      const orderedIds = await rankTourIdsBySearch(search, optimizedTours.map(t => t.id));
      const idOrder = new Map(orderedIds.map((id, i) => [id, i]));
      optimizedTours.sort((a, b) => (idOrder.get(a.id) ?? Infinity) - (idOrder.get(b.id) ?? Infinity));
    }

    const totalPages = Math.ceil(totalCount / parseInt(limit));
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    const response = {
      status: 'success',
      data: {
        tours: optimizedTours,
        pagination: {
          currentPage: parseInt(page), totalPages, totalCount,
          hasNextPage, hasPrevPage, limit: parseInt(limit)
        },
        appliedFilters: {
          category: req.query.category, theme: req.query.theme,
          location: req.query.location, priceRange: req.query.priceRange,
          minRating: req.query.minRating, search: req.query.search
        }
      }
    };

    if (hasGeo) {
      response.data.appliedFilters.geo = {
        lat: parseFloat(lat), lng: parseFloat(lng), radiusKm: parseFloat(radius) || 50
      };
    }

    return response;
  }, 300);

  res.status(200).json(result);

  // Fire-and-forget search analytics event (never blocks response)
  if (req.query.search || req.query.category || req.query.location || (req.query.lat && req.query.lng)) {
    event.emit({
      name: req.query.search ? 'search.executed' : 'browse.executed',
      userId: req.user?.id,
      req,
      properties: {
        query: req.query.search || null,
        category: req.query.category || null,
        location: req.query.location || null,
        lat: req.query.lat ? parseFloat(req.query.lat) : null,
        lng: req.query.lng ? parseFloat(req.query.lng) : null,
        filters: {
          theme: req.query.theme || null,
          minRating: req.query.minRating ? parseFloat(req.query.minRating) : null,
          priceRange: req.query.priceRange || null,
          tags: req.query.tags?.split(',') || null,
        },
        resultCount: result?.data?.pagination?.totalCount || 0,
        sortBy: req.query.sortBy || 'createdAt',
      },
    });
  }
});


/**
 * Get available filter options
 * Public endpoint - returns all available filter values for UI
 */
exports.getFilterOptions = catchAsync(async (req, res, next) => {
  const result = await cache.getOrSet('tours:filters:options', async () => {
    const filterOptions = await getAvailableFilterOptions(prisma);

    if (!filterOptions) {
      return null;
    }

    return {
      status: 'success',
      data: { filterOptions }
    };
  }, 3600);

  if (!result) {
    return next(new AppError('Failed to retrieve filter options', 500));
  }

  res.status(200).json(result);
});

/**
 * Get popular tours grouped by category
 * Public endpoint - scored by bookings, rating, reviews, and views
 */
exports.getPopularByCategory = catchAsync(async (req, res, next) => {
  const { perCategory = 6, category: filterCategory, theme } = req.query;
  const limit = Math.min(Math.max(parseInt(perCategory) || 6, 1), 20);

  const result = await cache.getOrSet(cache.TOUR_POPULAR_KEY, async () => {
    const tours = await prisma.tour.findMany({
      where: { status: 'ACTIVE' },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            photoURL: true,
            supplierProfile: {
              select: {
                averageRating: true,
                totalBookings: true,
              },
            },
          },
        },
      },
    });

    let filtered = tours;
    if (filterCategory) {
      filtered = filtered.filter(t => t.categorization?.category === filterCategory);
    }
    if (theme) {
      filtered = filtered.filter(t =>
        t.theme?.primary === theme ||
        (Array.isArray(t.theme?.secondary) && t.theme.secondary.includes(theme))
      );
    }

    const popular = getPopularByCategory(filtered, limit);

    const optimized = {};
    for (const [cat, tours] of Object.entries(popular)) {
      optimized[cat] = tours.map(t => ({
        ...t,
        photos: Array.isArray(t.photos)
          ? t.photos.map(url => cloudinaryUrl(url, 800))
          : t.photos,
        coverPhoto: t.coverPhoto ? cloudinaryUrl(t.coverPhoto, 800) : null,
        supplier: {
          ...t.supplier,
          photoURL: t.supplier.photoURL
            ? cloudinaryUrl(t.supplier.photoURL, 150)
            : t.supplier.photoURL,
        },
      }));
    }

    return {
      status: 'success',
      data: {
        categories: optimized,
        weights: {
          bookings: 0.40,
          rating: 0.25,
          reviews: 0.20,
          views: 0.15,
        },
      },
    };
  }, 300);

  res.status(200).json(result);
});

/**
 * Get single tour by ID or slug
 * Public endpoint with view tracking
 */
exports.getTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const result = await cache.getOrSet(cache.TOUR_DETAIL_PREFIX(id), async () => {
    const tour = await prisma.tour.findFirst({
      where: {
        OR: [
          { id },
          { slug: id }
        ],
        status: 'ACTIVE'
      },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            photoURL: true,
            supplierProfile: {
              select: {
                averageRating: true,
                totalBookings: true,
                businessInfo: true
              }
            }
          }
        },
        reviews: {
          where: { status: 'APPROVED' },
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                photoURL: true
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 10
        },
        _count: {
          select: {
            reviews: true,
            bookings: true
          }
        }
      }
    });

    if (!tour) return null;

    return {
      ...tour,
      photos: Array.isArray(tour.photos)
        ? tour.photos.map((url) => cloudinaryUrl(url, 1400))
        : tour.photos,
      coverPhoto: tour.coverPhoto ? cloudinaryUrl(tour.coverPhoto, 1400) : null,
    };
  }, 300);

  if (!result) {
    return next(new AppError('Tour not found', 404));
  }

  prisma.tour.update({
    where: { id: result.id },
    data: { viewCount: { increment: 1 } }
  }).catch(console.error);

  event.emit({ name: 'tour.viewed', userId: req.user?.id, req, resource: 'Tour', resourceId: result.id });

  res.status(200).json({
    status: 'success',
    data: { tour: result }
  });
});

// ================================
// SUPPLIER TOUR MANAGEMENT
// ================================

/**
 * Create new tour (suppliers only)
 */
exports.createTour = catchAsync(async (req, res, next) => {
  const supplierId = req.user.id;

  // Verify supplier is active
  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: supplierId }
  });

  if (!supplierProfile || supplierProfile.status !== 'ACTIVE') {
    return next(new AppError('Only active suppliers can create tours', 403));
  }

  // Block publishing without a verified payout method
  if (req.body.status === 'PUBLISHED') {
    const hasVerifiedMethod = await prisma.payoutMethod.findFirst({
      where: { supplierId, verified: true }
    });
    if (!hasVerifiedMethod) {
      return next(new AppError('You must add and verify at least one payout method before publishing tours', 400));
    }
  }

  // Validate tour data
  const validationResult = validateTourData(req.body);
  if (!validationResult.isValid) {
    return next(new AppError(`Validation failed: ${validationResult.errors.join(', ')}`, 400));
  }

  const {
    title,
    description,
    metaTitle,
    metaDescription,
    categorization,
    theme,
    productContent,
    schedulesAndPricing,
    bookingAndTickets,
    photos = [],
    coverPhoto,
    tags = [],
    status = 'DRAFT',
    latitude,
    longitude
  } = req.body;

  const slug = await createSlug(title);

  const parsedCategory = typeof categorization === 'string' ? JSON.parse(categorization) : categorization;
  const parsedTheme = typeof theme === 'string' ? JSON.parse(theme) : theme;

  const tour = await prisma.tour.create({
    data: {
      supplierId,
      title,
      description,
      slug,
      categorization: parsedCategory,
      theme: parsedTheme,
      productContent,
      schedulesAndPricing,
      bookingAndTickets,
      metaTitle,
      metaDescription,
      photos,
      coverPhoto: coverPhoto || (photos.length > 0 ? photos[0] : null),
      tags,
      status,
      latitude,
      longitude,
      city: productContent?.location?.city || null,
      country: productContent?.location?.country || null,
      region: productContent?.location?.region || null,
      category: parsedCategory?.category || null,
      subcategory: parsedCategory?.subcategory || null,
      activityType: parsedCategory?.activityType || null,
      difficulty: parsedCategory?.difficulty || null,
      durationMinutes: (() => {
        const d = parsedCategory?.duration;
        if (!d) return null;
        if (d.hours != null) return d.hours * 60;
        if (d.days != null) return d.days * 1440;
        if (d.weeks != null) return d.weeks * 10080;
        if (d.minutes != null) return d.minutes;
        return null;
      })(),
      primaryTheme: parsedTheme?.primary || null,
      secondaryThemes: {
        create: (parsedTheme?.secondary || []).map(t => ({ theme: t })),
      },
    },
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          photoURL: true
        }
      }
    }
  });

  cache.invalidateTourCaches().catch(() => {});

  await logActivity({
    userId: supplierId,
    action: 'tour.created',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: { title, status }
  });

  res.status(201).json({
    status: 'success',
    data: { tour }
  });
});

/**
 * Update tour (suppliers only - own tours)
 */
exports.updateTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.user.id;

  // Find tour and verify ownership
  const existingTour = await prisma.tour.findFirst({
    where: {
      id,
      supplierId
    }
  });

  if (!existingTour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  // Block publishing without a verified payout method
  if (req.body.status === 'PUBLISHED' && existingTour.status !== 'PUBLISHED') {
    const hasVerifiedMethod = await prisma.payoutMethod.findFirst({
      where: { supplierId, verified: true }
    });
    if (!hasVerifiedMethod) {
      return next(new AppError('You must add and verify at least one payout method before publishing tours', 400));
    }
  }

  // Validate update data
  const validationResult = validateTourData(req.body, true); // partial validation
  if (!validationResult.isValid) {
    return next(new AppError(`Validation failed: ${validationResult.errors.join(', ')}`, 400));
  }

  const updateData = { ...req.body };

  // Update slug if title changed
  if (req.body.title && req.body.title !== existingTour.title) {
    updateData.slug = await createSlug(req.body.title);
  }

  // Handle categorization normalization (supports both JSON string and parsed object from multipart form)
  if (req.body.categorization) {
    const cat = typeof req.body.categorization === 'string'
      ? JSON.parse(req.body.categorization)
      : req.body.categorization;
    updateData.category = cat.category || null;
    updateData.subcategory = cat.subcategory || null;
    updateData.activityType = cat.activityType || null;
    updateData.difficulty = cat.difficulty || null;
    updateData.durationMinutes = (() => {
      const d = cat.duration;
      if (!d) return null;
      if (d.hours != null) return d.hours * 60;
      if (d.days != null) return d.days * 1440;
      if (d.weeks != null) return d.weeks * 10080;
      if (d.minutes != null) return d.minutes;
      return null;
    })();
    // Keep the original JSON field as-is
    updateData.categorization = cat;
  }

  // Handle theme normalization
  if (req.body.theme) {
    const th = typeof req.body.theme === 'string' ? JSON.parse(req.body.theme) : req.body.theme;
    updateData.primaryTheme = th.primary || null;
    // Keep the original JSON field as-is
    updateData.theme = th;
    // Replace secondary themes: delete all existing, re-create
    updateData.secondaryThemes = {
      deleteMany: {},
      create: (th.secondary || []).map(t => ({ theme: t })),
    };
  }

  // Auto-extract location fields from productContent if not sent as top-level fields
  const pc = req.body.productContent;
  if (pc?.location) {
    if (req.body.city === undefined) updateData.city = pc.location.city || null;
    if (req.body.country === undefined) updateData.country = pc.location.country || null;
    if (req.body.region === undefined) updateData.region = pc.location.region || null;
  }

  const tour = await prisma.tour.update({
    where: { id },
    data: updateData,
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          photoURL: true
        }
      }
    }
  });

  cache.invalidateTourCaches(id).catch(() => {});

  await logActivity({
    userId: supplierId,
    action: 'tour.updated',
    resource: 'Tour',
    resourceId: tour.id,
    oldValues: existingTour,
    newValues: tour
  });

  res.status(200).json({
    status: 'success',
    data: { tour }
  });
});

/**
 * Delete tour (suppliers only - own tours)
 */
exports.deleteTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.user.id;

  // Find tour and verify ownership
  const tour = await prisma.tour.findFirst({
    where: {
      id,
      supplierId
    },
    include: {
      bookings: {
        where: {
          status: {
            in: ['PENDING', 'CONFIRMED']
          }
        }
      }
    }
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  // Check for active bookings
  if (tour.bookings.length > 0) {
    return next(new AppError('Cannot delete tour with active bookings', 400));
  }

  // Delete associated images from Cloudinary
  if (tour.photos && tour.photos.length > 0) {
    for (const photoUrl of tour.photos) {
      await deleteCloudinaryImage(photoUrl);
    }
  }

  // Soft delete by setting status to ARCHIVED
  await prisma.tour.update({
    where: { id },
    data: { status: 'ARCHIVED' }
  });

  cache.invalidateTourCaches(id).catch(() => {});

  await logActivity({
    userId: supplierId,
    action: 'tour.deleted',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: { title: tour.title }
  });

  res.status(204).json({
    status: 'success',
    data: null
  });
});

/**
 * Get supplier's own tours
 */
exports.getMyTours = catchAsync(async (req, res, next) => {
  const supplierId = req.user.id;
  const { status, page = 1, limit = 10 } = req.query;

  const where = { supplierId };
  if (status) {
    where.status = status;
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [tours, totalCount] = await Promise.all([
    prisma.tour.findMany({
      where,
      include: {
        _count: {
          select: {
            reviews: true,
            bookings: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.tour.count({ where })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      tours,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      }
    }
  });
});

// ================================
// TOUR ANALYTICS
// ================================

/**
 * Get tour analytics (suppliers only - own tours)
 */
exports.getTourAnalytics = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.user.id;

  // Verify ownership
  const tour = await prisma.tour.findFirst({
    where: {
      id,
      supplierId
    }
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  // Get analytics data
  const [
    bookingStats,
    revenueStats,
    reviewStats,
    monthlyBookings
  ] = await Promise.all([
    // Booking statistics
    prisma.booking.groupBy({
      by: ['status'],
      where: { tourId: id },
      _count: true
    }),
    
    // Revenue statistics
    prisma.booking.aggregate({
      where: {
        tourId: id,
        status: 'CONFIRMED'
      },
      _sum: {
        total: true,
        supplierPayout: true
      },
      _avg: {
        total: true
      }
    }),
    
    // Review statistics
    prisma.review.aggregate({
      where: { tourId: id },
      _avg: {
        rating: true
      },
      _count: true
    }),
    
    // Monthly bookings trend (last 12 months)
    prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('month', "selectedDate") as month,
        COUNT(*) as bookings,
        SUM("total") as revenue
      FROM "Booking" 
      WHERE "tourId" = ${id} 
        AND "selectedDate" >= NOW() - INTERVAL '12 months'
        AND "status" = 'CONFIRMED'
      GROUP BY DATE_TRUNC('month', "selectedDate")
      ORDER BY month DESC
    `
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      bookingStats,
      revenueStats,
      reviewStats,
      monthlyBookings,
      tour: {
        id: tour.id,
        title: tour.title,
        viewCount: tour.viewCount
      }
    }
  });
});

module.exports = exports;