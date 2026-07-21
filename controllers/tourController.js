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
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');
const { createSlug, validateTourData } = require('../utils/tourHelpers');
const { productToTour } = require('../utils/productToTour');
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

// In-memory cache for view tracking (prevents duplicate counts)
// Key format: "view:{tourId}:{userId|IP}" -> timestamp
const VIEW_CACHE_MAX = 10000;
const viewTrackingCache = new Map();
const { rankTourIdsBySearch } = require('../utils/fullTextSearch');
const cache = require('../utils/cacheHelper');
const { verifyAccessToken } = require('../config/jwt');
const crypto = require('crypto');
const { enqueueEvent } = require('../utils/queue');
const logger = require('../utils/logger');

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

    // Collect ID constraints from filters that cannot be expressed as Prisma queries
    const idFilters = [];

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
      idFilters.push({ id: { in: nearbyIds } });
    }

    // Apply price filter via raw SQL (JSONB paths into arrays not supported by Prisma)
    const { minPrice, maxPrice, priceRange } = req.query;
    const priceConstraint = await buildPriceIdConstraint(prisma, minPrice, maxPrice, priceRange);
    if (priceConstraint === false) {
      // No results match the price filter
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
          }
        }
      };
    }
    if (priceConstraint !== null) {
      idFilters.push({ id: { in: priceConstraint } });
    }

    // Merge ID constraints into the where clause
    if (idFilters.length > 0) {
      where.AND = [...(where.AND || []), ...idFilters];
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
    enqueueEvent({
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

  // ── Optional auth: check if the requester is the tour owner ──
  let isOwner = false;
  let ownerSupplierId = null;
  if (req.headers.authorization?.startsWith('Bearer ')) {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = verifyAccessToken(token);
      ownerSupplierId = decoded.id;
      const profile = await prisma.supplierProfile.findFirst({
        where: { userId: decoded.id },
        select: { id: true },
      });
      if (profile) {
        isOwner = true;
      } else {
        const user = await prisma.user.findUnique({
          where: { id: decoded.id },
          select: { email: true },
        });
        if (user) {
          const member = await prisma.teamMember.findFirst({
            where: { email: user.email, status: 'ACCEPTED' },
            select: { supplierId: true },
          });
          if (member) {
            isOwner = true;
            ownerSupplierId = member.supplierId;
          }
        }
      }
    } catch {
      // Invalid token — continue as public request
    }
  }

  const cacheKey = isOwner
    ? cache.TOUR_DETAIL_PREFIX(id) + ':owner'
    : cache.TOUR_DETAIL_PREFIX(id);

  const result = await cache.getOrSet(cacheKey, async () => {
    const where = {
      OR: [{ id }, { slug: id }],
    };
    if (isOwner) {
      where.supplierId = ownerSupplierId;
    } else {
      where.status = 'ACTIVE';
    }

    const tour = await prisma.tour.findFirst({
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
        },
        specialOfferTargets: {
          include: {
            specialOffer: true
          }
        }
      }
    });

    if (!tour) return null;

    // Transform specialOfferTargets into a flat specialOffers array
    const specialOffers = (tour.specialOfferTargets || [])
      .map(t => t.specialOffer)
      .filter(Boolean);

    return {
      ...tour,
      photos: Array.isArray(tour.photos)
        ? tour.photos.map((url) => cloudinaryUrl(url, 1400))
        : tour.photos,
      specialOffers,
      coverPhoto: tour.coverPhoto ? cloudinaryUrl(tour.coverPhoto, 1400) : null,
    };
  }, isOwner ? 60 : 300);

  if (!result) {
    return next(new AppError('Tour not found', 404));
  }

  // ── View tracking: count each unique visitor once per 30 minutes ──
  const shouldCountView = (() => {
    // Never count the tour owner
    if (req.user?.id && req.user.id === result.supplierId) return false;

    // Never count admins
    if (req.user?.roles?.includes('admin')) return false;

    // Build a stable viewer fingerprint:
    //   1. Authenticated user  → use their DB id (most reliable)
    //   2. Anonymous           → hash of real IP + User-Agent
    //      req.ip on Render is the proxy IP, so read x-forwarded-for first
    let viewerId;
    if (req.user?.id) {
      viewerId = req.user.id;
    } else {
      const realIp =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        req.ip ||
        'unknown';
      const ua = req.headers['user-agent'] || '';
      // Hash so we never store raw IPs
      viewerId = crypto
        .createHash('sha256')
        .update(`${realIp}:${ua}`)
        .digest('hex')
        .slice(0, 16);
    }

    const viewKey = `view:${result.id}:${viewerId}`;
    const now = Date.now();
    const lastViewTime = viewTrackingCache.get(viewKey);

    // Already counted within the last 30 minutes → skip
    if (lastViewTime && now - lastViewTime < 30 * 60 * 1000) return false;

    // Enforce hard cap to prevent unbounded growth
    if (viewTrackingCache.size >= VIEW_CACHE_MAX) {
      const cutoff = now - 30 * 60 * 1000;
      for (const [k, t] of viewTrackingCache.entries()) {
        if (t < cutoff) viewTrackingCache.delete(k);
      }
      if (viewTrackingCache.size >= VIEW_CACHE_MAX) {
        const iter = viewTrackingCache.keys();
        for (let i = 0; i < 1000; i++) {
          const key = iter.next().value;
          if (key) viewTrackingCache.delete(key);
          else break;
        }
      }
    }

    // Record this view
    viewTrackingCache.set(viewKey, now);

    return true;
  })();

  if (shouldCountView) {
    prisma.tour.update({
      where: { id: result.id },
      data: { viewCount: { increment: 1 } },
    }).catch(console.error);

    enqueueEvent({ name: 'tour.viewed', userId: req.user?.id, req, resource: 'Tour', resourceId: result.id });
  }

  // Tell browsers/CDNs: cache this response for 60 s, then revalidate.
  // This stops the frontend from hammering the endpoint on every re-render.
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

  res.status(200).json({
    status: 'success',
    data: { tour: result },
  });
});

