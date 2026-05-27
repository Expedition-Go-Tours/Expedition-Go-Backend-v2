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

    const optimizedTours = tours.map((tour) => {
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

  // Get uploaded Cloudinary URLs from multer
  const uploadedPhotos = (req.files || []).map(f => f.path);
  const allPhotos = [...photos, ...uploadedPhotos];

  // Determine cover photo from uploaded files
  let finalCoverPhoto = coverPhoto;
  if (uploadedPhotos.length > 0 && req.body.coverPhotoIndex !== undefined) {
    const idx = parseInt(req.body.coverPhotoIndex);
    if (!isNaN(idx) && idx >= 0 && idx < uploadedPhotos.length) {
      finalCoverPhoto = uploadedPhotos[idx];
    }
  }
  if (!finalCoverPhoto && allPhotos.length > 0) {
    finalCoverPhoto = allPhotos[0];
  }

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
      photos: allPhotos,
      coverPhoto: finalCoverPhoto,
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
        create: [...new Set(parsedTheme?.secondary || [])].map(t => ({ theme: t })),
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

  // Explicitly extract only known Prisma model fields — prevents non-model fields
  // (existingPhotos, coverPhotoIndex, etc.) from reaching Prisma and causing
  // PrismaClientValidationError
  const {
    title, description, metaTitle, metaDescription,
    productContent, schedulesAndPricing, bookingAndTickets,
    coverPhoto, tags, status, latitude, longitude
  } = req.body;

  const updateData = {};
  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;
  if (metaTitle !== undefined) updateData.metaTitle = metaTitle;
  if (metaDescription !== undefined) updateData.metaDescription = metaDescription;
  if (productContent !== undefined) updateData.productContent = productContent;
  if (schedulesAndPricing !== undefined) updateData.schedulesAndPricing = schedulesAndPricing;
  if (bookingAndTickets !== undefined) updateData.bookingAndTickets = bookingAndTickets;
  if (coverPhoto !== undefined) updateData.coverPhoto = coverPhoto;
  if (tags !== undefined) updateData.tags = tags;
  if (status !== undefined) updateData.status = status;
  if (latitude !== undefined) updateData.latitude = latitude;
  if (longitude !== undefined) updateData.longitude = longitude;

  // Handle uploaded photos from multer
  const uploadedPhotos = (req.files || []).map(f => f.path);
  if (uploadedPhotos.length > 0 || req.body.existingPhotos) {
    // existingPhotos is already parsed by parseJsonFields inside validateTourData
    const keptPhotos = req.body.existingPhotos || (existingTour.photos || []);
    const newPhotos = [...keptPhotos, ...uploadedPhotos];

    // Delete removed photos from Cloudinary
    const oldPhotos = existingTour.photos || [];
    const removed = oldPhotos.filter(url => !newPhotos.includes(url));
    await Promise.all(removed.map(url => deleteCloudinaryImage(url)));

    updateData.photos = newPhotos;

    if (req.body.coverPhotoIndex !== undefined) {
      const idx = parseInt(req.body.coverPhotoIndex);
      if (!isNaN(idx) && idx >= 0 && idx < uploadedPhotos.length) {
        updateData.coverPhoto = uploadedPhotos[idx];
      }
    }
  }

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
      create: [...new Set(th.secondary || [])].map(t => ({ theme: t })),
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

  const optimizedTours = tours.map(tour => ({
    ...tour,
    photos: Array.isArray(tour.photos)
      ? tour.photos.map(url => cloudinaryUrl(url, 800))
      : tour.photos,
    coverPhoto: tour.coverPhoto ? cloudinaryUrl(tour.coverPhoto, 800) : null,
  }));

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      tours: optimizedTours,
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

/**
 * Delete a specific photo from a tour (suppliers only - own tours)
 */
exports.deleteTourPhoto = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.user.id;
  const { photoUrl } = req.body;

  if (!photoUrl) {
    return next(new AppError('Photo URL is required', 400));
  }

  // Find tour and verify ownership
  const tour = await prisma.tour.findFirst({
    where: { id, supplierId },
    select: { id: true, photos: true, coverPhoto: true, title: true }
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  // Check if photo exists in the tour's photos array
  if (!tour.photos || !tour.photos.includes(photoUrl)) {
    return next(new AppError('Photo not found in this tour', 404));
  }

  // Delete from Cloudinary
  await deleteCloudinaryImage(photoUrl);

  // Remove the photo URL from the array
  const updatedPhotos = tour.photos.filter(url => url !== photoUrl);

  // If the deleted photo was the coverPhoto, clear it
  const updateData = { photos: updatedPhotos };
  if (tour.coverPhoto === photoUrl) {
    updateData.coverPhoto = null;
  }

  await prisma.tour.update({
    where: { id },
    data: updateData
  });

  cache.invalidateTourCaches(id).catch(() => {});

  await logActivity({
    userId: supplierId,
    action: 'tour.photo.deleted',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: { title: tour.title, photoUrl }
  });

  res.status(200).json({
    status: 'success',
    message: 'Photo deleted successfully',
    data: { photos: updatedPhotos, coverPhoto: updateData.coverPhoto }
  });
});

/**
 * Seed a simulated tour for development/testing
 */
exports.seedTour = catchAsync(async (req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return next(new AppError('Seed endpoint is only available in development mode', 403));
  }

  const userId = req.user.id;

  let supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId }
  });

  if (!supplierProfile) {
    supplierProfile = await prisma.supplierProfile.create({
      data: {
        userId,
        status: 'ACTIVE',
        businessInfo: {
          legalBusinessName: 'Seed Tours Ltd',
          businessType: 'Tour Operator',
          registrationNumber: 'SEED-001',
          taxId: 'TAX-SEED-001',
          country: 'Ghana',
          city: 'Accra',
          phone: '+233500000000',
          website: 'https://seed-tours.example.com'
        },
        operatingInfo: {
          regions: ['West Africa', 'East Africa'],
          hours: { monday: '09:00-17:00', tuesday: '09:00-17:00' }
        },
        representativeInfo: {
          fullName: req.user.name || 'Seed User',
          email: req.user.email || 'seed@example.com',
          phone: '+233500000000'
        },
        businessDocuments: {},
        payoutInfo: {},
        compliance: {
          acceptedTerms: true,
          agreedToPayoutTerms: true,
          verified: true,
          reviewStatus: 'APPROVED'
        }
      }
    });
  }

  if (supplierProfile.status !== 'ACTIVE') {
    supplierProfile = await prisma.supplierProfile.update({
      where: { userId },
      data: { status: 'ACTIVE' }
    });
  }

  const now = new Date();
  const futureDate = new Date(now);
  futureDate.setMonth(futureDate.getMonth() + 6);

  const title = `Simulated Tour ${Date.now()}`;
  const slug = await createSlug(title);

  const seedData = {
    title,
    description: 'This is a simulated tour created for development and testing purposes. It includes all required fields and demonstrates the tour creation flow. The tour covers various attractions and offers a comprehensive experience.',
    categorization: {
      category: 'Cultural',
      subcategory: 'Walking Tours',
      activityType: 'Guided Tour',
      difficulty: 'Easy',
      duration: { hours: 3 },
      transportMode: { land: ['Walking', '4x4/Jeep'], air: ['Plane'] }
    },
    theme: {
      primary: 'Nature & Wildlife',
      secondary: ['Photography', 'Adventure', 'Cultural']
    },
    productContent: {
      highlights: [
        'Visit local markets and cultural sites',
        'Guided nature walk through scenic trails',
        'Traditional cooking experience',
        'Photo opportunities at viewpoints'
      ],
      included: ['Professional guide', 'Bottled water', 'All fees and taxes'],
      excluded: ['Hotel pickup and drop-off', 'Personal expenses', 'Gratuities'],
      whatToBring: ['Comfortable walking shoes', 'Camera', 'Sunscreen', 'Hat'],
      accessibility: 'Not wheelchair accessible',
      restrictions: 'Moderate walking required (approx 2km)',
      location: {
        city: 'Accra',
        country: 'Ghana',
        region: 'Greater Accra',
        address: 'Independence Square, Accra, Ghana'
      }
    },
    schedulesAndPricing: {
      travelerDetails: {
        pricingModel: 'perPerson',
        maxTravelersPerBooking: 15,
        ageGroups: [
          { label: 'Adult', minAge: 13, maxAge: 99 },
          { label: 'Child', minAge: 6, maxAge: 12 },
          { label: 'Infant', minAge: 0, maxAge: 5 }
        ]
      },
      pricingSchedules: {
        currency: 'USD',
        schedules: [
          {
            startDate: now.toISOString().split('T')[0],
            endDate: futureDate.toISOString().split('T')[0],
            prices: [
              { ageGroup: 'Adult', retailPrice: 75.00 },
              { ageGroup: 'Child', retailPrice: 45.00 },
              { ageGroup: 'Infant', retailPrice: 0.00 }
            ]
          }
        ]
      },
      availability: {
        daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        timeSlots: ['09:00', '14:00']
      }
    },
    bookingAndTickets: {
      confirmationType: 'INSTANT',
      cancellationPolicy: 'Free cancellation up to 24 hours before start time',
      meetingPoint: {
        type: 'meeting_point',
        address: 'Independence Square, Accra, Ghana',
        coordinates: { lat: 5.6037, lng: -0.1870 },
        instructions: 'Meet at the main entrance near the flag pole'
      },
      checkInProcess: 'Please arrive 15 minutes before tour start time'
    },
    tags: ['simulated', 'test', 'development', 'guided-tour', 'cultural'],
    latitude: 5.6037,
    longitude: -0.1870,
    status: 'ACTIVE'
  };

  const tour = await prisma.tour.create({
    data: {
      supplierId: userId,
      slug,
      title: seedData.title,
      description: seedData.description,
      categorization: seedData.categorization,
      theme: seedData.theme,
      productContent: seedData.productContent,
      schedulesAndPricing: seedData.schedulesAndPricing,
      bookingAndTickets: seedData.bookingAndTickets,
      tags: seedData.tags,
      status: seedData.status,
      latitude: seedData.latitude,
      longitude: seedData.longitude,
      photos: [],
      city: seedData.productContent.location.city,
      country: seedData.productContent.location.country,
      region: seedData.productContent.location.region,
      category: seedData.categorization.category,
      subcategory: seedData.categorization.subcategory,
      activityType: seedData.categorization.activityType,
      difficulty: seedData.categorization.difficulty,
      durationMinutes: seedData.categorization.duration.hours * 60,
      primaryTheme: seedData.theme.primary,
      secondaryThemes: {
        create: seedData.theme.secondary.map(t => ({ theme: t }))
      }
    },
    include: {
      supplier: {
        select: { id: true, name: true, photoURL: true }
      }
    }
  });

  cache.invalidateTourCaches().catch(() => {});

  await logActivity({
    userId,
    action: 'tour.seeded',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: { title: tour.title, status: tour.status }
  });

  res.status(201).json({
    status: 'success',
    message: 'Simulated tour created successfully',
    data: { tour }
  });
});

module.exports = exports;