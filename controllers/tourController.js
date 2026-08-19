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
const { createSlug, validateTourData, normalizeProductPayload, validateStoredPricing, rebuildSchedulePrices, reconcileAvailability, durationToMinutes, cheapestRetailPrice } = require('../utils/tourHelpers');
const { cancelPaymentIntent } = require('../utils/stripeHelpers');
const { productToTour } = require('../utils/productToTour');
const { tourContentSnapshot, mergeDraftContent, buildTourDiff, computeChangesSummary, buildLiveUpdateData, applyFlatToBlobMapping } = require('../utils/tourDraft');
const { logActivity } = require('../utils/auditLogger');
const { 
  buildTourFilters, 
  buildSortOptions, 
  getAvailableFilterOptions,
  validateFilterParams,
  findNearbyTourIds,
  getTourDistances
} = require('../utils/tourFilterBuilder');
const { shouldCountTourView } = require('../utils/viewTracking');
const eventEmitter = require('../utils/eventEmitter');

const { rankTourIdsBySearch } = require('../utils/fullTextSearch');
const {
  computeDayEntry,
  parseBlob,
  travelerCount,
  toUtcDate,
  BOOKABLE_STATUSES,
} = require('../utils/availabilityCore');
const cache = require('../utils/cacheHelper');
const { verifyAccessToken } = require('../config/jwt');
const crypto = require('crypto');
const { enqueueEvent } = require('../utils/queue');
const { notifyAdmin } = require('../utils/adminNotificationService');
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
  const pageLimit = parseInt(limit);
  // When a date is searched, fetch a lookahead buffer so the availability
  // re-check can still return a full page after dropping unavailable tours.
  const queryLimit = req.query.availableDate ? Math.min(pageLimit * 3, 60) : pageLimit;

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
                  totalBookings: true,
                  status: true,
                  supplierType: true
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
        take: queryLimit
      }),
      prisma.tour.count({ where })
    ]);

    // Compute distances for geo queries
    let distMap = new Map();
    if (hasGeo) {
      distMap = await getTourDistances(prisma, parseFloat(lat), parseFloat(lng), tours.map(t => t.id));
    }

    const optimizedTours = tours.map((tour) => {
      const sp = tour.supplier?.supplierProfile;
      const t = {
        ...tour,
        photos: tour.photos,
        coverPhoto: tour.coverPhoto || null,
        supplier: {
          ...tour.supplier,
          photoURL: tour.supplier.photoURL || null,
          supplierType: sp?.supplierType || null,
          verified: sp?.status === 'ACTIVE' || sp?.status === 'APPROVED',
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

    // Full-fidelity availability re-check for availableDate searches. The SQL
    // filter only bounds the tour's start/end window, so the target date may
    // still be a closed day, outside the operating days-of-week, overridden to
    // BLOCKED, or fully booked. Re-evaluate each buffered tour against the
    // exact per-day rules (same computeDayEntry the calendar uses) with two
    // batched queries â€” no N+1 â€” and keep the first `limit` truly available.
    if (req.query.availableDate) {
      const targetDate = toUtcDate(req.query.availableDate);
      if (targetDate && optimizedTours.length > 0) {
        const tourIds = optimizedTours.map((t) => t.id);
        const [dateOverrides, dateBookings] = await Promise.all([
          prisma.tourDateOverride.findMany({
            where: { tourId: { in: tourIds }, date: targetDate },
          }),
          prisma.booking.findMany({
            where: {
              tourId: { in: tourIds },
              selectedDate: targetDate,
              status: { in: BOOKABLE_STATUSES },
            },
            select: { tourId: true, selectedTime: true, travelers: true },
          }),
        ]);

        const overrideByTour = new Map(dateOverrides.map((o) => [o.tourId, o]));
        const bookedByTour = new Map();
        const travelersBySlot = new Map(); // tourId -> Map(slot -> travelers)
        const groupsBySlot = new Map(); // tourId -> Map(slot -> groups)
        for (const b of dateBookings) {
          const slotKey = b.selectedTime || '__no_slot__';
          bookedByTour.set(b.tourId, (bookedByTour.get(b.tourId) || 0) + travelerCount(b.travelers));
          const tMap = travelersBySlot.get(b.tourId) || new Map();
          tMap.set(slotKey, (tMap.get(slotKey) || 0) + travelerCount(b.travelers));
          travelersBySlot.set(b.tourId, tMap);
          const gMap = groupsBySlot.get(b.tourId) || new Map();
          gMap.set(slotKey, (gMap.get(slotKey) || 0) + 1);
          groupsBySlot.set(b.tourId, gMap);
        }

        const availableTours = [];
        for (const tour of optimizedTours) {
          const entry = computeDayEntry(
            parseBlob(tour.schedulesAndPricing) || {},
            overrideByTour.get(tour.id) || null,
            {
              bookedCount: bookedByTour.get(tour.id) || 0,
              bookingsBySlot: travelersBySlot.get(tour.id) || new Map(),
              groupsBySlot: groupsBySlot.get(tour.id) || new Map(),
            },
            targetDate,
            {}
          );
          if (entry.status === 'AVAILABLE' || entry.status === 'LIMITED') {
            availableTours.push(tour);
            if (availableTours.length >= pageLimit) break;
          }
        }
        optimizedTours.length = 0;
        optimizedTours.push(...availableTours);
      }
    }

    const totalPages = Math.ceil(totalCount / pageLimit);
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    const response = {
      status: 'success',
      data: {
        tours: optimizedTours,
        pagination: {
          currentPage: parseInt(page), totalPages, totalCount,
          hasNextPage, hasPrevPage, limit: pageLimit
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
    // Build optional WHERE conditions for category/theme filtering
    const conditions = ["t.status = 'ACTIVE'", "sp.status = 'ACTIVE'"];
    const params = [];
    let paramIdx = 1;

    if (filterCategory) {
      conditions.push(`t.category = $${paramIdx}`);
      params.push(filterCategory);
      paramIdx++;
    }
    if (theme) {
      conditions.push(`(t."primaryTheme" = $${paramIdx} OR EXISTS (
        SELECT 1 FROM "TourSecondaryTheme" tst WHERE tst."tourId" = t.id AND tst.theme = $${paramIdx}
      ))`);
      params.push(theme);
      paramIdx++;
    }

    params.push(limit * 20);

    // Score + fetch in a single SQL query â€” no full-table JS iteration
    const scored = await prisma.$queryRawUnsafe(`
      SELECT t.id, t.title, t.slug, t."coverPhoto", t.photos, t.description,
        t.category, t."averageRating", t."reviewCount", t."viewCount", t."totalBookings",
        t."durationMinutes", t.city, t.country,
        u.id AS "supplierId", u.name AS "supplierName", u."photoURL" AS "supplierPhoto",
        sp."averageRating" AS "supplierRating", sp."totalBookings" AS "supplierBookings",
        sp."supplierType" AS "supplierType",
        (COALESCE(t."totalBookings", 0) * 0.40 +
         COALESCE(t."averageRating", 0) * 0.25 +
         COALESCE(t."reviewCount", 0) * 0.20 +
         COALESCE(t."viewCount", 0) * 0.15) AS score
      FROM "Tour" t
      JOIN "SupplierProfile" sp ON sp."userId" = t."supplierId"
      JOIN "User" u ON u.id = t."supplierId"
      WHERE ${conditions.join(' AND ')}
      ORDER BY score DESC
      LIMIT $${paramIdx}
    `, ...params);

    // Group by category in JS (small result set â€” at most limit*20 rows)
    const optimized = {};
    for (const row of scored) {
      const cat = row.category || 'Other';
      if (!optimized[cat]) optimized[cat] = [];
      if (optimized[cat].length >= limit) continue;

      optimized[cat].push({
        id: row.id,
        title: row.title,
        slug: row.slug,
        coverPhoto: row.coverPhoto || null,
        photos: row.photos,
        description: row.description,
        category: row.category,
        averageRating: row.averageRating ? Number(row.averageRating) : null,
        reviewCount: row.reviewCount,
        viewCount: row.viewCount,
        totalBookings: row.totalBookings,
        durationMinutes: row.durationMinutes,
        city: row.city,
        country: row.country,
        supplier: {
          id: row.supplierId,
          name: row.supplierName,
          photoURL: row.supplierPhoto || null,
          supplierType: row.supplierType || null,
          verified: true,
          supplierProfile: {
            averageRating: row.supplierRating ? Number(row.supplierRating) : null,
            totalBookings: row.supplierBookings,
          },
        },
      });
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

  // â”€â”€ Optional auth: check if the requester is the tour owner â”€â”€
  let isOwner = false;
  let ownerSupplierId = null;
  if (req.headers.authorization?.startsWith('Bearer ')) {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = verifyAccessToken(token);
      ownerSupplierId = decoded.userId;
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
      // Invalid token â€” continue as public request
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
      // A supplier can view any ACTIVE tour (like everyone else) AND their own
      // tour in any status (e.g. drafts) — but NOT other suppliers' non-active
      // tours. Previously every supplier was treated as the tour owner, which
      // scoped the query to their own supplierId and 404'd every public tour
      // they didn't own (dropping the itinerary + productContent details on
      // the frontend for logged-in suppliers).
      where.AND = [{ OR: [{ status: 'ACTIVE' }, { supplierId: ownerSupplierId }] }];
    } else {
      where.status = 'ACTIVE';
    }

    // Main tour query â€” lighter includes (no deep reviews/specialOffers)
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
                businessInfo: true,
                status: true,
                supplierType: true
              }
            }
          }
        },
        _count: {
          select: {
            reviews: true,
            bookings: true
          }
        },
        expeditionTour: true
      }
    });

    if (!tour) return null;

    if (tour.supplier) {
      const sp = tour.supplier.supplierProfile;
      tour.supplier.supplierType = sp?.supplierType || null;
      tour.supplier.verified = sp?.status === 'ACTIVE' || sp?.status === 'APPROVED';
    }

    // Fetch reviews + special offers in parallel (separate from main query)
    const [reviews, specialOfferTargets] = await Promise.all([
      prisma.review.findMany({
        where: { tourId: tour.id, status: 'APPROVED' },
        include: {
          customer: {
            select: { id: true, name: true, photoURL: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      }),
      prisma.specialOfferTarget.findMany({
        where: { tourId: tour.id },
        include: { specialOffer: true }
      })
    ]);

    // Customer-facing embed: only ACTIVE offers whose date window includes
    // today (a window-less offer never expires). Projected so internal fields
    // like promoCode/supplierId/spotsSold never leak to the public API.
    const now = new Date();
    const specialOffers = specialOfferTargets
      .map(t => t.specialOffer)
      .filter(Boolean)
      .filter(o => o.isActive
        && (!o.startDate || now >= new Date(o.startDate))
        && (!o.endDate || now <= new Date(o.endDate)))
      .filter((offer, index, arr) => arr.findIndex(x => x.id === offer.id) === index)
      .map(o => ({
        id: o.id,
        name: o.name,
        offerType: o.offerType,
        discountType: o.discountType,
        discountPercentage: o.discountPercentage,
        fixedDiscountValue: o.fixedDiscountValue,
        startDate: o.startDate,
        endDate: o.endDate,
        isActive: o.isActive,
      }));

    return {
      ...tour,
      reviews,
      photos: tour.photos,
      specialOffers,
      coverPhoto: tour.coverPhoto || null,
    };
  }, isOwner ? 60 : 300);

  if (!result) {
    return next(new AppError('Tour not found', 404));
  }

  // â”€â”€ View tracking: count each unique external visitor once per 30 minutes â”€â”€
  // Admins, expedition staff, the tour owner and ACTIVE suppliers are excluded
  // from viewCount (and from the analytics event emitted below).
  if (await shouldCountTourView({ req, res, tourSupplierId: result.supplierId, tourId: result.id })) {
    prisma.tour.update({
      where: { id: result.id },
      data: { viewCount: { increment: 1 } },
    }).catch(console.error);

    eventEmitter.emit({ name: 'tour.viewed', userId: req.user?.id, req, resource: 'Tour', resourceId: result.id });
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

  // â”€â”€ Submit-for-review workflow â”€â”€
  // Suppliers can no longer publish tours directly. Any ACTIVE/PUBLISHED status
  // sent by the supplier is coerced to DRAFT here; a tour reaches ACTIVE only
  // after an admin approves it via the tour moderation endpoint.
  if (req.body.status === 'ACTIVE' || req.body.status === 'PUBLISHED') {
    req.body.status = 'DRAFT';
  }

  // Map flat 13-step store shape to JSON blobs + normalized columns
  const JSON_BLOB_KEYS = new Set(['categorization', 'productContent', 'schedulesAndPricing', 'bookingAndTickets']);
  const mapped = productToTour(req.body);
  for (const key of Object.keys(mapped)) {
    const bodyVal = req.body[key];
    const isExplicitNested = bodyVal && typeof bodyVal === 'object' && !Array.isArray(bodyVal) && JSON_BLOB_KEYS.has(key);
    if (!isExplicitNested) {
      req.body[key] = mapped[key];
    }
  }

  // Fallback: if categorization.duration was sent directly (nested), use it
  if (req.body.categorization && req.body.categorization.duration) {
    const { value, unit } = req.body.categorization.duration;
    if (value != null && unit) {
      req.body.duration = value;
      req.body.durationUnit = unit;
    }
  }

  // Ensure flat duration/durationUnit are authoritative â€” they are the form's
  // source of truth. Always override categorization.duration with them so a
  // stale nested blob can never silently overwrite the user's edit.
  if (req.body.duration != null && req.body.durationUnit) {
    const cat = (req.body.categorization && typeof req.body.categorization === 'object')
      ? req.body.categorization : {};
    cat.duration = { value: req.body.duration, unit: req.body.durationUnit };
    req.body.categorization = cat;
  }

  // Strip empty values for draft saves so partial wizard progress doesn't fail validation
  if (req.body.status !== 'ACTIVE' && req.body.status !== 'PUBLISHED') {
    for (const key of Object.keys(req.body)) {
      if (JSON_BLOB_KEYS.has(key)) continue
      const val = req.body[key]
      if (val === '' || val === null || val === undefined) { delete req.body[key]; continue }
      if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) { delete req.body[key]; continue }
      if (Array.isArray(val)) {
        const filtered = val.filter(v => {
          if (v === '' || v === null || v === undefined) return false
          if (typeof v === 'object' && !Array.isArray(v)) {
            return Object.values(v).some(c => c !== '' && c != null && c !== undefined)
          }
          return true
        })
        if (filtered.length === 0) { delete req.body[key]; continue }
        req.body[key] = filtered
      }
    }
  }

  // â”€â”€ Regenerate derived schedule prices from the authoritative source â”€â”€
  // The dashboard's autosave may send an empty/stale `prices` array; the server
  // always recomputes it from travelerDetails so the stored blob matches what
  // checkout (calculateTourPrice) and the public price display consume.
  if (req.body.schedulesAndPricing !== undefined) {
    let blob = req.body.schedulesAndPricing;
    if (typeof blob === 'string') {
      try { blob = JSON.parse(blob); } catch { blob = null; }
    }
    if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
      const normalized = reconcileAvailability(rebuildSchedulePrices(blob));
      req.body.schedulesAndPricing = normalized;
    }
  }

  // Normalize wheelchairAccessible in options — it's now a top-level productContent field
  if (Array.isArray(req.body.options)) {
    req.body.options = req.body.options.map((o) => ({ ...o, wheelchairAccessible: !!o.wheelchairAccessible }));
  }

  // Normalize legacy/stored shapes into the strict flat builder schema before
  // validating (object transportMode, label-only pricing categories, etc.).
  normalizeProductPayload(req.body);

  // Validate tour data — partial validation allows progressive draft saves from
  // the step-by-step wizard. Full validation + pricing completeness is enforced
  // by the submit-for-review endpoint (tours can no longer be created live).
  const validationResult = validateTourData(req.body, true);
  if (!validationResult.isValid) {
    return next(new AppError(`Validation failed: ${validationResult.errors.join(', ')}`, 400));
  }

  // Ensure required scalar fields always have a value for Prisma
  if (!req.body.title) req.body.title = 'Untitled Tour';
  if (!req.body.description) req.body.description = '';

  const {
    title,
    description,
    referenceCode,
    metaTitle,
    metaDescription,
    categorization,
    productContent,
    schedulesAndPricing,
    bookingAndTickets,
    photos = [],
    coverPhoto,
    tags = [],
    status = 'DRAFT',
    latitude,
    longitude,
    specialOffers,
    city,
    country,
    region,
    theme
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

  const slug = await createSlug(title, prisma);

  const parsedCategory = typeof categorization === 'string' ? JSON.parse(categorization) : categorization;

  // â”€â”€â”€ BLOCKING PHASE: Database writes â”€â”€â”€
  const tour = await prisma.tour.create({
    data: {
      supplierId,
      title,
      description,
      referenceCode: referenceCode || null,
      slug,
      categorization: parsedCategory,
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
      city: city ?? null,
      country: country ?? null,
      region: region ?? null,
      theme: theme || { primary: null, secondary: [] },
      category: parsedCategory?.category || null,
      subcategory: parsedCategory?.subcategory || null,
      activityType: parsedCategory?.activityType || null,
      difficulty: parsedCategory?.difficulty || null,
      durationMinutes: durationToMinutes(parsedCategory?.duration),
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

  // â”€â”€â”€ RESPONSE PHASE: Return immediately â”€â”€â”€
  res.status(201).json({
    status: 'success',
    data: { tour }
  });

  // â”€â”€â”€ ASYNC PHASE: Deferred cleanup (never blocks client) â”€â”€â”€
  // Use setImmediate() to run after response is sent but on same event loop tick
  setImmediate(async () => {
    try {
      // Mark uploaded photos as ATTACHED
      if (allPhotos.length > 0) {
        await prisma.media.updateMany({
          where: { url: { in: allPhotos } },
          data: { status: 'ATTACHED', entity: 'tour', entityId: tour.id },
        }).catch(err => logger.warn('[Media] Failed to mark photos as ATTACHED:', err?.message));
      }

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
      } catch { /* Sentry unavailable â€” ignore */ }
    }
  });
});

/**
 * Merge the incoming product-editor payload over the current live content to
 * produce the full draft snapshot. Live columns are never touched here â€” the
 * draft waits in draftContent until an admin approves it.
 */
function buildDraftFromBody(existingTour, body, files) {
  const merged = mergeDraftContent(existingTour, body);
  const uploadedPhotos = (files || []).map((f) => f.path).filter(isValidCloudinaryUrl);
  const keptPhotos = Array.isArray(body.existingPhotos) && body.existingPhotos.length > 0
    ? body.existingPhotos
    : (existingTour.photos || []);
  merged.photos = [...keptPhotos, ...uploadedPhotos];
  if (body.coverPhotoIndex !== undefined) {
    const idx = parseInt(body.coverPhotoIndex, 10);
    if (!Number.isNaN(idx) && uploadedPhotos[idx]) {
      merged.coverPhoto = uploadedPhotos[idx];
    }
  }
  // A listing must never be approved without a cover: if the payload cleared
  // the cover (or the tour never had one) fall back to the first photo.
  if (!merged.coverPhoto && merged.photos.length > 0) {
    merged.coverPhoto = merged.photos[0];
  }
  // Empty metadata strings are meaningless on the storefront â€” normalize to
  // null so title-based meta fallbacks kick in instead of blank tags.
  if (merged.metaTitle === '') merged.metaTitle = null;
  if (merged.metaDescription === '') merged.metaDescription = null;
  if (merged.schedulesAndPricing && typeof merged.schedulesAndPricing === 'object' && !Array.isArray(merged.schedulesAndPricing)) {
    merged.schedulesAndPricing = rebuildSchedulePrices(merged.schedulesAndPricing);
    // Backfill any empty availability aggregate from the per-schedule data so an
    // innocent edit never wipes the schedule the booking engine reads. Additive
    // only: never invents or clears hours that are legitimately empty.
    merged.schedulesAndPricing = reconcileAvailability(merged.schedulesAndPricing);
  }
  return merged;
}

const JSON_BLOB_KEYS = new Set(['categorization', 'productContent', 'schedulesAndPricing', 'bookingAndTickets']);

/**
 * Update tour (suppliers only - own tours)
 */
exports.updateTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.supplierId;

  // Find tour and verify ownership (non-locking â€” used for early 404 check and
  // as the seed for the presence-aware flatâ†’blob mapping below)
  const existingTour = await prisma.tour.findFirst({
    where: { id, supplierId }
  });
  if (!existingTour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  // â”€â”€ Submit-for-review workflow â”€â”€
  // Suppliers can no longer publish tours directly. Attempting to set a tour to
  // ACTIVE/PUBLISHED is rejected â€” use the submit-for-review endpoint and await
  // admin approval instead.
  if (req.body.status === 'ACTIVE' || req.body.status === 'PUBLISHED') {
    return next(new AppError('Tours can no longer be published directly. Submit the tour for review and an admin will approve it.', 400));
  }

  // ALWAYS map flat 13-step store shape to JSON blobs when body is present.
  // Presence-aware at blob granularity (utils/tourDraft): blobs whose flat
  // inputs the payload never touches are left to inherit the live snapshot,
  // blobs that ARE being edited are rebuilt from a flat view seeded with live
  // values for every omitted field. Blob keys explicitly sent as nested
  // objects by the frontend always win.
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length > 0) {
    applyFlatToBlobMapping(req.body, existingTour);
  }

  // Strip empty values for draft saves so partial wizard progress doesn't fail validation
  const JSON_BLOB_KEYS = new Set(['categorization', 'productContent', 'schedulesAndPricing', 'bookingAndTickets'])
  if (req.body.status !== 'ACTIVE' && req.body.status !== 'PUBLISHED') {
    for (const key of Object.keys(req.body)) {
      if (JSON_BLOB_KEYS.has(key)) continue
      const val = req.body[key]
      if (val === '' || val === null || val === undefined) { delete req.body[key]; continue }
      if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) { delete req.body[key]; continue }
      if (Array.isArray(val)) {
        const filtered = val.filter(v => {
          if (v === '' || v === null || v === undefined) return false
          if (typeof v === 'object' && !Array.isArray(v)) {
            return Object.values(v).some(c => c !== '' && c != null && c !== undefined)
          }
          return true
        })
        if (filtered.length === 0) { delete req.body[key]; continue }
        req.body[key] = filtered
      }
    }
  }

  // Normalize wheelchairAccessible in options — it's now a top-level productContent field
  if (Array.isArray(req.body.options)) {
    req.body.options = req.body.options.map((o) => ({ ...o, wheelchairAccessible: !!o.wheelchairAccessible }));
  }

  // Normalize legacy/stored shapes into the strict flat builder schema before
  // validating (object transportMode, label-only pricing categories, etc.).
  normalizeProductPayload(req.body);

  // Validate update data — partial validation (draft saves). Full validation
  // is enforced by the submit-for-review endpoint.
  const validationResult = validateTourData(req.body, true);
  if (!validationResult.isValid) {
    return next(new AppError(`Validation failed: ${validationResult.errors.join(', ')}`, 400));
  }

  // â”€â”€ Draft path: editing a live tour â”€â”€
  // Edits to an ACTIVE tour are captured in draftContent and never touch the
  // live columns. The live listing keeps selling the current approved version
  // until an admin approves the draft. Terminal statuses (PAUSED/ARCHIVED)
  // fall through to the normal live-update path below.
  const editingLiveTour = existingTour.status === 'ACTIVE'
    && (!req.body.status || ['DRAFT', 'REJECTED', 'PENDING_APPROVAL', 'ACTIVE', 'PUBLISHED'].includes(req.body.status));
  if (editingLiveTour) {
    // â”€â”€ Edit-while-pending lock â”€â”€
    // A tour already in the moderation queue must not be mutated underneath the
    // reviewer. The supplier withdraws the submission (POST /withdraw-review)
    // before editing again; otherwise the pending draft could silently drop out
    // of the admin queue.
    if (existingTour.draftStatus === 'PENDING_APPROVAL') {
      return next(new AppError('This tour is currently pending review. Withdraw the submission to edit it again.', 409));
    }

    const merged = buildDraftFromBody(existingTour, req.body, req.files);

    await prisma.tour.update({
      where: { id },
      data: {
        draftContent: merged,
        draftStatus: 'DRAFT',
        draftReviewedAt: null,
        draftReviewNote: null,
      },
    });

    cache.invalidateTourCaches(id, existingTour.slug).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

    await logActivity({
      userId: supplierId,
      action: 'tour.draft_saved',
      resource: 'Tour',
      resourceId: id,
      metadata: { title: existingTour.title },
    });

    const tour = {
      ...existingTour,
      ...merged,
      status: 'ACTIVE',
      draftStatus: 'DRAFT',
      draftContent: merged,
      draftSubmittedAt: existingTour.draftSubmittedAt,
      draftReviewedAt: null,
      draftReviewNote: null,
    };

    return res.status(200).json({ status: 'success', data: { tour } });
  }

  // Host the update in a transaction with row lock so two concurrent PATCH
  // requests cannot overwrite each other's changes.
  const result = await prisma.$transaction(async (tx) => {
    // Lock the tour row â€” blocks any other concurrent transaction writing to it
    const [locked] = await tx.$queryRawUnsafe(
      'SELECT id FROM "Tour" WHERE id = $1 AND "supplierId" = $2 FOR UPDATE',
      id, supplierId
    );
    if (!locked) {
      throw new AppError('Tour not found or access denied', 404);
    }

    // Re-read with full data inside the locked transaction (current state)
    const existingTour = await tx.tour.findFirst({
      where: { id, supplierId }
    });

    // â”€â”€ Edit-while-pending lock â”€â”€
    // Covers the non-draft path: a NEW tour awaiting approval (status
    // PENDING_APPROVAL) must also be frozen while an admin reviews it. The
    // supplier withdraws the submission (POST /withdraw-review) before editing.
    if (existingTour.status === 'PENDING_APPROVAL' || existingTour.draftStatus === 'PENDING_APPROVAL') {
      throw new AppError('This tour is currently pending review. Withdraw the submission to edit it again.', 409);
    }

    const {
      title, description, referenceCode, metaTitle, metaDescription,
      categorization,
      productContent, bookingAndTickets,
      coverPhoto, tags, status, latitude, longitude, specialOffers,
      city, country, region
    } = req.body;
    let { schedulesAndPricing } = req.body;

    // â”€â”€ Server-authoritative derived pricing + live-data completeness â”€â”€
    // The dashboard's autosave may send an empty/stale `prices` array; the
    // server always regenerates it from the authoritative travelerDetails so
    // the stored blob matches what checkout (calculateTourPrice) consumes.
    let effectiveBlob = schedulesAndPricing !== undefined ? schedulesAndPricing : existingTour.schedulesAndPricing;
    if (typeof effectiveBlob === 'string') {
      try { effectiveBlob = JSON.parse(effectiveBlob); } catch { effectiveBlob = null; }
    }
    if (schedulesAndPricing !== undefined && effectiveBlob && typeof effectiveBlob === 'object' && !Array.isArray(effectiveBlob)) {
      effectiveBlob = reconcileAvailability(rebuildSchedulePrices(effectiveBlob));
      schedulesAndPricing = effectiveBlob;
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (referenceCode !== undefined) updateData.referenceCode = referenceCode || null;
    if (metaTitle !== undefined) updateData.metaTitle = metaTitle;
    if (metaDescription !== undefined) updateData.metaDescription = metaDescription;
    if (categorization !== undefined) updateData.categorization = categorization;
    if (productContent !== undefined) updateData.productContent = productContent;
    if (schedulesAndPricing !== undefined) updateData.schedulesAndPricing = schedulesAndPricing;
    if (bookingAndTickets !== undefined) updateData.bookingAndTickets = bookingAndTickets;
    if (coverPhoto !== undefined) updateData.coverPhoto = coverPhoto;
    if (tags !== undefined) updateData.tags = tags;
    // â”€â”€ Live-tour edits stay live â”€â”€
    // An ACTIVE tour only leaves ACTIVE when the supplier explicitly pauses or
    // archives it. Draft/review statuses sent while editing a live tour are
    // ignored so autosaves never unpublish a live listing.
    let effectiveStatus = status;
    if (existingTour.status === 'ACTIVE' && (status === 'DRAFT' || status === 'REJECTED' || status === 'PENDING_APPROVAL')) {
      effectiveStatus = 'ACTIVE';
    }
    if (effectiveStatus !== undefined) updateData.status = effectiveStatus;
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (city !== undefined) updateData.city = city;
    if (country !== undefined) updateData.country = country;
    if (region !== undefined) updateData.region = region;

    // Handle uploaded photos from multer
    const uploadedPhotos = (req.files || []).map(f => f.path).filter(isValidCloudinaryUrl);
    const hasExistingPhotos = Array.isArray(req.body.existingPhotos) && req.body.existingPhotos.length > 0;
    if (uploadedPhotos.length > 0 || hasExistingPhotos) {
      const normalize = (url) => {
        const m = url.match(/\/upload\/(?:w_\d+[^/]*\/)?(?:v\d+\/)?(.+)$/);
        return m ? m[1] : url;
      };
      const keptPhotos = hasExistingPhotos
        ? req.body.existingPhotos
        : (existingTour.photos || []);
      const newPhotos = [...keptPhotos, ...uploadedPhotos];

      const oldPhotos = existingTour.photos || [];
      const removed = oldPhotos.filter(url => {
        const normalizedOld = normalize(url);
        return !newPhotos.some(nu => normalize(nu) === normalizedOld);
      });
      const deletionResults = await Promise.allSettled(removed.map(url => deleteCloudinaryImage(url, 3, { tourId: id })));
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

    // Update slug if title changed (uses tx so slug uniqueness check sees
    // the transaction's pending writes â€” prevents duplicate slugs)
    if (req.body.title && req.body.title !== existingTour.title) {
      updateData.slug = await createSlug(req.body.title, tx);
    }

    // Handle categorization normalization
    if (req.body.categorization) {
      const cat = typeof req.body.categorization === 'string'
        ? JSON.parse(req.body.categorization)
        : req.body.categorization;
      updateData.category = cat.category || null;
      updateData.subcategory = cat.subcategory || null;
      updateData.activityType = cat.activityType || null;
      updateData.difficulty = cat.difficulty || null;
      updateData.durationMinutes = durationToMinutes(cat.duration);
      updateData.categorization = cat;
    }

    // Auto-extract location fields from productContent if not sent as top-level fields
    const pc = req.body.productContent;
    const firstLoc = Array.isArray(pc?.locations) ? pc.locations[0] : (pc?.location || null);
    if (req.body.city === undefined) updateData.city = firstLoc?.city || null;
    if (req.body.country === undefined) updateData.country = firstLoc?.country || null;
    if (req.body.region === undefined) updateData.region = firstLoc?.region || null;

    // Auto-unpublish from Expedition Go if status leaves ACTIVE
    if (effectiveStatus && effectiveStatus !== 'ACTIVE' && existingTour.status === 'ACTIVE') {
      await tx.expeditionTour.updateMany({
        where: { tourId: id, isActive: true },
        data: { isActive: false, unpublishReason: 'Tour status changed to ' + effectiveStatus },
      });
    }

    const tour = await tx.tour.update({
      where: { id },
      data: updateData,
      include: {
        supplier: {
          select: { id: true, name: true, photoURL: true }
        }
      }
    });

    // Handle special offers if provided â€” upsert by promoCode, remove stale offers
    const parsedSpecialOffers = typeof specialOffers === 'string' ? JSON.parse(specialOffers) : specialOffers;
    if (Array.isArray(parsedSpecialOffers)) {
      const incomingPromoCodes = parsedSpecialOffers.map(o => o.promoCode).filter(Boolean);

      const existingTargets = await tx.specialOfferTarget.findMany({
        where: { tourId: id },
        include: { specialOffer: { select: { id: true, promoCode: true } } },
      });

      for (const offer of parsedSpecialOffers) {
        try {
          await upsertSpecialOffer(tx, supplierId, id, offer);
        } catch (offerErr) {
          console.warn('Failed to upsert special offer:', offerErr.message);
        }
      }

      for (const target of existingTargets) {
        const pc = target.specialOffer.promoCode;
        if (pc && !incomingPromoCodes.includes(pc)) {
          await tx.specialOfferTarget.delete({ where: { id: target.id } }).catch(() => {});
          const remaining = await tx.specialOfferTarget.count({
            where: { specialOfferId: target.specialOfferId },
          });
          if (remaining === 0) {
            await tx.specialOffer.delete({ where: { id: target.specialOfferId } }).catch(() => {});
          }
        }
      }
    }

    return { tour, existingTour };
  });

  const { tour, existingTour: updatedBefore } = result;

  cache.invalidateTourCaches(id, tour.slug).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

  await logActivity({
    userId: supplierId,
    action: 'tour.updated',
    resource: 'Tour',
    resourceId: tour.id,
    oldValues: updatedBefore,
    newValues: tour
  });

  if (tour.photos?.length > 0) {
    prisma.media.updateMany({
      where: { url: { in: tour.photos } },
      data: { status: 'ATTACHED', entity: 'tour', entityId: id },
    }).catch(err => logger.warn('[Media] Failed to mark photos as ATTACHED:', err?.message));
  }

  res.status(200).json({
    status: 'success',
    data: { tour }
  });
});

/**
 * Validate that a stored tour is complete enough to submit for review.
 * Returns an array of human-readable error messages (empty = ready to submit).
 *
 * The strict pricing/availability completeness gate (validateStoredPricing)
 * mirrors the pre-moderation "Set Live" check; the remaining checks enforce
 * that customers get a usable product page if the tour is approved.
 */
function validateTourForReview(tour) {
  const errors = [];

  if (!tour.title || !tour.title.trim()) {
    errors.push('A tour title is required');
  }
  if (!tour.description || tour.description.trim().length < 10) {
    errors.push('A tour description (at least 10 characters) is required');
  }
  const photos = Array.isArray(tour.photos) ? tour.photos.filter(Boolean) : [];
  if (photos.length === 0) {
    errors.push('Add at least one photo before submitting for review');
  }

  const cat = tour.categorization;
  if (!cat || typeof cat !== 'object' || !cat.category) {
    errors.push('Select a product category');
  }

  const pc = tour.productContent;
  if (!pc || typeof pc !== 'object') {
    errors.push('Product content is required');
  } else {
    if (!pc.writingLanguage) {
      errors.push('Select a language');
    }
    if (!Array.isArray(pc.highlights) || pc.highlights.length < 1) {
      errors.push('Add at least one highlight');
    }
    if (Array.isArray(pc.locations)) {
      for (let i = 0; i < pc.locations.length; i++) {
        const loc = pc.locations[i];
        if (!loc || !loc.name || !String(loc.name).trim()) {
          errors.push(`Location ${i + 1} is missing a name`);
        }
      }
    }
    if (pc.meetingMode === 'meeting_point') {
      const mp = tour.bookingAndTickets?.meetingPoint || pc.meetingPoint;
      if (!mp || !mp.name || !mp.address) {
        errors.push('A meeting point (name and address) is required');
      }
    }
  }

  // Accommodation completeness: when the supplier marks accommodation as
  // included, at least one itinerary day must have a valid overnight type.
  if (cat && cat.accommodationIncluded === true) {
    const dl = (pc && typeof pc === 'object' && pc.dayLogistics) || {};
    const days = Object.values(dl).filter((d) => d && typeof d === 'object');
    const hasAccommodation = days.some((d) => d.accommodation);
    if (!hasAccommodation) {
      errors.push('Select an accommodation type for at least one day (accommodation is included)');
    }
  }

  const pricingErrors = validateStoredPricing(tour.schedulesAndPricing);
  if (pricingErrors.length > 0) {
    errors.push(...pricingErrors);
  }

  return errors;
}

/**
 * Submit tour for review (suppliers only - own tours)
 *
 * Replaces the removed direct-publish path. Full live-quality validation runs
 * here; on success the tour moves to PENDING_APPROVAL and admins are notified.
 * The tour only becomes ACTIVE when an admin approves it.
 *
 * A live tour with a pending draft keeps selling its current approved version
 * while the edits wait in the moderation queue â€” only the draft status changes.
 */
exports.submitTourForReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.supplierId;
  const hasBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length > 0;

  // Money needs somewhere to go â€” a verified payout method is required
  const hasVerifiedMethod = await prisma.payoutMethod.findFirst({
    where: { supplierId, verified: true },
    select: { id: true },
  });
  if (!hasVerifiedMethod) {
    return next(new AppError('You must add and verify at least one payout method before submitting a tour for review', 400));
  }

  // Persist the submitted payload and validate it atomically so the review
  // decision always reflects exactly what the supplier submitted â€” never a
  // stale stored draft. If validation fails the whole transaction rolls back.
  const result = await prisma.$transaction(async (tx) => {
    // Lock the tour row â€” blocks any concurrent autosave PATCH racing this submit
    const [locked] = await tx.$queryRawUnsafe(
      'SELECT id FROM "Tour" WHERE id = $1 AND "supplierId" = $2 FOR UPDATE',
      id, supplierId
    );
    if (!locked) {
      throw new AppError('Tour not found or access denied', 404);
    }

    const tour = await tx.tour.findFirst({
      where: { id, supplierId },
      include: {
        supplier: {
          select: { id: true, name: true, photoURL: true }
        }
      }
    });
    if (!tour) {
      throw new AppError('Tour not found or access denied', 404);
    }

    if (tour.status === 'PENDING_APPROVAL' || tour.draftStatus === 'PENDING_APPROVAL') {
      throw new AppError('This tour is currently pending review. Withdraw the submission to edit it again.', 409);
    }

    const isLiveTour = tour.status === 'ACTIVE';
    const now = new Date();

    // Presence-aware mapping runs here, inside the lock, so it can seed from the
    // CURRENT live row: flat fields in the payload stay authoritative, anything
    // absent keeps its live value â€” productToTour defaults never poison the
    // submitted snapshot for partial payloads.
    if (hasBody) {
      applyFlatToBlobMapping(req.body, tour);
    }

    // The content snapshot that is being submitted (what review validates)
    let submitted;
    // The columns that get written for this submission
    let updateData;

    if (hasBody) {
      // The supplier submitted their current builder state. Build the merged
      // content snapshot exactly like a draft save (photos + rebuilt prices),
      // persist it, then validate THAT â€” the submitted truth, not stored data.
      submitted = buildDraftFromBody(tour, req.body, req.files);
      if (isLiveTour) {
        updateData = {
          draftContent: submitted,
          draftStatus: 'PENDING_APPROVAL',
          draftSubmittedAt: now,
          draftReviewedAt: null,
          draftReviewNote: null,
          status: 'ACTIVE',
        };
      } else {
        updateData = {
          ...(await buildLiveUpdateData(tx, tour, submitted)),
          status: 'PENDING_APPROVAL',
          submittedAt: now,
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        };
      }
    } else {
      // Backward-compatible body-less submit: validate the stored content
      submitted = isLiveTour ? mergeDraftContent(tour, tour.draftContent) : tour;
      updateData = isLiveTour
        ? {
            draftStatus: 'PENDING_APPROVAL',
            draftSubmittedAt: now,
            draftReviewedAt: null,
            draftReviewNote: null,
            status: 'ACTIVE',
          }
        : {
            status: 'PENDING_APPROVAL',
            submittedAt: now,
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: null,
          };
    }

    // Live-quality validation before the tour enters the moderation queue.
    // Throwing inside the transaction rolls back the persist above, so a
    // failed submit never leaves a half-applied draft behind.
    const reviewErrors = validateTourForReview(submitted);
    if (reviewErrors.length > 0) {
      throw new AppError(`Cannot submit for review: ${reviewErrors.join(', ')}`, 400);
    }

    // Idempotent no-op guard: if the submitted content is byte-equivalent to
    // what is ALREADY applied (a live tour's current content, or the content
    // stored for an already-submitted new tour), re-queuing it would only
    // re-notify admins and churn the review pool. First submissions of a new
    // tour (never submittedAt) are exempt â€” the supplier may send their stored
    // builder state as-is. buildTourDiff canonicalizes empty/absence
    // differences exactly like the admin approve path, so a clean diff here is
    // genuinely "no changes".
    const hasLiveOrDraftSubmission =
      isLiveTour ? Boolean(tour.draftSubmittedAt) : Boolean(tour.submittedAt);
    // One canonical diff serves both the no-op guard and the admin changes
    // summary â€” `submitted` is exactly what gets persisted as the draft, so the
    // notifier's merge-based diff would recompute identical trees.
    const contentDiff = buildTourDiff(tour, submitted);
    const noChanges = hasLiveOrDraftSubmission && contentDiff.length === 0;
    if (noChanges) {
      return { noChanges, tour, updated: null };
    }

    const updated = await tx.tour.update({
      where: { id },
      data: updateData,
      include: {
        supplier: {
          select: { id: true, name: true, photoURL: true }
        }
      }
    });

    return { tour, updated, contentDiff };
  });

  const { tour, updated, noChanges, contentDiff } = result;

  // Idempotent duplicate submission: content identical to what is already
  // applied. Respond success (200) without touching the queue, logging
  // activity, or re-notifying admins â€” the frontend gates the button, this is
  // the server-side guarantee for stale retries / API callers.
  if (noChanges) {
    return res.status(200).json({
      status: 'success',
      message: 'No changes to submit â€” the request was ignored',
      data: { noChanges: true, tour }
    });
  }

  const hasDraft = tour.status === 'ACTIVE';

  if (!hasDraft) {
    cache.invalidateTourCaches(id, updated.slug).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));
  }

  await logActivity({
    userId: supplierId,
    action: hasDraft ? 'tour.edit_submitted_for_review' : 'tour.submitted_for_review',
    resource: 'Tour',
    resourceId: tour.id,
    metadata: { title: tour.title }
  });

  // Notify admins (bell + admin-room socket). The changes summary reuses the
  // diff computed against the submitted payload inside the transaction â€”
  // `submitted` IS the persisted draft (updated.draftContent), so the summary
  // never reflects the pre-submission stored draft.
  await notifyAdmin({
    type: 'TOUR_SUBMITTED_FOR_REVIEW',
    title: hasDraft ? 'Tour Update Pending Approval' : 'Tour Pending Approval',
    message: hasDraft
      ? `"${updated.title}" has a pending update submitted for review by ${updated.supplier.name}. The live tour keeps selling.`
      : `"${updated.title}" has been submitted for review by ${updated.supplier.name}`,
    data: {
      tourId: updated.id,
      supplierId,
      tourTitle: updated.title,
      submittedAt: hasDraft ? updated.draftSubmittedAt : updated.submittedAt,
      isResubmission: hasDraft,
      changesSummary: hasDraft ? computeChangesSummary(contentDiff) : undefined,
    },
  });

  res.status(200).json({
    status: 'success',
    message: hasDraft
      ? 'Tour update submitted for review. The live tour keeps selling while an admin reviews your changes.'
      : 'Tour submitted for review. An admin will review it shortly.',
    data: { tour: updated }
  });
});