// ================================
// SUPPLIER TOUR MANAGEMENT
// ================================

/**
 * Create new tour (suppliers only)
 * 
 * PRODUCTION FIX: Return response immediately, defer async operations
 * This prevents 3000ms+ timeouts when suppliers create tours with special offers.
 * 
 * Flow:
 * 1. Create tour in database (blocking, ~100-200ms)
 * 2. Return HTTP 201 response (< 50ms)
 * 3. In setImmediate() defer:
 *    - Cache invalidation
 *    - Parallel special offer upserts (via Promise.allSettled)
 *    - Activity logging
 *    - Event tracking
 */
exports.createTour = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;

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

  // Map flat 13-step store shape to JSON blobs + normalized columns
  const mapped = productToTour(req.body);
  for (const key of Object.keys(mapped)) {
    if (req.body[key] === undefined && mapped[key] !== undefined) {
      req.body[key] = mapped[key];
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
    referenceCode,
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
    longitude,
    specialOffers
  } = req.body;

  // Get uploaded Cloudinary URLs from multer
  const uploadedPhotos = (req.files || []).map(f => f.path).filter(isValidCloudinaryUrl);

  if ((req.files || []).length > 0 && uploadedPhotos.length === 0) {
    return next(new AppError('Upload failed: no valid images were uploaded', 400));
  }

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

  // ─── BLOCKING PHASE: Database writes ───
  const tour = await prisma.tour.create({
    data: {
      supplierId,
      title,
      description,
      referenceCode: referenceCode || null,
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
      primaryTheme: parsedTheme?.primaryTheme || parsedTheme?.primary || null,
      secondaryThemes: {
        create: [...new Set(parsedTheme?.secondaryThemes || parsedTheme?.secondary || [])].map(t => ({ theme: t })),
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

  // ─── RESPONSE PHASE: Return immediately ───
  res.status(201).json({
    status: 'success',
    data: { tour }
  });

  // ─── ASYNC PHASE: Deferred cleanup (never blocks client) ───
  // Use setImmediate() to run after response is sent but on same event loop tick
  setImmediate(async () => {
    try {
      // Invalidate caches
      await cache.invalidateTourCaches().catch((err) => 
        logger.warn('[cache] invalidateTourCaches failed:', err?.message)
      );

      // Parallelize special offer upserts instead of sequential loop
      // This was the main cause of the timeout!
      const parsedSpecialOffers = typeof specialOffers === 'string' ? JSON.parse(specialOffers) : specialOffers;
      if (Array.isArray(parsedSpecialOffers) && parsedSpecialOffers.length > 0) {
        // Promise.allSettled ensures one failed offer doesn't block others
        const results = await Promise.allSettled(
          parsedSpecialOffers.map(offer => upsertSpecialOffer(prisma, supplierId, tour.id, offer))
        );
        
        // Log any failures but don't crash
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            logger.warn('[Special Offers] Failed to upsert offer:', parsedSpecialOffers[i]?.promoCode, result.reason?.message);
          }
        });
      }

      // Activity logging (non-blocking)
      await logActivity({
        userId: supplierId,
        action: 'tour.created',
        resource: 'Tour',
        resourceId: tour.id,
        metadata: { title, status }
      }).catch((err) => logger.error('[Activity Log] Error:', err?.message));

      // Event tracking (fire-and-forget via queue)
      enqueueEvent({
        name: 'tour.created',
        userId: supplierId,
        resource: 'Tour',
        resourceId: tour.id,
        metadata: { title, status }
      }).catch((err) => logger.error('[Event] enqueueEvent failed:', err?.message));

    } catch (err) {
      // Catch-all: log any unexpected errors but never crash the process
      logger.error('[Tour Create Async] Post-response error:', err?.message);
      // Send alert to Sentry if available
      try {
        const Sentry = require('@sentry/node');
        if (Sentry) {
          Sentry.captureException(err, {
            tags: { operation: 'tour.create.async' },
            extra: { tourId: tour.id, supplierId }
          });
        }
      } catch (_) {}
    }
  });
});

/**
 * Update tour (suppliers only - own tours)
 */
exports.updateTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.supplierId;

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

  // Map flat 13-step store shape to JSON blobs if flat fields are present
  if (req.body.pricingModel || req.body.scheduleType || req.body.language) {
    const mapped = productToTour(req.body);
    for (const key of Object.keys(mapped)) {
      if (req.body[key] === undefined && mapped[key] !== undefined) {
        req.body[key] = mapped[key];
      }
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
    title, description, referenceCode, metaTitle, metaDescription,
    productContent, schedulesAndPricing, bookingAndTickets,
    coverPhoto, tags, status, latitude, longitude, specialOffers
  } = req.body;

  const updateData = {};
  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;
  if (referenceCode !== undefined) updateData.referenceCode = referenceCode || null;
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
  const uploadedPhotos = (req.files || []).map(f => f.path).filter(isValidCloudinaryUrl);
  const hasExistingPhotos = Array.isArray(req.body.existingPhotos);
  if (uploadedPhotos.length > 0 || hasExistingPhotos) {
    // existingPhotos is already parsed by parseJsonFields inside validateTourData
    // Only keep URLs that match the tour's current photos (normalized comparison)
    const normalize = (url) => {
      const m = url.match(/\/upload\/(?:w_\d+[^/]*\/)?(?:v\d+\/)?(.+)$/);
      return m ? m[1] : url;
    };
    const currentPhotoPaths = new Set((existingTour.photos || []).map(normalize));
    const keptPhotos = hasExistingPhotos
      ? req.body.existingPhotos.filter(url => currentPhotoPaths.has(normalize(url)))
      : (existingTour.photos || []);
    const newPhotos = [...keptPhotos, ...uploadedPhotos];

    // Delete removed photos from Cloudinary
    const oldPhotos = existingTour.photos || [];
    const removed = oldPhotos.filter(url => {
      const normalizedOld = normalize(url);
      return !newPhotos.some(nu => normalize(nu) === normalizedOld);
    });
    const deletionResults = await Promise.allSettled(removed.map(url => deleteCloudinaryImage(url)));
    deletionResults.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.warn('Failed to delete Cloudinary image:', removed[i], result.reason);
      }
    });

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

  let secondaryThemesData;

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
    updateData.primaryTheme = th.primaryTheme || th.primary || null;
    // Keep the original JSON field as-is
    updateData.theme = th;
    // Replace secondary themes: delete all existing, re-create
    secondaryThemesData = [...new Set(th.secondaryThemes || th.secondary || [])].map(t => ({ theme: t }));
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

  if (secondaryThemesData) {
    await prisma.tourSecondaryTheme.deleteMany({ where: { tourId: id } });
    if (secondaryThemesData.length > 0) {
      await prisma.tourSecondaryTheme.createMany({ data: secondaryThemesData.map(t => ({ tourId: id, ...t })) });
    }
  }

  // Handle special offers if provided — upsert by promoCode, remove stale offers
  const parsedSpecialOffers = typeof specialOffers === 'string' ? JSON.parse(specialOffers) : specialOffers;
  if (Array.isArray(parsedSpecialOffers)) {
    const incomingPromoCodes = parsedSpecialOffers.map(o => o.promoCode).filter(Boolean);

    // Get existing special offer IDs for this tour (before upsert)
    const existingTargets = await prisma.specialOfferTarget.findMany({
      where: { tourId: id },
      include: { specialOffer: { select: { id: true, promoCode: true } } },
    });

    // Upsert incoming offers
    for (const offer of parsedSpecialOffers) {
      try {
        await upsertSpecialOffer(prisma, supplierId, id, offer);
      } catch (offerErr) {
        console.warn('Failed to upsert special offer:', offerErr.message);
      }
    }

    // Remove targets for offers whose promoCode is no longer in the incoming list
    for (const target of existingTargets) {
      const pc = target.specialOffer.promoCode;
      if (pc && !incomingPromoCodes.includes(pc)) {
        await prisma.specialOfferTarget.delete({ where: { id: target.id } }).catch(() => {});
        // Clean up orphaned offer
        const remaining = await prisma.specialOfferTarget.count({
          where: { specialOfferId: target.specialOfferId },
        });
        if (remaining === 0) {
          await prisma.specialOffer.delete({ where: { id: target.specialOfferId } }).catch(() => {});
        }
      }
    }
  }

  cache.invalidateTourCaches(id).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

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
  const supplierId = req.supplierId;

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

  cache.invalidateTourCaches(id).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

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
  const supplierId = req.supplierId;
  const { status, page = 1, limit = 10 } = req.query;

  const where = { supplierId, status: { not: 'ARCHIVED' } };
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
        },
        specialOfferTargets: {
          include: {
            specialOffer: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.tour.count({ where })
  ]);

  const optimizedTours = tours.map(tour => {
    const specialOffers = (tour.specialOfferTargets || [])
      .map(t => t.specialOffer)
      .filter(Boolean);
    return {
      ...tour,
      photos: Array.isArray(tour.photos)
        ? tour.photos.map(url => cloudinaryUrl(url, 800))
        : tour.photos,
      coverPhoto: tour.coverPhoto ? cloudinaryUrl(tour.coverPhoto, 800) : null,
      specialOffers,
    };
  });

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
  const supplierId = req.supplierId;

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
  const supplierId = req.supplierId;
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

  cache.invalidateTourCaches(id).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

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
    description: 'This is a simulated tour created for development and testing purposes. It includes all required fields and demonstrates the tour creation flow. The tour covers various attracti[...]',
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
        maxParticipants: 15,
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

  cache.invalidateTourCaches().catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

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