/**
 * Withdraw a pending submission (suppliers only - own tours)
 *
 * Returns a tour that is currently awaiting review back to a DRAFT state so the
 * supplier can edit it again. Applies to both a new-tour submission (status
 * PENDING_APPROVAL) and a live-tour edit (draftStatus PENDING_APPROVAL).
 */
exports.withdrawTourForReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.supplierId;

  const result = await prisma.$transaction(async (tx) => {
    // Lock the tour row â€” blocks a concurrent admin review racing the withdrawal.
    const [locked] = await tx.$queryRawUnsafe(
      'SELECT id FROM "Tour" WHERE id = $1 AND "supplierId" = $2 FOR UPDATE',
      id, supplierId
    );
    if (!locked) {
      throw new AppError('Tour not found or access denied', 404);
    }

    const tour = await tx.tour.findFirst({ where: { id, supplierId } });
    const isPendingNewTour = tour.status === 'PENDING_APPROVAL';
    const isPendingDraft = tour.draftStatus === 'PENDING_APPROVAL';
    if (!isPendingNewTour && !isPendingDraft) {
      throw new AppError('This tour is not currently awaiting review', 400);
    }

    return tx.tour.update({
      where: { id },
      data: isPendingDraft
        ? { draftStatus: 'DRAFT', draftReviewedAt: null, draftReviewNote: null }
        : { status: 'DRAFT', submittedAt: null, reviewedBy: null, reviewedAt: null, reviewNote: null },
      include: {
        supplier: {
          select: { id: true, name: true, photoURL: true }
        }
      }
    });
  });

  await logActivity({
    userId: supplierId,
    action: 'tour.withdrawn_from_review',
    resource: 'Tour',
    resourceId: id,
    metadata: { title: result.title },
  });

  res.status(200).json({
    status: 'success',
    message: 'Tour withdrawn from review. You can now edit it again.',
    data: { tour: result }
  });
});