// ================================
// OFFER LISTINGS (Customer-facing)
// ================================

/**
 * Get active special offers for customer-facing display
 * Public endpoint - returns offers with associated tour info
 */
exports.getOfferListings = catchAsync(async (req, res, next) => {
  const { offerType, promoCode, quantity, basePrice, tourId } = req.query;
  const now = new Date();

  const where = {
    isActive: true,
    startDate: { lte: now },
    endDate: { gte: now },
  };
  if (offerType) where.offerType = offerType;
  if (promoCode) where.promoCode = promoCode;
  if (tourId) where.targets = { some: { tourId } };
  if (quantity) where.minQuantity = { lte: parseInt(quantity) };

  let offers = await prisma.specialOffer.findMany({
    where,
    include: {
      targets: {
        include: {
          tour: {
            select: {
              id: true,
              title: true,
              photos: true,
              coverPhoto: true,
              slug: true,
              schedulesAndPricing: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (basePrice) {
    const minSpend = parseFloat(basePrice);
    offers = offers.filter((o) => !o.minSpendAmount || minSpend >= o.minSpendAmount);
  }

  res.json({
    status: 'success',
    data: { offers },
  });
});

exports.validatePromoCode = catchAsync(async (req, res, next) => {
  const { promoCode, tourId, selectedDate } = req.body;

  if (!promoCode || promoCode.length < 3) {
    return next(new AppError('Promo code must be at least 3 characters', 400));
  }
  if (!tourId) {
    return next(new AppError('Tour ID is required', 400));
  }
  if (!selectedDate) {
    return next(new AppError('Selected date is required', 400));
  }

  const { findApplicableOffers } = require('../utils/specialOfferEngine');

  const offers = await findApplicableOffers({
    tourId,
    selectedDate: new Date(selectedDate),
    promoCode,
  });

  if (offers.length === 0) {
    return res.json({
      status: 'success',
      data: { valid: false, message: 'Invalid or expired promo code for this tour/date' },
    });
  }

  const offer = offers[0];

  res.json({
    status: 'success',
    data: {
      valid: true,
      offer: {
        id: offer.id,
        name: offer.name,
        offerType: offer.offerType,
        discountType: offer.discountType,
        discountPercentage: offer.discountPercentage,
        fixedDiscountValue: offer.fixedDiscountValue,
      },
    },
  });
});

/**
 * Find tour IDs matching a price range by querying into the schedulesAndPricing JSONB array.
 * Returns null if no price filter is active, false if no tours match, or an array of tour IDs.
 */
async function buildPriceIdConstraint(prisma, minPrice, maxPrice, priceRange) {
  const priceRanges = {
    budget: { min: 0, max: 50 },
    moderate: { min: 50, max: 150 },
    luxury: { min: 150, max: 999999 }
  };

  let min = minPrice ? parseFloat(minPrice) : null;
  let max = maxPrice ? parseFloat(maxPrice) : null;

  if (priceRange && priceRanges[priceRange]) {
    min = min !== null ? min : priceRanges[priceRange].min;
    max = max !== null ? max : priceRanges[priceRange].max;
  }

  if (min === null && max === null) return null;

  const params = [];
  const clauses = [];
  if (min !== null) { params.push(min); clauses.push(`(p->>'retailPrice')::numeric >= $${params.length}`); }
  if (max !== null) { params.push(max); clauses.push(`(p->>'retailPrice')::numeric <= $${params.length}`); }

  const sql = `
    SELECT DISTINCT t.id
    FROM "Tour" t,
         jsonb_array_elements(t."schedulesAndPricing"->'pricingSchedules'->'schedules') AS s,
         jsonb_array_elements(s->'prices') AS p
    WHERE p->>'ageGroup' = 'adult'
      AND ${clauses.join(' AND ')}
  `;

  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  const ids = rows.map(r => r.id);
  return ids.length > 0 ? ids : false;
}

/**
 * Upsert a special offer by promoCode.
 * - If promoCode exists and belongs to the same supplier → update it + ensure tour target.
 * - If promoCode belongs to a different supplier → skip (log warning).
 * - If promoCode is null or not found → create a new offer.
 */
async function upsertSpecialOffer(prisma, supplierId, tourId, offer) {
  // If offer has an id, try to update by id first (for re-publish of existing offers)
  if (offer.id) {
    const existing = await prisma.specialOffer.findFirst({ where: { id: offer.id, supplierId } });
    if (existing) {
      const updated = await prisma.specialOffer.update({
        where: { id: existing.id },
        data: {
          name: offer.name ?? existing.name,
          offerType: offer.offerType ?? existing.offerType,
          discountType: offer.discountType ?? existing.discountType,
          discountPercentage: offer.discountPercentage ?? existing.discountPercentage,
          fixedDiscountValue: offer.fixedDiscountValue !== undefined ? offer.fixedDiscountValue : existing.fixedDiscountValue,
          startDate: offer.startDate ? new Date(offer.startDate) : existing.startDate,
          endDate: offer.endDate ? new Date(offer.endDate) : existing.endDate,
          isActive: offer.isActive !== undefined ? offer.isActive : existing.isActive,
          promoCode: offer.promoCode ?? existing.promoCode,
        },
      });
      const targetExists = await prisma.specialOfferTarget.findFirst({
        where: { specialOfferId: existing.id, tourId, tourOptionKey: null },
      });
      if (!targetExists) {
        await prisma.specialOfferTarget.create({ data: { specialOfferId: existing.id, tourId } });
      }
      return updated;
    }
    // id provided not found for this supplier — fall through to create
  }

  // No id or id not found: try upsert by promoCode
  if (!offer.promoCode) {
    return prisma.specialOffer.create({
      data: {
        supplierId,
        name: offer.name || 'Special Offer',
        offerType: offer.offerType || 'PROMO_CODE',
        discountType: offer.discountType || 'PERCENTAGE',
        discountPercentage: offer.discountPercentage || 10,
        fixedDiscountValue: offer.fixedDiscountValue || null,
        startDate: offer.startDate ? new Date(offer.startDate) : null,
        endDate: offer.endDate ? new Date(offer.endDate) : null,
        promoCode: null,
        isActive: offer.isActive !== false,
        targets: { create: [{ tourId }] },
      },
    });
  }

  const existing = await prisma.specialOffer.findUnique({ where: { promoCode: offer.promoCode } });

  if (existing) {
    if (existing.supplierId !== supplierId) {
      console.warn(`Promo code "${offer.promoCode}" belongs to another supplier — skipping`);
      return null;
    }
    const updated = await prisma.specialOffer.update({
      where: { id: existing.id },
      data: {
        name: offer.name ?? existing.name,
        offerType: offer.offerType ?? existing.offerType,
        discountType: offer.discountType ?? existing.discountType,
        discountPercentage: offer.discountPercentage ?? existing.discountPercentage,
        fixedDiscountValue: offer.fixedDiscountValue !== undefined ? offer.fixedDiscountValue : existing.fixedDiscountValue,
        startDate: offer.startDate ? new Date(offer.startDate) : existing.startDate,
        endDate: offer.endDate ? new Date(offer.endDate) : existing.endDate,
        isActive: offer.isActive !== undefined ? offer.isActive : existing.isActive,
      },
    });
    const targetExists = await prisma.specialOfferTarget.findFirst({
      where: { specialOfferId: existing.id, tourId, tourOptionKey: null },
    });
    if (!targetExists) {
      await prisma.specialOfferTarget.create({ data: { specialOfferId: existing.id, tourId } });
    }
    return updated;
  }

  return prisma.specialOffer.create({
    data: {
      supplierId,
      name: offer.name || 'Special Offer',
      offerType: offer.offerType || 'PROMO_CODE',
      discountType: offer.discountType || 'PERCENTAGE',
      discountPercentage: offer.discountPercentage || 10,
      fixedDiscountValue: offer.fixedDiscountValue || null,
      startDate: offer.startDate ? new Date(offer.startDate) : null,
      endDate: offer.endDate ? new Date(offer.endDate) : null,
      promoCode: offer.promoCode,
      isActive: offer.isActive !== false,
      targets: { create: [{ tourId }] },
    },
  });
}

/**
 * Upload photos to Cloudinary without creating a tour.
 * Accepts multipart/form-data with `photos` field (array of files).
 * Returns an array of Cloudinary URLs.
 */
exports.uploadPhotos = catchAsync(async (req, res, next) => {
  const uploadedPhotos = (req.files || []).map(f => f.path).filter(isValidCloudinaryUrl);

  if (uploadedPhotos.length === 0) {
    return next(new AppError('No valid images were uploaded', 400));
  }

  res.status(200).json({
    status: 'success',
    data: {
      photos: uploadedPhotos,
    },
  });
});

module.exports = exports;