/**
 * Get the pending draft for a tour with its diff against the live version.
 * (suppliers only - own tours)
 */
exports.getTourDraft = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.supplierId;

  const tour = await prisma.tour.findFirst({ where: { id, supplierId } });
  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  const live = tourContentSnapshot(tour);
  const draft = tour.draftContent && typeof tour.draftContent === 'object'
    ? mergeDraftContent(tour, tour.draftContent)
    : null;
  const diff = draft ? buildTourDiff(live, draft) : [];

  res.status(200).json({
    status: 'success',
    data: {
      tourId: tour.id,
      status: tour.status,
      draftStatus: tour.draftStatus || null,
      draftSubmittedAt: tour.draftSubmittedAt || null,
      draftReviewNote: tour.draftReviewNote || null,
      live,
      draft,
      diff,
      changesSummary: computeChangesSummary(diff),
    },
  });
});

/**
 * Delete tour (suppliers only - own tours)
 *
 * Deletion is blocked only by CONFIRMED bookings (paid, real commitments).
 * PENDING bookings (payment never succeeded â€” checkout abandoned) are
 * auto-cancelled as part of the deletion so suppliers are not locked out
 * of their own tours forever by stale, unpaid checkout rows.
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

  // Check for confirmed (paid) bookings â€” real commitments, block deletion
  const confirmedBookings = tour.bookings.filter((b) => b.status === 'CONFIRMED');
  if (confirmedBookings.length > 0) {
    return next(new AppError('Cannot delete tour with confirmed bookings. Cancel them first.', 400));
  }

  // Auto-cancel any PENDING bookings left behind by abandoned checkouts.
  // Rules (GetYourGuide-style):
  //  - CONFIRMED blocks (above) â€” always honored.
  //  - A PENDING booking with a live Stripe charge (paymentStatus PROCESSING)
  //    is only safe to cancel once Stripe confirms the intent is cancelable.
  //    If the money already went through (succeeded) or the intent is stuck
  //    in flight, block the delete instead of silently cancelling a charged
  //    booking.
  //  - PENDING bookings without a live charge (abandoned, failed, expired)
  //    are cancelled locally.
  const pendingBookings = tour.bookings.filter((b) => b.status === 'PENDING');
  const livePayments = pendingBookings.filter(
    (b) => b.stripePaymentIntentId && b.paymentStatus === 'PROCESSING'
  );

  for (const booking of livePayments) {
    const result = await cancelPaymentIntent(booking.stripePaymentIntentId);
    if (!result.ok) {
      if (result.reason === 'status_succeeded') {
        return next(new AppError('Cannot delete this tour: a payment for it already succeeded and is being confirmed. Please handle that booking before deleting.', 409));
      }
      return next(new AppError('A payment for this tour is currently in flight. Please try deleting it again in a few minutes.', 409));
    }
  }

  if (pendingBookings.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.booking.updateMany({
        where: {
          id: { in: pendingBookings.map((b) => b.id) },
          status: 'PENDING'
        },
        data: {
          status: 'CANCELLED',
          cancellationReason: 'Tour deleted by supplier',
          cancelledAt: new Date()
        }
      });
    });
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

  cache.invalidateTourCaches(id, tour.slug).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

  await logActivity({
    userId: supplierId,
    action: 'tour.deleted',
    resource: 'Tour',
    resourceId: tour.id,
    oldValues: {
      title: tour.title,
      status: tour.status,
      price: tour.price,
      isFeatured: tour.isFeatured,
      destination: tour.destination,
    },
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
        },
        expeditionTour: {
          select: {
            isActive: true,
            bookingFlow: true,
            externalUrl: true
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
      photos: tour.photos,
      coverPhoto: tour.coverPhoto || null,
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
    select: { id: true, slug: true, photos: true, coverPhoto: true, title: true }
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

  cache.invalidateTourCaches(id, tour.slug).catch((err) => logger.warn('[cache] invalidateTourCaches failed:', err?.message));

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
  const slug = await createSlug(title, prisma);

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
      ...(seedData.theme.secondary?.length > 0
        ? { secondaryThemes: { create: seedData.theme.secondary.map(t => ({ theme: t })) } }
        : {}),
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
  const { promoCode, tourId, selectedDate, basePrice, quantity, tourOptionKey } = req.body;

  if (!promoCode || promoCode.length < 3) {
    return next(new AppError('Promo code must be at least 3 characters', 400));
  }
  if (!tourId) {
    return next(new AppError('Tour ID is required', 400));
  }
  if (!selectedDate) {
    return next(new AppError('Selected date is required', 400));
  }

  const { findBestDiscount, findApplicableOffers } = require('../utils/specialOfferEngine');
  const effectiveOptionKey = tourOptionKey || null;

  const offers = await findApplicableOffers({
    tourId,
    tourOptionKey: effectiveOptionKey,
    selectedDate: new Date(selectedDate),
    promoCode,
    customerId: req.user?.id,
  });

  if (offers.length === 0) {
    return res.json({
      status: 'success',
      data: { valid: false, message: 'Invalid or expired promo code for this tour/date' },
    });
  }

  const offer = offers[0];

  // Derive the concrete discount so the client never has to re-derive it.
  // If the client doesn't send a basePrice, fall back to the tour's adult
  // price so the endpoint still works for simple "is my code valid?" checks.
  let effectiveBasePrice = basePrice ?? null;

  if (effectiveBasePrice == null) {
    const tour = await prisma.tour.findFirst({
      where: { id: tourId, status: 'ACTIVE' },
      select: { schedulesAndPricing: true },
    });
    if (tour) {
      const parsed = typeof tour.schedulesAndPricing === 'string'
        ? (() => { try { return JSON.parse(tour.schedulesAndPricing); } catch { return null; } })()
        : tour.schedulesAndPricing;
      // Tier-aware: the cheapest retail price (lowest tier pricePerPerson, or
      // the base/adult price when the tour has no tiers) so quoted discounts
      // match what a real checkout computes via calculateTourPrice.
      const numeric = cheapestRetailPrice(parsed);
      if (numeric != null) effectiveBasePrice = numeric;
    }
  }
  if (effectiveBasePrice == null) {
    return next(new AppError('Unable to determine the tour price — provide basePrice to validate the code', 400));
  }

  const result = await findBestDiscount({
    tourId,
    tourOptionKey: effectiveOptionKey,
    selectedDate: new Date(selectedDate),
    basePrice: effectiveBasePrice,
    quantity: quantity ?? 1,
    promoCode,
    customerId: req.user?.id,
  });

  const appliedOffers = Array.isArray(result.appliedOffer)
    ? result.appliedOffer
    : [result.appliedOffer].filter(Boolean);

  res.json({
    status: 'success',
    data: {
      valid: result.discountAmount > 0,
      message: result.discountAmount > 0
        ? 'Promo code applied'
        : 'Promo code does not meet the offer conditions for this booking',
      offer: {
        id: offer.id,
        name: offer.name,
        offerType: offer.offerType,
        discountType: offer.discountType,
        discountPercentage: offer.discountPercentage,
        fixedDiscountValue: offer.fixedDiscountValue,
      },
      discount: {
        amount: result.discountAmount,
        type: result.discountType,
        basePrice: effectiveBasePrice,
        finalPrice: result.finalPrice,
        appliedOffers,
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
  if (min !== null) {
    params.push(min);
    clauses.push(`safePrice >= $${params.length}`);
  }
  if (max !== null) {
    params.push(max);
    clauses.push(`safePrice <= $${params.length}`);
  }

  // `safePrice` guards against legacy rows where retailPrice is a non-numeric
  // string â€” those become NULL and simply never match, instead of throwing.
  const sql = `
    SELECT DISTINCT t.id
    FROM "Tour" t,
         jsonb_array_elements(t."schedulesAndPricing"->'pricingSchedules'->'schedules') AS s,
         jsonb_array_elements(s->'prices') AS p
    CROSS JOIN LATERAL (
      SELECT CASE WHEN p->>'retailPrice' ~ '^[+-]?[0-9]+(\\.[0-9]+)?$'
        THEN (p->>'retailPrice')::numeric ELSE NULL END AS "safePrice"
    ) sp
    WHERE (LOWER(p->>'ageGroup') = 'adult' OR COALESCE((p->>'groupSize')::boolean, false) = true)
      AND ${clauses.join(' AND ')}
  `;

  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  const ids = rows.map(r => r.id);
  return ids.length > 0 ? ids : false;
}

/**
 * Upsert a special offer by promoCode.
 * - If promoCode exists and belongs to the same supplier â†’ update it + ensure tour target.
 * - If promoCode belongs to a different supplier â†’ skip (log warning).
 * - If promoCode is null or not found â†’ create a new offer.
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
    // id provided not found for this supplier â€” fall through to create
  }

  // No id or id not found: try upsert by promoCode
  if (!offer.promoCode) {
    return prisma.specialOffer.create({
      data: {
        supplierId,
        name: offer.name || 'Special Offer',
        offerType: offer.offerType || 'LIMITED_TIME',
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
      console.warn(`Promo code "${offer.promoCode}" belongs to another supplier â€” skipping`);
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
      offerType: offer.offerType || 'LIMITED_TIME',
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
