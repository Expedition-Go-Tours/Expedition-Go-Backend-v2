const crypto = require('crypto');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const cache = require('../utils/cacheHelper');
const { sendEmail } = require('../utils/emailService');
const { enqueueEvent, enqueueEmail, enqueueNotification } = require('../utils/queue');
const { validateTravelerInfo, generateBookingNumber, evaluateCancellationPolicy, isValidEmail } = require('../utils/bookingHelpers');
const { checkTourAvailability, calculateTourPrice, cheapestRetailPrice } = require('../utils/tourHelpers');
const { evaluateBookingAvailability, resolveSlotCutoffHours, cutoffLabel, getTourTimezone, zonedDateKey, zonedTimeToUtc, toDateKey, travelerCount, parseBlob } = require('../utils/availabilityCore');
const { resolvePickupSelection, normalizePickupSnapshot } = require('../utils/geoUtils');
const { validatePassengerMix } = require('../utils/passengerMix');
const { createPaymentIntent, createCheckoutSession, calculateCommission, createRefund, getStripe, ensureStripeCustomer } = require('../utils/stripeHelpers');
const { acquireHold, releaseHold, HOLD_MINUTES } = require('../utils/checkoutHold');
const { notifyAdmin } = require('../utils/adminNotificationService');
const getConfig = require('../utils/getConfig');
const { detachBookingFromActiveRequests } = require('../utils/financeHelpers');
const { logActivity } = require('../utils/auditLogger');
const { shouldCountTourView } = require('../utils/viewTracking');
const ranking = require('../utils/homepageRanking');
const eventEmitter = require('../utils/eventEmitter');

const CACHE_PREFIX = 'expedition:';
const LIST_CACHE_KEY = `${CACHE_PREFIX}tours:list`;
const FEATURED_CACHE_KEY = `${CACHE_PREFIX}tours:featured`;
const DETAIL_CACHE_KEY = (slug) => `${CACHE_PREFIX}detail:${slug}`;
const SITEMAP_CACHE_KEY = `${CACHE_PREFIX}sitemap`;
const CHECKOUT_CACHE_TTL = 60;

/**
 * Cheapest price a card can quote as "From $X" — the lowest price of the
 * ADULT tier (per-person base + tier prices, min across schedules), falling
 * back to the per-group minimum band / uniform price / legacy schedule
 * prices. Delegates to tourHelpers.cheapestRetailPrice so every surface
 * (homepage, listings, blog, promo previews) quotes the same adult price.
 */
function extractStartingPrice(schedulesAndPricing) {
  return cheapestRetailPrice(schedulesAndPricing);
}

function extractCurrency(schedulesAndPricing) {
  if (!schedulesAndPricing) return 'USD';
  try {
    const sp = typeof schedulesAndPricing === 'string'
      ? JSON.parse(schedulesAndPricing)
      : schedulesAndPricing;
    return sp?.pricingSchedules?.currency || 'USD';
  } catch {
    return 'USD';
  }
}

function transformForListing(tour, expeditionRecord) {
  // Map specialOfferTargets to the shape the frontend expects
  const specialOffers = Array.isArray(tour.specialOfferTargets)
    ? tour.specialOfferTargets
        .filter((t) => t && t.specialOffer)
        .map((t) => ({
          id: t.specialOffer.id,
          name: t.specialOffer.name || '',
          offerType: t.specialOffer.offerType,
          discountType: t.specialOffer.discountType,
          discountPercentage: t.specialOffer.discountPercentage,
          fixedDiscountValue: t.specialOffer.fixedDiscountValue,
          startDate: t.specialOffer.startDate,
          endDate: t.specialOffer.endDate,
          promoCode: t.specialOffer.promoCode || null,
        }))
    : undefined;

  return {
    id: tour.id,
    title: tour.title,
    slug: tour.slug,
    description: tour.description
      ? tour.description.length > 300
        ? tour.description.slice(0, 297) + '...'
        : tour.description
      : null,
    coverPhoto: tour.coverPhoto || null,
    photos: Array.isArray(tour.photos) ? tour.photos : [],
    category: tour.category,
    durationMinutes: tour.durationMinutes,
    startingPrice: extractStartingPrice(tour.schedulesAndPricing),
    currency: extractCurrency(tour.schedulesAndPricing),
    averageRating: tour.averageRating ? Number(tour.averageRating) : null,
    reviewCount: tour.reviewCount,
    viewCount: tour.viewCount,
    city: tour.city,
    country: tour.country,
    supplierName: tour.supplier?.name || null,
    supplierPhoto: tour.supplier?.photoURL
      ? tour.supplier.photoURL
      : null,
    bookingFlow: expeditionRecord?.bookingFlow || null,
    externalUrl: expeditionRecord?.externalUrl || null,
    ...(specialOffers ? { specialOffers } : {}),
  };
}

function buildTourSchemaUrl(tour) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: tour.title,
    description: tour.description ? tour.description.slice(0, 500) : undefined,
    image: tour.coverPhoto || (tour.photos?.[0]) || undefined,
    offers: {
      '@type': 'Offer',
      price: tour.startingPrice ?? undefined,
      priceCurrency: tour.currency ?? 'USD',
      availability: 'https://schema.org/InStock',
      url: `https://travioafrica.com/tour/${tour.slug}`,
    },
    ...(tour.averageRating
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: tour.averageRating,
            reviewCount: tour.reviewCount || 0,
          },
        }
      : {}),
  };
}

async function invalidateCaches(slug) {
  await cache.invalidateKeys([LIST_CACHE_KEY, FEATURED_CACHE_KEY, SITEMAP_CACHE_KEY]);
  if (slug) {
    await cache.invalidateKeys([DETAIL_CACHE_KEY(slug)]);
  }
}

// ================================
// PUBLIC ENDPOINTS
// ================================

exports.getTours = catchAsync(async (req, res) => {
  const { page = 1, limit = 12, search, category, city, country, minPrice, maxPrice, sortBy, mood } = req.query;

  const cacheKey = `${LIST_CACHE_KEY}:${crypto.createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const tourWhere = {
      status: 'ACTIVE',
      supplier: { supplierProfile: { status: 'ACTIVE' } },
    };
    if (category) tourWhere.category = category;
    if (city) tourWhere.city = city;
    if (country) tourWhere.country = country;
    // Mood keyword filtering: case-insensitive tag matching
    let moodTourIds = null;
    if (mood) {
      const KEYWORD_CATEGORIES = require('../utils/keywordCategories');
      if (KEYWORD_CATEGORIES && KEYWORD_CATEGORIES[mood]) {
        const keywords = KEYWORD_CATEGORIES[mood].map(k => k.toLowerCase());
        if (keywords.length > 0) {
          const matchingTours = await prisma.tour.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true, tags: true },
          });
          moodTourIds = matchingTours
            .filter(t => t.tags.some(tag => keywords.includes(tag.toLowerCase())))
            .map(t => t.id);
          if (moodTourIds.length === 0) {
            moodTourIds = ['__no_match__'];
          }
        }
      }
    }
    if (moodTourIds) {
      tourWhere.id = { in: moodTourIds };
    }
    if (search) {
      // Use BM25 for relevance-ranked search when available
      const bm25 = require('../utils/bm25Index');
      if (bm25.isReady()) {
        const results = bm25.search(search, 100);
        if (results.length > 0) {
          const bm25Ids = results.map(r => r.tourId);
          // Intersect with existing ID filter if present
          if (tourWhere.id?.in) {
            tourWhere.id.in = tourWhere.id.in.filter(id => bm25Ids.includes(id));
          } else {
            tourWhere.id = { in: bm25Ids };
          }
        } else {
          // No BM25 results — return empty
          tourWhere.id = { in: [] };
        }
      } else {
        // Fallback to substring matching when BM25 index isn't ready
        tourWhere.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { city: { contains: search, mode: 'insensitive' } },
          { country: { contains: search, mode: 'insensitive' } },
          { category: { contains: search, mode: 'insensitive' } },
        ];
      }
    }

    const orderBy = [{ displayOrder: 'asc' }];
    // Prisma relation ordering uses simple 'asc'/'desc' — the { sort, nulls }
    // object form is only valid for top-level columns, not nested relations.
    // Nulls-last is the default for descending order.
    if (sortBy === 'rating') orderBy.unshift({ tour: { averageRating: 'desc' } });
    else if (sortBy === 'newest') orderBy.unshift({ createdAt: 'desc' });
    else if (sortBy === 'popular') orderBy.unshift({ tour: { reviewCount: 'desc' } });
    else if (sortBy === 'views') orderBy.unshift({ tour: { viewCount: 'desc' } });
    else if (sortBy === 'price_asc' || sortBy === 'price_desc') {
      orderBy.unshift({ createdAt: sortBy === 'price_asc' ? 'asc' : 'desc' });
    }

    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
    const take = Math.min(parseInt(limit), 50);

    const fetchLimit = sortBy === 'price_asc' || sortBy === 'price_desc'
      ? Math.min(500, Math.max(take, parseInt(page) * take))
      : take;

    let records = await prisma.expeditionTour.findMany({
      where: { isActive: true, tour: tourWhere },
      orderBy,
      skip: sortBy === 'price_asc' || sortBy === 'price_desc' ? 0 : skip,
      take: fetchLimit,
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, description: true,
            coverPhoto: true, photos: true, category: true,
            durationMinutes: true, averageRating: true, reviewCount: true, viewCount: true,
            city: true, country: true, schedulesAndPricing: true,
            supplier: { select: { name: true, photoURL: true } },
            specialOfferTargets: {
              where: {
                specialOffer: {
                  isActive: true,
                  AND: [
                    { OR: [{ startDate: null }, { startDate: { lte: new Date() } }] },
                    { OR: [{ endDate: null }, { endDate: { gte: new Date() } }] },
                  ],
                },
              },
              include: { specialOffer: true },
            },
          },
        },
      },
    });

    if (sortBy === 'price_asc' || sortBy === 'price_desc') {
      records.sort((a, b) => {
        const priceA = extractStartingPrice(a.tour.schedulesAndPricing) ?? Infinity;
        const priceB = extractStartingPrice(b.tour.schedulesAndPricing) ?? Infinity;
        return sortBy === 'price_asc' ? priceA - priceB : priceB - priceA;
      });
      records = records.slice(skip, skip + take);
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      records = records.filter((r) => {
        const price = extractStartingPrice(r.tour.schedulesAndPricing);
        if (price === null) return false;
        if (minPrice !== undefined && price < Number(minPrice)) return false;
        if (maxPrice !== undefined && price > Number(maxPrice)) return false;
        return true;
      });
    }

    const totalCount = await prisma.expeditionTour.count({ where: { isActive: true, tour: tourWhere } });
    const totalPages = Math.ceil(totalCount / take);

    return {
      status: 'success',
      data: {
        tours: records.map((r) => ({
          id: r.id,
          displayOrder: r.displayOrder,
          isFeatured: r.isFeatured,
          bookingFlow: r.bookingFlow,
          externalUrl: r.externalUrl,
          tour: transformForListing(r.tour, r),
        })),
      },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: take,
      },
    };
  }, 300);

  res.status(200).json(result);
});

exports.getFeaturedTours = catchAsync(async (req, res) => {
  const result = await cache.getOrSet(FEATURED_CACHE_KEY, async () => {
    const records = await prisma.expeditionTour.findMany({
      where: { isActive: true, isFeatured: true, tour: { status: 'ACTIVE', supplier: { supplierProfile: { status: 'ACTIVE' } } } },
      orderBy: { displayOrder: 'asc' },
      take: 8,
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, description: true,
            coverPhoto: true, photos: true, category: true,
            durationMinutes: true, averageRating: true, reviewCount: true, viewCount: true,
            city: true, country: true, schedulesAndPricing: true,
            supplier: { select: { name: true, photoURL: true } },
          },
        },
      },
    });

    return {
      status: 'success',
      data: {
        tours: records.map((r) => ({
          id: r.id,
          displayOrder: r.displayOrder,
          isFeatured: r.isFeatured,
          bookingFlow: r.bookingFlow,
          externalUrl: r.externalUrl,
          tour: transformForListing(r.tour, r),
        })),
      },
    };
  }, 300);

  res.status(200).json(result);
});

/**
 * GET /expedition/tours/badges
 *
 * Lightweight endpoint returning only badge fields for all active tours.
 * Used by the frontend to enrich tour cards with "Pickup included",
 * "Free cancellation", "English Guide" badges without fetching full tour data.
 */
exports.getTourBadges = catchAsync(async (req, res) => {
  const result = await cache.getOrSet('expedition:badges', async () => {
    const tours = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        supplier: { supplierProfile: { status: 'ACTIVE' } },
      },
      select: {
        id: true,
        slug: true,
        difficulty: true,
        bookingAndTickets: true,
        productContent: true,
        categorization: true,
      },
    });

    // Extract badge fields from JSON blobs server-side for a smaller payload
    const badges = tours.map((t) => {
      const bt = typeof t.bookingAndTickets === 'object' && t.bookingAndTickets !== null ? t.bookingAndTickets : {};
      const pc = typeof t.productContent === 'object' && t.productContent !== null ? t.productContent : {};
      const cat = typeof t.categorization === 'object' && t.categorization !== null ? t.categorization : {};

      return {
        id: t.id,
        slug: t.slug,
        difficulty: t.difficulty || null,
        pickupIncluded: bt.pickupProvided || bt.pickupAvailable || false,
        cancellationPolicy: typeof bt.cancellationPolicy === 'string'
          ? bt.cancellationPolicy
          : bt.cancellationPolicy?.label || null,
        languages: pc.writingLanguage ? [pc.writingLanguage] : (cat.languages || []),
        meetingMode: bt.meetingMode || null,
        accommodationIncluded: !!cat.accommodationIncluded,
      };
    });

    return { status: 'success', data: { tours: badges } };
  }, 300);

  res.status(200).json(result);
});

exports.getTourReviews = catchAsync(async (req, res, next) => {
  const { slug } = req.params;
  const { page = 1, limit = 10, sortBy = 'newest' } = req.query;
  const cacheKey = `expedition:reviews:${slug}:${page}:${limit}:${sortBy}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const expeditionTour = await prisma.expeditionTour.findFirst({
      where: { tour: { slug }, isActive: true },
      select: { tourId: true },
    });

    if (!expeditionTour) return null;

    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
    const take = Math.min(parseInt(limit), 50);

    const orderBy = sortBy === 'highest' ? { rating: 'desc' }
      : sortBy === 'lowest' ? { rating: 'asc' }
      : { createdAt: 'desc' };

    const where = { tourId: expeditionTour.tourId, status: 'APPROVED' };

    const [reviews, totalCount, aggregateRating] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy,
        skip,
        take,
        include: { customer: { select: { id: true, name: true, photoURL: true } } },
      }),
      prisma.review.count({ where }),
      prisma.review.aggregate({ where, _avg: { rating: true } }),
    ]);

    const totalPages = Math.ceil(totalCount / take);

    return {
      status: 'success',
      data: {
        reviews,
        averageRating: aggregateRating._avg.rating ? Math.round(aggregateRating._avg.rating * 10) / 10 : null,
        totalCount,
      },
      pagination: { currentPage: parseInt(page), totalPages, totalCount, limit: take },
    };
  }, 300);

  if (!result) return next(new AppError('Tour not found', 404));
  res.status(200).json(result);
});

exports.getSimilarTours = catchAsync(async (req, res, next) => {
  const { slug } = req.params;
  const cacheKey = `expedition:similar:${slug}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const expeditionTour = await prisma.expeditionTour.findFirst({
      where: { tour: { slug }, isActive: true },
      include: {
        tour: {
          select: {
            id: true, category: true, tags: true, city: true, country: true,
            latitude: true, longitude: true, averageRating: true, totalBookings: true,
            clipEmbedding: true, aiPrimaryCategory: true, aiMoodTags: true,
            schedulesAndPricing: true,
          },
        },
      },
    });

    if (!expeditionTour) return null;

    const currentTour = expeditionTour.tour;

    // Fetch candidates: same category OR same city OR same AI category
    const candidates = await prisma.expeditionTour.findMany({
      where: {
        isActive: true,
        tour: {
          status: 'ACTIVE',
          supplier: { supplierProfile: { status: 'ACTIVE' } },
          id: { not: currentTour.id },
          OR: [
            { category: currentTour.category },
            { city: currentTour.city },
            { aiPrimaryCategory: currentTour.aiPrimaryCategory },
          ],
        },
      },
      take: 20, // over-fetch for ranking
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, coverPhoto: true, photos: true,
            category: true, durationMinutes: true, averageRating: true,
            reviewCount: true, city: true, country: true, tags: true,
            latitude: true, longitude: true, totalBookings: true,
            clipEmbedding: true, aiPrimaryCategory: true, aiMoodTags: true,
            schedulesAndPricing: true,
            supplier: { select: { name: true, photoURL: true } },
          },
        },
      },
    });

    // Score each candidate using CLIP + XGBoost
    const xgboost = require('../utils/xgboostService');
    const currentTags = new Set([...(currentTour.tags || []), ...(currentTour.aiMoodTags || [])]);

    // Parse current tour price for range similarity
    let currentPrice = 0;
    try {
      const pricing = currentTour.schedulesAndPricing;
      if (pricing?.pricingSchedules?.[0]?.price) {
        currentPrice = parseFloat(pricing.pricingSchedules[0].price) || 0;
      }
    } catch {}

    const scored = candidates.map(r => {
      const t = r.tour;
      let score = 0;

      // 1. Category match (30%)
      if (t.category === currentTour.category) score += 0.30;
      else if (t.aiPrimaryCategory === currentTour.aiPrimaryCategory) score += 0.20;

      // 2. Tag overlap (20%)
      const candidateTags = new Set([...(t.tags || []), ...(t.aiMoodTags || [])]);
      let tagOverlap = 0;
      for (const tag of currentTags) {
        if (candidateTags.has(tag)) tagOverlap++;
      }
      const tagScore = currentTags.size > 0 ? tagOverlap / currentTags.size : 0;
      score += tagScore * 0.20;

      // 3. CLIP embedding similarity (25%)
      if (currentTour.clipEmbedding && t.clipEmbedding) {
        const similarity = xgboost.cosineSimilarity(currentTour.clipEmbedding, t.clipEmbedding);
        score += similarity * 0.25;
      } else {
        // No CLIP data — distribute weight to other signals
        score += 0.125; // neutral
      }

      // 4. Location proximity (15%)
      if (currentTour.latitude && currentTour.longitude && t.latitude && t.longitude) {
        const dist = xgboost.haversineKm(currentTour.latitude, currentTour.longitude, t.latitude, t.longitude);
        const proximityScore = Math.max(0, 1 - dist / 200); // 200km range
        score += proximityScore * 0.15;
      } else if (t.city === currentTour.city) {
        score += 0.10; // same city bonus
      }

      // 5. Quality signal (10%)
      const ratingScore = t.averageRating ? parseFloat(t.averageRating) / 5 : 0.5;
      score += ratingScore * 0.10;

      return { record: r, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);
    const topTours = scored.slice(0, 4);

    return {
      status: 'success',
      data: {
        tours: topTours.map(({ record: r }) => ({
          id: r.id,
          tour: transformForListing(r.tour),
        })),
      },
    };
  }, 600); // Cache for 10 minutes

  if (!result) return next(new AppError('Tour not found', 404));
  res.status(200).json(result);
});

/**
 * GET /expedition/tours/recommended?tourId=xxx
 *
 * Returns 6 recommended tours near the given tour's location. Used by the
 * booking workspace to show "More popular experiences near {city}".
 *
 * The source tour is looked up by ID. We then find other active Expedition
 * tours in the same city, falling back to the same country if fewer than 3
 * city matches exist. The source tour is excluded from results.
 *
 * Optional query params:
 *   - limit (1-12, default 6)
 *   - exclude (tourId to exclude, defaults to the source tour)
 */
exports.getRecommendedTours = catchAsync(async (req, res, next) => {
  const { tourId } = req.query;
  if (!tourId) return next(new AppError('tourId is required', 400));

  const limit = Math.min(parseInt(req.query.limit) || 6, 12);
  const cacheKey = `expedition:recommended:${tourId}:${limit}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    // 1. Look up the source tour to get its location
    const source = await prisma.tour.findUnique({
      where: { id: tourId },
      select: { id: true, city: true, country: true, category: true, productContent: true },
    });

    if (!source) return null;

    // Resolve city/country from indexed fields or fall back to productContent.location
    const pc = source.productContent && typeof source.productContent === 'object' ? source.productContent : {};
    const sourceCity = source.city || pc.location?.city || null;
    const sourceCountry = source.country || pc.location?.country || null;

    // 2. Same-city tours first (highest relevance)
    let tours = await prisma.expeditionTour.findMany({
      where: {
        isActive: true,
        tour: {
          status: 'ACTIVE',
          supplier: { supplierProfile: { status: 'ACTIVE' } },
          id: { not: source.id },
          ...(sourceCity ? { city: sourceCity } : {}),
        },
      },
      take: limit,
      orderBy: [{ tour: { averageRating: 'desc' } }, { tour: { reviewCount: 'desc' } }],
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, description: true,
            coverPhoto: true, photos: true, category: true,
            durationMinutes: true, averageRating: true, reviewCount: true, viewCount: true,
            city: true, country: true, schedulesAndPricing: true, createdAt: true,
            supplier: { select: { name: true, photoURL: true } },
            specialOfferTargets: {
              where: { specialOffer: { isActive: true } },
              include: { specialOffer: { select: { id: true, name: true, offerType: true, discountType: true, discountPercentage: true, fixedDiscountValue: true, startDate: true, endDate: true, promoCode: true } } },
            },
          },
        },
      },
    });

    // 3. If fewer than 3 city matches, backfill with same-country tours
    if (sourceCountry && tours.length < 3) {
      const existingIds = new Set([source.id, ...tours.map((r) => r.tour.id)]);
      const countryTours = await prisma.expeditionTour.findMany({
        where: {
          isActive: true,
          tour: {
            status: 'ACTIVE',
            supplier: { supplierProfile: { status: 'ACTIVE' } },
            id: { notIn: [...existingIds] },
            country: sourceCountry,
          },
        },
        take: limit - tours.length,
        orderBy: [{ tour: { averageRating: 'desc' } }, { tour: { reviewCount: 'desc' } }],
        include: {
          tour: {
            select: {
              id: true, title: true, slug: true, description: true,
              coverPhoto: true, photos: true, category: true,
              durationMinutes: true, averageRating: true, reviewCount: true, viewCount: true,
              city: true, country: true, schedulesAndPricing: true,
              supplier: { select: { name: true, photoURL: true } },
              specialOfferTargets: {
                where: { specialOffer: { isActive: true } },
                include: { specialOffer: { select: { id: true, name: true, offerType: true, discountType: true, discountPercentage: true, fixedDiscountValue: true, startDate: true, endDate: true, promoCode: true } } },
              },
            },
          },
        },
      });
      tours = [...tours, ...countryTours];
    }

    // 4. 404 fallback: if still no tours, try broad fetch
    if (tours.length === 0) {
      tours = await prisma.expeditionTour.findMany({
        where: {
          isActive: true,
          tour: {
            status: 'ACTIVE',
            supplier: { supplierProfile: { status: 'ACTIVE' } },
            id: { not: source.id },
          },
        },
        take: limit,
        orderBy: [{ tour: { reviewCount: 'desc' } }],
        include: {
          tour: {
            select: {
              id: true, title: true, slug: true, description: true,
              coverPhoto: true, photos: true, category: true,
              durationMinutes: true, averageRating: true, reviewCount: true, viewCount: true,
              city: true, country: true, schedulesAndPricing: true,
              supplier: { select: { name: true, photoURL: true } },
              specialOfferTargets: {
                where: { specialOffer: { isActive: true } },
                include: { specialOffer: { select: { id: true, name: true, offerType: true, discountType: true, discountPercentage: true, fixedDiscountValue: true, startDate: true, endDate: true, promoCode: true } } },
              },
            },
          },
        },
      });
    }

    // Tag results with the site-wide signals the cards render: "New" for
    // tours created in the last 30 days (same window as the homepage New
    // Experiences section) and "Likely to sell out" when the tour is already
    // on the homepage sell-out list — matching how the rest of the site tags
    // cards so the BookingWorkspace recommended carousel stays consistent.
    const NEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const sellOutIds = new Set();
    try {
      const sellOutTours = await ranking.getLikelySellOut(50, null, false, true);
      for (const t of (sellOutTours || [])) {
        if (t && t.id) sellOutIds.add(t.id);
      }
    } catch (err) {
      console.warn('[expedition] recommended sell-out lookup failed:', err.message);
    }

    return {
      status: 'success',
      data: {
        location: sourceCity || sourceCountry || '',
        tours: tours.map((r) => {
          const listing = transformForListing(r.tour, r);
          const createdAt = r.tour.createdAt ? new Date(r.tour.createdAt) : null;
          listing.isNew = !!(createdAt && !Number.isNaN(createdAt.getTime()) && (Date.now() - createdAt.getTime()) <= NEW_WINDOW_MS);
          listing.likelyToSellOut = sellOutIds.has(r.tour.id);
          return { id: r.id, tour: listing };
        }),
      },
    };
  }, 300);

  if (!result) return next(new AppError('Source tour not found', 404));
  res.status(200).json(result);
});

exports.getSupplierTours = catchAsync(async (req, res, next) => {
  const { supplierId } = req.params;
  const excludeTourId = req.query.exclude || null;
  const limit = Math.min(parseInt(req.query.limit) || 8, 20);

  const cacheKey = `expedition:supplier-tours:${supplierId}:${excludeTourId || 'none'}:${limit}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const tours = await prisma.expeditionTour.findMany({
      where: {
        isActive: true,
        tour: {
          status: 'ACTIVE',
          supplierId,
          supplier: { supplierProfile: { status: 'ACTIVE' } },
          ...(excludeTourId ? { id: { not: excludeTourId } } : {}),
        },
      },
      take: limit,
      orderBy: { tour: { averageRating: 'desc' } },
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, description: true,
            coverPhoto: true, photos: true, category: true,
            durationMinutes: true, averageRating: true, reviewCount: true,
            city: true, country: true, tags: true, startingPrice: true,
            currency: true, totalBookings: true,
            supplier: { select: { id: true, name: true, photoURL: true } },
          },
        },
      },
    });

    return tours.map(r => ({
      id: r.id,
      tour: transformForListing(r.tour),
    }));
  }, 600);

  if (!result) return res.json({ status: 'success', data: { tours: [] } });
  res.status(200).json(result);
});

exports.getTourBySlug = catchAsync(async (req, res, next) => {
  const { slug } = req.params;

  const result = await cache.getOrSet(DETAIL_CACHE_KEY(slug), async () => {
    const record = await prisma.expeditionTour.findFirst({
      where: { isActive: true, tour: { slug, status: 'ACTIVE', supplier: { supplierProfile: { status: 'ACTIVE' } } } },
      include: {
        tour: {
          include: {
            supplier: {
              select: {
                id: true, name: true, photoURL: true,
                supplierProfile: {
                  select: { averageRating: true, totalBookings: true },
                },
              },
            },
            _count: { select: { reviews: true } },
          },
        },
      },
    });

    if (!record) return null;

    const t = record.tour;
    const productContent =
      typeof t.productContent === 'string'
        ? JSON.parse(t.productContent)
        : t.productContent || {};
    const bookingAndTickets =
      typeof t.bookingAndTickets === 'string'
        ? JSON.parse(t.bookingAndTickets)
        : t.bookingAndTickets || {};

    const tourData = {
      id: t.id,
      title: t.title,
      slug: t.slug,
      description: t.description,
      coverPhoto: t.coverPhoto || null,
    photos: Array.isArray(t.photos) ? t.photos : [],
      category: t.category,
      durationMinutes: t.durationMinutes,
      startingPrice: extractStartingPrice(t.schedulesAndPricing),
      currency: extractCurrency(t.schedulesAndPricing),
      averageRating: t.averageRating ? Number(t.averageRating) : null,
      reviewCount: t._count?.reviews || 0,
      city: t.city,
      country: t.country,
      highlights: productContent.highlights || [],
      included: productContent.included || [],
      whatToBring: productContent.whatToBring || [],
      meetingPoint: bookingAndTickets.meetingPoint || null,
      pickup: {
        pickupType: bookingAndTickets.pickupType || null,
        pickupAreas: Array.isArray(bookingAndTickets.pickupAreas) ? bookingAndTickets.pickupAreas : [],
        pickupLocations: Array.isArray(bookingAndTickets.pickupLocations) ? bookingAndTickets.pickupLocations : [],
        pickupDescription: bookingAndTickets.pickupDescription || '',
        pickupTiming: bookingAndTickets.pickupTiming || null,
        pickupAtSpecificTime: !!bookingAndTickets.pickupAtSpecificTime,
        pickupFinalLocationTiming: bookingAndTickets.pickupFinalLocationTiming || null,
        referenceStartTime: bookingAndTickets.referenceStartTime || '',
        planPickupTimes: !!bookingAndTickets.planPickupTimes,
        pickupStartTime: bookingAndTickets.pickupStartTime || null,
        dropoffProvided: !!bookingAndTickets.dropoffProvided,
        dropoffLocation: bookingAndTickets.dropoffLocation || null,
      },
      cancellationPolicy: bookingAndTickets.cancellationPolicy || null,
      confirmationType: bookingAndTickets.confirmationType || null,
      // Manual-confirmation tours (instantConfirmation === false) hold bookings
      // PENDING (paid) until the supplier accepts them.
      instantConfirmation: bookingAndTickets.instantConfirmation !== false,
      supplierName: t.supplier?.name || null,
      supplierPhoto: t.supplier?.photoURL
        ? t.supplier.photoURL
        : null,
      supplierRating: t.supplier?.supplierProfile?.averageRating
        ? Number(t.supplier.supplierProfile.averageRating)
        : null,
      supplierTotalBookings:
        t.supplier?.supplierProfile?.totalBookings || 0,
    };

    return {
      status: 'success',
      data: {
        tour: {
          id: record.id,
          displayOrder: record.displayOrder,
          isFeatured: record.isFeatured,
          tour: tourData,
          tourSchema: buildTourSchemaUrl(tourData),
        },
      },
    };
  }, 300);

  if (!result) {
    return next(new AppError('Tour not found', 404));
  }

  // View tracking — count each unique external visitor once per 30 minutes.
  // Admins, expedition staff, the tour owner and ACTIVE suppliers are excluded.
  const tourSupId = result.data?.tour?.tour?.supplierId || result.data?.tour?.tour?.id;
  const { counted: viewCounted, geo: viewerGeo } = await shouldCountTourView({
    req,
    tourSupplierId: tourSupId,
    tourId: result.data?.tour?.tour?.id,
    prefix: 'expedition:view',
  });
  if (viewCounted) {
    prisma.tour
      .update({
        where: { slug },
        data: { viewCount: { increment: 1 } },
      })
      .catch(() => {});

    const tourData = result.data?.tour?.tour;
    eventEmitter.emit({
      name: 'expedition.tour_viewed',
      userId: req.user?.id,
      req,
      resource: 'Tour',
      resourceId: tourData?.id,
      properties: {
        slug,
        source: 'expedition',
        category: tourData?.category || null,
        city: tourData?.city || null,
        country: tourData?.country || null,
        price: tourData?.startingPrice ? parseFloat(tourData.startingPrice) : null,
        rating: tourData?.averageRating ? parseFloat(tourData.averageRating) : null,
        tags: tourData?.tags || [],
        viewerCountry: viewerGeo?.country || null,
        viewerCity: viewerGeo?.city || null,
        viewerRegion: viewerGeo?.region || null,
      },
    });
  }

  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).json(result);
});

exports.getSitemap = catchAsync(async (req, res) => {
  const result = await cache.getOrSet(SITEMAP_CACHE_KEY, async () => {
    const records = await prisma.expeditionTour.findMany({
      where: { isActive: true, tour: { status: 'ACTIVE', supplier: { supplierProfile: { status: 'ACTIVE' } } } },
      orderBy: { displayOrder: 'asc' },
      select: {
        tour: { select: { slug: true } },
        updatedAt: true,
      },
    });

    return {
      status: 'success',
      data: {
        urls: records.map((r) => ({
          slug: r.tour.slug,
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
    };
  }, 3600);

  res.status(200).json(result);
});

exports.submitContact = catchAsync(async (req, res, next) => {
  const { name, email, phone, message, tourSlug } = req.body;

  if (!name || !email || !message) {
    return next(new AppError('name, email, and message are required', 400));
  }

  if (typeof name !== 'string' || name.trim().length < 2) {
    return next(new AppError('Name must be at least 2 characters', 400));
  }

  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return next(new AppError('Invalid email address', 400));
  }

  if (typeof message !== 'string' || message.trim().length < 10) {
    return next(new AppError('Message must be at least 10 characters', 400));
  }

  const supportEmail = process.env.SUPPORT_EMAIL || 'support@expeditiongo.com';

  const subject = `[Expedition Inquiry] ${name} - ${email}`;
  const messageBody = [
    `Name: ${name}`,
    `Email: ${email}`,
    phone ? `Phone: ${phone}` : null,
    tourSlug ? `Tour: https://travioafrica.com/tour/${tourSlug}` : null,
    '',
    'Message:',
    message,
  ]
    .filter(Boolean)
    .join('\n');

  await sendEmail({
    to: supportEmail,
    subject,
    template: null,
    data: {
      subject,
      messageBody,
      name,
      email,
      phone: phone || 'Not provided',
      inquiryType: 'Expedition Contact Form',
    },
  });

  enqueueEvent({
    name: 'expedition.contact_submitted',
    userId: req.user?.id,
    req,
    properties: { email, tourSlug: tourSlug || null, source: 'expedition' },
  });

  res.status(200).json({
    status: 'success',
    message: 'Your message has been sent. We will get back to you shortly.',
  });
});

exports.trackClick = catchAsync(async (req, res) => {
  const { tourId, tourSlug } = req.body;

  enqueueEvent({
    name: 'expedition.outbound_click',
    userId: req.user?.id,
    req,
    resource: 'Tour',
    resourceId: tourId || null,
    properties: {
      tourId: tourId || null,
      tourSlug: tourSlug || null,
      destination: 'travioafrica.com',
      source: 'expedition',
    },
  });

  res.status(204).send();
});

// ================================
// ADMIN ENDPOINTS
// ================================

exports.searchTours = catchAsync(async (req, res) => {
  const {
    q,
    category,
    city,
    country,
    page = 1,
    limit = 20,
  } = req.query;

  const where = { status: 'ACTIVE' };

  // Exclude tours already curated
  const curatedIds = await prisma.expeditionTour.findMany({
    select: { tourId: true },
  });
  const excludedIds = curatedIds.map((c) => c.tourId);
  if (excludedIds.length > 0) {
    where.id = { notIn: excludedIds };
  }

  const AND = [];
  if (q && q.trim()) {
    const search = q.trim();
    AND.push({
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { country: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { supplier: { name: { contains: search, mode: 'insensitive' } } },
      ],
    });
  }
  if (category) AND.push({ category });
  if (city) AND.push({ city: { contains: city, mode: 'insensitive' } });
  if (country) AND.push({ country: { contains: country, mode: 'insensitive' } });

  if (AND.length > 0) where.AND = AND;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [tours, totalCount] = await Promise.all([
    prisma.tour.findMany({
      where,
      select: {
        id: true,
        title: true,
        slug: true,
        coverPhoto: true,
        category: true,
        city: true,
        country: true,
        schedulesAndPricing: true,
        status: true,
        createdAt: true,
        supplier: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.tour.count({ where }),
  ]);

  const totalPages = Math.ceil(totalCount / take);

  res.status(200).json({
    status: 'success',
    data: {
      tours: tours.map((t) => ({
        id: t.id,
        title: t.title,
        slug: t.slug,
        coverPhoto: t.coverPhoto || null,
        category: t.category,
        city: t.city,
        country: t.country,
        startingPrice: extractStartingPrice(t.schedulesAndPricing),
        currency: extractCurrency(t.schedulesAndPricing),
        status: t.status,
        supplierName: t.supplier?.name || null,
        createdAt: t.createdAt,
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: take,
      },
    },
  });
});

exports.getAdminTours = catchAsync(async (req, res) => {
  const records = await prisma.expeditionTour.findMany({
    orderBy: { displayOrder: 'asc' },
    include: {
      addedBy: { select: { id: true, name: true, email: true } },
      tour: {
        select: {
          id: true, title: true, slug: true, status: true,
          coverPhoto: true, category: true, city: true, country: true,
          createdAt: true,
          supplier: { select: { name: true } },
        },
      },
    },
  });

  res.status(200).json({
    status: 'success',
    data: {
      tours: records.map((r) => ({
        id: r.id,
        tourId: r.tourId,
        displayOrder: r.displayOrder,
        isFeatured: r.isFeatured,
        isActive: r.isActive,
        addedBy: r.addedBy
          ? { id: r.addedBy.id, name: r.addedBy.name, email: r.addedBy.email }
          : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        tour: {
          id: r.tour.id,
          title: r.tour.title,
          slug: r.tour.slug,
          status: r.tour.status,
          coverPhoto: r.tour.coverPhoto
            ? r.tour.coverPhoto
            : null,
          category: r.tour.category,
          city: r.tour.city,
          country: r.tour.country,
          supplierName: r.tour.supplier?.name || null,
          createdAt: r.tour.createdAt,
        },
      })),
    },
  });
});

exports.addTour = catchAsync(async (req, res, next) => {
  const { tourId, displayOrder, isFeatured } = req.body;

  if (!tourId) {
    return next(new AppError('tourId is required', 400));
  }

  const tour = await prisma.tour.findUnique({
    where: { id: tourId },
    select: { id: true, status: true, title: true },
  });

  if (!tour) {
    return next(new AppError('Tour not found', 404));
  }

  const existing = await prisma.expeditionTour.findUnique({
    where: { tourId },
  });

  if (existing) {
    return next(new AppError('Tour is already in the expedition list', 409));
  }

  const maxOrder = await prisma.expeditionTour.aggregate({
    _max: { displayOrder: true },
  });

  const record = await prisma.expeditionTour.create({
    data: {
      tourId,
      displayOrder: displayOrder ?? (maxOrder._max.displayOrder ?? 0) + 1,
      isFeatured: isFeatured ?? false,
      isActive: true,
      addedById: req.user.id,
    },
  });

  await invalidateCaches();

  res.status(201).json({ status: 'success', data: { tour: record } });
});

exports.updateTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { displayOrder, isFeatured, isActive } = req.body;

  const existing = await prisma.expeditionTour.findUnique({ where: { id } });
  if (!existing) {
    return next(new AppError('Expedition tour not found', 404));
  }

  const record = await prisma.expeditionTour.update({
    where: { id },
    data: {
      ...(displayOrder !== undefined && { displayOrder }),
      ...(isFeatured !== undefined && { isFeatured }),
      ...(isActive !== undefined && { isActive }),
    },
  });

  await invalidateCaches();

  res.status(200).json({ status: 'success', data: { tour: record } });
});

exports.removeTour = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const existing = await prisma.expeditionTour.findUnique({ where: { id } });
  if (!existing) {
    return next(new AppError('Expedition tour not found', 404));
  }

  await prisma.expeditionTour.delete({ where: { id } });

  await invalidateCaches();

  res.status(204).json({ status: 'success', data: null });
});

exports.refreshCache = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  if (tourId && tourId !== 'all') {
    const record = await prisma.expeditionTour.findUnique({
      where: { id: tourId },
      select: { id: true },
    });
    if (!record) {
      return next(new AppError('Expedition tour not found', 404));
    }
  }

  await invalidateCaches();

  res.status(200).json({
    status: 'success',
    message: tourId && tourId !== 'all'
      ? `Cache cleared for expedition tour ${tourId}`
      : 'All expedition caches cleared',
  });
});

// ================================
// NEWSLETTER & AVAILABILITY
// ================================

const { buildAvailabilityCalendar } = require('../utils/availabilityCalendar');

exports.subscribe = catchAsync(async (req, res, next) => {
  const { email, name } = req.body;

  const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } });
  if (existing) {
    if (!existing.subscribed) {
      await prisma.newsletterSubscriber.update({
        where: { email },
        data: { subscribed: true, name: name || existing.name },
      });
    }
    return res.status(200).json({
      status: 'success',
      message: 'You are already subscribed!',
    });
  }

  await prisma.newsletterSubscriber.create({
    data: { email, name: name || null, source: 'EXPEDITION' },
  });

  enqueueEvent({
    name: 'expedition.newsletter_subscribed',
    properties: { email, name: name || null, source: 'expedition' },
  });

  res.status(200).json({
    status: 'success',
    message: 'Thank you for subscribing!',
  });
});

exports.getTourAvailability = catchAsync(async (req, res, next) => {
  const { slug } = req.params;
  const { startDate, endDate } = req.query;

  const expeditionTour = await prisma.expeditionTour.findFirst({
    where: { tour: { slug }, isActive: true },
    select: { tourId: true },
  });

  if (!expeditionTour) return next(new AppError('Tour not found', 404));

  const tour = await prisma.tour.findUnique({
    where: { id: expeditionTour.tourId },
    select: { id: true, title: true, schedulesAndPricing: true },
  });

  if (!tour) return next(new AppError('Tour not found', 404));

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return next(new AppError('Invalid date format', 400));
  }

  if (end < start) return next(new AppError('endDate must be after startDate', 400));

  const maxPublicDays = parseInt(await getConfig('availability.public_max_days', '31'), 10) || 31;
  const daysInRange = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  if (daysInRange > maxPublicDays) {
    return next(new AppError(`Date range cannot exceed ${maxPublicDays} days`, 400));
  }

  const calendar = await cache.getOrSet(
    `availability:cal:${tour.id}:${toDateKey(start)}:${toDateKey(end)}`,
    () => buildAvailabilityCalendar(tour.id, tour.schedulesAndPricing, start, end),
    30
  );

  res.status(200).json({
    status: 'success',
    data: {
      tour: { id: tour.id, title: tour.title },
      startDate: startDate,
      endDate: endDate,
      calendar,
    },
  });
});

// ================================
// CHECKOUT ENDPOINTS
// ================================

exports.calculateCheckout = catchAsync(async (req, res, next) => {
  const { tourId, travelDate, travelers, promoCode } = req.body;

  if (!tourId || !travelDate || !travelers) {
    return next(new AppError('tourId, travelDate, and travelers are required', 400));
  }

  const cacheKey = `${CACHE_PREFIX}checkout:${crypto.createHash('md5').update(JSON.stringify({ tourId, travelDate, travelers, promoCode: promoCode || null })).digest('hex')}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const tour = await prisma.tour.findFirst({
      where: { id: tourId, status: 'ACTIVE', supplier: { supplierProfile: { status: 'ACTIVE' } } },
      include: { supplier: { include: { supplierProfile: true } } },
    });

    if (!tour) {
      throw new AppError('Tour not found or not available for booking', 404);
    }

    const expTourCalc = await prisma.expeditionTour.findUnique({
      where: { tourId },
      select: { isActive: true },
    });
    if (!expTourCalc?.isActive) {
      throw new AppError('Tour is not available on Expedition', 400);
    }

    // Enforce supplier passenger-mix rules (min/max, disallowed categories,
    // requires-adult supervision) before pricing.
    const mixResult = validatePassengerMix(parseBlob(tour.schedulesAndPricing), travelers);
    if (!mixResult.ok) {
      throw new AppError(mixResult.errors[0], 400);
    }

    const availability = await checkTourAvailability(tourId, travelDate, null);
    if (!availability.available) {
      throw new AppError(availability.reason || 'Tour is not available on the selected date', 400);
    }

    const totalTravelers = travelerCount(travelers);
    if (totalTravelers > availability.availableSpots) {
      throw new AppError(`Only ${availability.availableSpots} spots available, but ${totalTravelers} travelers requested`, 400);
    }

    const pricing = await calculateTourPrice(tour, travelers, travelDate, null, null, req.user?.id, promoCode || null)
      .catch(() => ({ success: false, error: 'Unable to calculate pricing' }));

    if (!pricing.success) {
      throw new AppError(pricing.error, 400);
    }

    return {
      status: 'success',
      data: {
        available: true,
        availableSpots: availability.availableSpots,
        pricing: {
          currency: pricing.currency,
          subtotal: pricing.subtotal,
          fees: pricing.fees || 0,
          discounts: pricing.discount || 0,
          total: pricing.total,
        },
        travelerSummary: {
          adults: travelers.adults || 0,
          children: travelers.children || 0,
          infants: travelers.infants || 0,
          total: totalTravelers,
        },
      },
    };
  }, CHECKOUT_CACHE_TTL);

  res.status(200).json(result);
});

exports.confirmBooking = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const {
    tourId,
    travelDate,
    selectedTime,
    travelers,
    specialRequests,
    pickup,
    paymentTiming = 'now',
    leadTraveler,
  } = req.body;

  if (!tourId || !travelDate || !travelers) {
    return next(new AppError('tourId, travelDate, and travelers are required', 400));
  }
  if (paymentTiming !== 'now' && paymentTiming !== 'later') {
    return next(new AppError("paymentTiming must be 'now' or 'later'", 400));
  }

  // Lead traveler is the person going on the trip (entered on the storefront's
  // "Lead Traveler Details" step); it is distinct from the customer account
  // that placed the booking. Stored so the supplier dashboard and emails can
  // surface it instead of the booking owner.
  if (leadTraveler != null && typeof leadTraveler !== 'object') {
    return next(new AppError('leadTraveler must be an object', 400));
  }
  const leadName = typeof leadTraveler?.name === 'string' ? leadTraveler.name.trim() : '';
  const leadEmail = typeof leadTraveler?.email === 'string' ? leadTraveler.email.trim() : '';
  const leadPhone = typeof leadTraveler?.phone === 'string' ? leadTraveler.phone.trim() : '';
  if (leadName && !isValidEmail(leadEmail)) {
    return next(new AppError('A valid leadTraveler.email is required when a lead traveler name is provided', 400));
  }

  const travelerValidation = validateTravelerInfo(travelers, pickup ? { requireLocation: false } : undefined);
  if (!travelerValidation.isValid) {
    return next(new AppError(`Traveler information: ${travelerValidation.errors.join(', ')}`, 400));
  }

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, status: 'ACTIVE' },
    include: { supplier: { include: { supplierProfile: true } } },
  });

  if (!tour) {
    return next(new AppError('Tour not found or not available', 404));
  }

  const expTour = await prisma.expeditionTour.findUnique({
    where: { tourId },
    select: { isActive: true },
  });
  if (!expTour?.isActive) {
    return next(new AppError('Tour is not available on Expedition', 400));
  }

  if (tour.supplier.supplierProfile.status !== 'ACTIVE') {
    return next(new AppError('Supplier is not active', 400));
  }

  // Validate pickup selection against the tour's current pickup config and
  // normalize it into the canonical snapshot (status: deferred/selected).
  let pickupSnapshot = null;
  if (pickup) {
    const pickupConfig = parseBlob(tour.bookingAndTickets) || {};
    const pickupResult = resolvePickupSelection(pickup, pickupConfig);
    if (!pickupResult.ok) {
      return next(new AppError(pickupResult.error, 400));
    }
    pickupSnapshot = normalizePickupSnapshot(pickup, pickupConfig);
  }

  // Enforce supplier passenger-mix rules (min/max, disallowed categories,
  // requires-adult supervision) before any charge.
  const mixResult = validatePassengerMix(parseBlob(tour.schedulesAndPricing), travelers);
  if (!mixResult.ok) {
    return next(new AppError(mixResult.errors[0], 400));
  }

  const pricing = await calculateTourPrice(tour, travelers, travelDate, selectedTime || null, null, customerId, req.body.promoCode || null)
    .catch(() => ({ success: false, error: 'Unable to calculate pricing' }));

  if (!pricing.success) {
    return next(new AppError(pricing.error, 400));
  }
  if (!Number.isFinite(pricing.total) || pricing.total <= 0) {
    return next(new AppError('Booking total must be greater than 0', 400));
  }

  const availability = await checkTourAvailability(tourId, travelDate, { selectedTime, travelers });
  if (!availability.available) {
    return next(new AppError(availability.reason || 'Tour is not available on the selected date', 400));
  }

  // Validate advance booking rules (per-tour cutoff wins; slot-aware when the
  // tour uses per-slot cutoffs).
  const [minAdvanceHours, maxAdvanceDays] = await Promise.all([
    getConfig('booking.min_advance_hours', '24').then((v) => parseInt(v)),
    getConfig('booking.max_advance_days', '365').then((v) => parseInt(v)),
  ]);

  const parsedBt = typeof tour.bookingAndTickets === 'string'
    ? (() => { try { return JSON.parse(tour.bookingAndTickets); } catch { return null; } })()
    : tour.bookingAndTickets;
  const perSlotCutoff = !!parsedBt?.perSlotCutoff;
  // Builder writes cutoffMinutes (minutes); resolveSlotCutoffHours handles
  // per-slot overrides (keyed by slot start time), legacy
  // minAdvanceBookingHours rows and the system default.
  const effectiveCutoff = resolveSlotCutoffHours(parsedBt, selectedTime, minAdvanceHours);
  const tourTz = getTourTimezone(parsedBt);

  const dateAt = new Date(travelDate);
  let startAt;
  if (selectedTime && perSlotCutoff) {
    // Anchor the cutoff clock to the slot's local wall clock in the tour's
    // timezone (default UTC keeps current behavior).
    const localDate = zonedDateKey(toDateKey(dateAt), tourTz);
    startAt = zonedTimeToUtc(`${localDate} ${selectedTime}`, tourTz);
  } else {
    startAt = new Date(Date.UTC(dateAt.getUTCFullYear(), dateAt.getUTCMonth(), dateAt.getUTCDate()));
  }

  const hoursUntilTour = (startAt - new Date()) / (1000 * 60 * 60);
  if (hoursUntilTour < effectiveCutoff) {
    return next(new AppError(`Bookings must be made at least ${cutoffLabel(effectiveCutoff)} before the tour`, 400));
  }
  if (hoursUntilTour / 24 > maxAdvanceDays) {
    return next(new AppError(`Bookings can only be made up to ${maxAdvanceDays} days in advance`, 400));
  }

  const appliedOffer = pricing.appliedOffer || null;
  const totalTravelers = travelerCount(travelers);

  // Dedup: prevent duplicate bookings on retry (slot-scoped when one is chosen)
  const existingBooking = await prisma.booking.findFirst({
    where: {
      customerId,
      tourId,
      travelDate: new Date(travelDate),
      ...(selectedTime ? { selectedTime } : {}),
      status: { in: ['PENDING', 'CONFIRMED'] },
    },
    select: { id: true, status: true, bookingNumber: true },
  });
  if (existingBooking) {
    return next(new AppError(
      `You already have a ${existingBooking.status.toLowerCase()} booking (${existingBooking.bookingNumber}) for this tour on this date`,
      409
    ));
  }

  // Reserve-now-pay-later captures the card (uncharged) so the pay-later sweep
  // can auto-charge it near the activity date. Pay-now uses Stripe's hosted
  // Checkout page instead — no PaymentIntent is created here.
  let paymentIntent = null;
  if (paymentTiming === 'later') {
    if (!req.body.paymentMethodId) {
      return next(new AppError('A payment method is required to reserve now and pay later.', 400));
    }
    try {
      // Attach a Stripe customer if one exists or can be created lazily; `null`
      // means "charge without a customer" (PaymentIntents don't require one).
      // The idempotency key is derived inside createPaymentIntent from the final
      // request body, so a retry whose customer attachment changed (async
      // creation completing in between) can never collide with the earlier
      // customer-less request.
      const stripeCustomerId = await ensureStripeCustomer(req.user);
      const piMetadata = {
        customerId,
        tourId,
        source: 'expedition',
        paymentTiming: 'later',
        // Selected date/time are part of the idempotency-relevant request so
        // rebooking the same tour on a different date creates a fresh PI
        // instead of colliding (via the derived idempotency key) with a
        // previously cancelled one.
        travelDate: typeof travelDate === 'string' ? travelDate.slice(0, 10) : String(travelDate).slice(0, 10),
        ...(selectedTime ? { selectedTime } : {}),
      };
      paymentIntent = await createPaymentIntent({
        amount: Math.round(pricing.total * 100),
        currency: pricing.currency,
        customerId: stripeCustomerId,
        paymentMethodId: req.body.paymentMethodId,
        confirm: false,
        metadata: piMetadata,
      });
      // Stripe idempotency replays return the ORIGINAL creation response (status
      // "requires_confirmation") even when the live PaymentIntent was since
      // charged or cancelled. Check the LIVE status so a stale replay of a
      // previously-settled intent is detected and replaced.
      const liveIntent = await getStripe().paymentIntents.retrieve(paymentIntent.id);
      if (liveIntent.status !== 'requires_confirmation') {
        // Collision with a stale PI from a prior attempt on the same request
        // shape (same customer/tour/date/amount) — e.g. a previously charged or
        // cancelled intent whose idempotency key matched. Recreate with a
        // unique key so the booking is never stuck on a dead PaymentIntent.
        paymentIntent = await createPaymentIntent({
          amount: Math.round(pricing.total * 100),
          currency: pricing.currency,
          customerId: stripeCustomerId,
          paymentMethodId: req.body.paymentMethodId,
          confirm: false,
          metadata: piMetadata,
          idempotencyKey: `paylater:${crypto.randomUUID()}`,
        });
      }
    } catch (err) {
      return next(new AppError(`Payment failed: ${err.message}`, 400));
    }
  }

  // Create booking in transaction (pay-later only — pay-now uses a draft hold
  // that gets materialized into a Booking by the checkout.session.completed
  // webhook or the expire-checkout-holds sweep).
  let result = null;
  if (paymentTiming === 'later') {
    result = await prisma.$transaction(async (tx) => {
    // Lock tour row FOR UPDATE — the serialization point for this tour. Every
    // write path (both checkouts + override writes) takes this lock first.
    const [lockedTour] = await tx.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE`,
      tourId
    );
    if (!lockedTour) throw new Error('Tour not found');

    // Authoritative capacity check within the lock (shared availability core:
    // traveler sum incl. PENDING, TourDateOverride, closed days, per-slot
    // capacity and per-group cap).
    const evalResult = await evaluateBookingAvailability(
      tx,
      tour,
      String(travelDate).slice(0, 10),
      selectedTime || null,
      travelers
    );
    if (!evalResult.ok) {
      throw new Error(evalResult.reason);
    }

    const bookingNumber = await generateBookingNumber('EXP');
    const commission = await calculateCommission(pricing.total, tour.supplier.supplierProfile);

    const booking = await tx.booking.create({
      data: {
        bookingNumber,
        customerId,
        tourId,
        source: 'EXPEDITION',
        travelDate: new Date(travelDate),
        selectedTime: selectedTime || null,
        travelers,
        subtotal: pricing.subtotal,
        grossAmount: pricing.total,
        discounts: pricing.discount || 0,
        currency: pricing.currency,
        commissionRate: commission.rate,
        platformCommission: commission.amount,
        supplierPayout: commission.supplierPayout,
         specialRequests,
         ...(pickupSnapshot && { pickup: pickupSnapshot }),
         ...(paymentIntent && { stripePaymentIntentId: paymentIntent.id }),
         appliedOfferId: appliedOffer?.id || null,
         offerName: appliedOffer?.name || null,
         offerPromoCode: appliedOffer?.promoCode || null,
         offerDiscountType: appliedOffer?.discountType || null,
         offerDiscountPct: appliedOffer?.discountPercentage || null,
         offerDiscountFix: appliedOffer?.fixedDiscountValue || null,
         paymentTiming,
         paymentStatus: 'PENDING',
         // Lead traveler (the person going on the trip), distinct from the
         // customer account that placed the booking.
         leadTravelerName: leadName || null,
         leadTravelerEmail: leadEmail || null,
         leadTravelerPhone: leadPhone || null,
         // Reserve-now-pay-later: the spot is secured immediately but the
        // booking stays PENDING until the deferred charge settles it.
        // Pay-now also starts PENDING until the webhook confirms payment.
        status: 'PENDING',
      },
      include: {
        tour: { select: { id: true, title: true, slug: true, coverPhoto: true } },
        customer: { select: { id: true, name: true, email: true } },
      },
    });

    return booking;
  });
  }

  // Reserve-now-pay-later: the card is validated (PaymentIntent attached) but
  // never charged here — payment is collected before the activity. Skip the
  // confirm step entirely; the booking stays PENDING until the charge lands.
  if (paymentTiming === 'later') {
    // Attach booking ID to PI metadata so a later settlement can find it
    try {
      await getStripe().paymentIntents.update(paymentIntent.id, {
        metadata: { bookingIds: result.id, source: 'expedition', paymentTiming: 'later' },
      });
    } catch (err) {
      console.error('[Expedition] Failed to update PI metadata:', err.message);
    }

    // Clean up any cart items for this tour+date+customer
    prisma.cartItem
      .deleteMany({
        where: { customerId, tourId, selectedDate: new Date(travelDate) },
      })
      .catch(() => {});

    enqueueNotification({
      userId: tour.supplierId,
      type: 'BOOKING_CONFIRMED',
      title: 'New Expedition Booking',
      message: `A new reserve-now-pay-later booking (${result.bookingNumber}) was made through Expedition Go Tours for "${tour.title}"`,
      data: { bookingId: result.id, source: 'expedition' },
    });

    notifyAdmin({
      type: 'BOOKING_CREATED',
      title: 'New Expedition Booking (Reserve now, pay later)',
      message: `Booking #${result.bookingNumber} — $${parseFloat(pricing.total).toFixed(2)} for "${tour.title}" — reserved, payment pending (charges on ${travelDate})`,
      data: { bookingId: result.id, tourTitle: tour.title, total: pricing.total, travelDate, source: 'expedition' },
    }).catch(() => {});

    enqueueEmail({
      type: 'reserve-later-confirmed',
      bookingId: result.id,
      brandName: 'Expedition',
    }).catch((err) => console.error('[Expedition] Reserve-later confirmation email failed:', err.message));

    if (pickupSnapshot) {
      enqueueEmail({ type: 'supplier-pickup-updated', bookingId: result.id })
        .catch((err) => console.error('[Expedition] supplier-pickup-updated email failed:', err.message));
    }

    enqueueEvent({
      name: 'expedition.booking_reserved',
      userId: customerId,
      req,
      resource: 'Booking',
      resourceId: result.id,
      properties: {
        tourId,
        total: pricing.total,
        currency: pricing.currency,
        travelers: totalTravelers,
        paymentTiming: 'later',
      },
    });

    cache.invalidateKeys([`${CACHE_PREFIX}checkout:*`]).catch(() => {});

    return res.status(201).json({
      status: 'success',
      data: {
        booking: result,
        checkout: null,
        message: 'Your spot is reserved. Payment will be collected before the activity.',
      },
    });
  }

  // Pay now: acquire an atomic seat hold, then redirect the customer to
  // Stripe's hosted Checkout page. NO Booking row exists until the
  // checkout.session.completed webhook materializes one from the hold.
  // Abandoned sessions are released by the expired-session webhook or
  // the expire-checkout-holds sweep.
  const commission = await calculateCommission(pricing.total, tour.supplier.supplierProfile);
  let holdResult;
  try {
    holdResult = await acquireHold({
      customerId,
      tourId,
      tour,
      travelDate: new Date(travelDate),
      selectedTime,
      travelers,
      payload: {
        travelers,
        selectedTime,
        pickup,
        specialRequests,
        leadTraveler: { name: leadName, email: leadEmail, phone: leadPhone },
        promoCode: req.body.promoCode || null,
      },
      pricing: {
        subtotal: pricing.subtotal,
        total: pricing.total,
        discount: pricing.discount || 0,
        currency: pricing.currency,
      },
      commission,
    });
  } catch (err) {
    console.error('[Expedition] Failed to acquire hold:', err.message);
    return next(new AppError(err.message || 'Could not reserve your spot. Please try again.', 409));
  }
  if (!holdResult.ok) {
    return next(new AppError(holdResult.reason || 'No longer available', 409));
  }

  let checkout;
  try {
    checkout = await createCheckoutSession({
      amount: Math.round(pricing.total * 100),
      currency: pricing.currency,
      bookingId: holdResult.draftId, // draft id goes into metadata + client_reference_id
      tourTitle: tour.title,
      tourDescription: tour.description || null,
      tourCoverPhoto: tour.coverPhoto || (Array.isArray(tour.photos) ? tour.photos[0] : null),
      customerEmail: req.user?.email,
      expiresAt: holdResult.expiresAt,
      // Stripe replaces {CHECKOUT_SESSION_ID} with the real session id after creation.
      successPath: '/booking/confirmation?session_id={CHECKOUT_SESSION_ID}',
    });
  } catch (err) {
    console.error('[Expedition] Failed to create Checkout Session:', err.message);
    // Release the hold so the customer can retry.
    await releaseHold(holdResult.draftId, 'expired').catch(() => {});
    return next(new AppError('Payment could not be started. Please try again.', 500));
  }

  // Persist the session id on the draft so the sweep can reconcile
  // abandoned sessions (open -> skip, completed -> materialize, expired -> release).
  prisma.checkoutDraft
    .updateMany({
      where: { id: holdResult.draftId, status: 'HOLDING' },
      data: { stripeSessionId: checkout.id },
    })
    .catch((err) => console.error('[Expedition] Failed to store Checkout Session id:', err.message));

  // Invalidate checkout cache so availability is re-checked on next request
  cache.invalidateKeys([`${CACHE_PREFIX}checkout:*`]).catch(() => {});

  res.status(201).json({
    status: 'success',
    data: {
      checkout: { id: checkout.id, url: checkout.url },
      message: 'Redirecting to secure payment…',
    },
  });
});

// ================================
// WISHLIST ENDPOINTS
// ================================

// Fields transformForListing() reads when shaping a wishlist tour.
const EXPEDITION_WISHLIST_TOUR_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  status: true,
  coverPhoto: true,
  photos: true,
  category: true,
  durationMinutes: true,
  schedulesAndPricing: true,
  averageRating: true,
  reviewCount: true,
  viewCount: true,
  city: true,
  country: true,
  supplier: { select: { name: true, photoURL: true } },
};

exports.getExpeditionWishlist = catchAsync(async (req, res, next) => {
  const items = await prisma.wishlistItem.findMany({
    where: {
      userId: req.user.id,
      tour: {
        status: { not: 'DRAFT' },
        expeditionTour: { isActive: true },
      },
    },
    orderBy: { addedAt: 'desc' },
    include: { tour: { select: EXPEDITION_WISHLIST_TOUR_SELECT } },
  });

  const tours = items
    .filter((i) => i.tour)
    .map((i) => ({ ...transformForListing(i.tour), addedAt: i.addedAt }));

  res.status(200).json({
    status: 'success',
    results: tours.length,
    data: { tours },
  });
});

exports.toggleExpeditionWishlist = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  const expeditionTour = await prisma.expeditionTour.findFirst({
    where: { tourId, isActive: true },
    select: { id: true },
  });
  if (!expeditionTour) {
    return next(new AppError('Tour not available on Expedition', 404));
  }

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_tourId: { userId: req.user.id, tourId } },
    select: { id: true },
  });

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });

    await logActivity({
      userId: req.user.id,
      action: 'user.wishlist_removed',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { tourId, source: 'expedition' },
    });

    return res.status(200).json({
      status: 'success',
      data: { isWishlisted: false },
    });
  }

  await prisma.wishlistItem.create({ data: { userId: req.user.id, tourId } });

  await logActivity({
    userId: req.user.id,
    action: 'user.wishlist_added',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { tourId, source: 'expedition' },
  });

  res.status(200).json({
    status: 'success',
    data: { isWishlisted: true },
  });
});

exports.getMyBookings = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const { status, page = 1, limit = 10 } = req.query;

  const where = { customerId, source: 'EXPEDITION', isSimulated: false };
  // Accept a single status or a comma-separated list (e.g. status=CONFIRMED,PENDING)
  // so the navbar counter can include reserve-now-pay-later bookings, which are
  // PENDING until the deferred charge settles.
  if (status) {
    const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    where.status = list.length === 1 ? list[0] : { in: list };
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [bookings, totalCount] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        tour: {
          select: {
            id: true,
            title: true,
            slug: true,
            coverPhoto: true,
            photos: true,
            category: true,
            durationMinutes: true,
            city: true,
            country: true,
            supplier: { select: { id: true, name: true, photoURL: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.booking.count({ where }),
  ]);

  const totalPages = Math.ceil(totalCount / take);

  res.status(200).json({
    status: 'success',
    data: { bookings },
    pagination: {
      currentPage: parseInt(page),
      totalPages,
      totalCount,
      limit: take,
    },
  });
});

exports.getBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const customerId = req.user.id;

  const booking = await prisma.booking.findFirst({
    where: { id, customerId, source: 'EXPEDITION' },
    include: {
      tour: {
        include: {
          supplier: { select: { id: true, name: true, photoURL: true, phone: true, email: true } },
        },
      },
      review: true,
    },
  });

  if (!booking) return next(new AppError('Booking not found', 404));

  res.status(200).json({ status: 'success', data: { booking } });
});

/**
 * GET /expedition/bookings/by-session/:sessionId
 *
 * Returns the checkout status for a pay-now session. The frontend polls this
 * after Stripe redirects back until the webhook materializes a Booking.
 *
 * Response shapes:
 *  - { status: 'HOLDING' }                          — webhook hasn't landed yet
 *  - { status: 'PAID', booking: { … } }             — materialized
 *  - { status: 'EXPIRED' }                          — abandoned / swept
 *  - { status: 'REFUNDED' }                         — capacity lost, money returned
 */
exports.getBookingBySession = catchAsync(async (req, res, next) => {
  const { sessionId } = req.params;
  const customerId = req.user.id;

  if (!sessionId) return next(new AppError('sessionId is required', 400));

  const draft = await prisma.checkoutDraft.findFirst({
    where: { stripeSessionId: sessionId, customerId },
    select: {
      id: true,
      status: true,
      bookingId: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  if (!draft) return next(new AppError('Checkout session not found', 404));

  // If materialized, load the booking for the frontend.
  let booking = null;
  if (draft.status === 'PAID' && draft.bookingId) {
    booking = await prisma.booking.findUnique({
      where: { id: draft.bookingId },
      include: {
        tour: {
          include: {
            supplier: { select: { id: true, name: true, photoURL: true } },
          },
        },
      },
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      status: draft.status,
      expiresAt: draft.expiresAt,
      createdAt: draft.createdAt,
      booking,
    },
  });
});

exports.cancelBooking = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;
  const customerId = req.user.id;

  const booking = await prisma.booking.findFirst({
    where: { id, customerId, source: 'EXPEDITION', status: { in: ['PENDING', 'CONFIRMED'] } },
    include: { tour: { include: { supplier: true } } },
  });

  if (!booking) {
    return next(new AppError('Booking not found or cannot be cancelled', 404));
  }

  const { allowed, refundAmount, reason: policyReason } = evaluateCancellationPolicy(booking, booking.tour);

  if (!allowed) {
    return next(new AppError(policyReason, 400));
  }

  const needsRefund = booking.paymentStatus === 'SUCCEEDED' && refundAmount > 0;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.update({
      where: { id },
      data: { status: 'CANCELLED', cancellationReason: reason || null, cancelledAt: new Date(), payoutStatus: 'CANCELLED' },
    });

    // A cancelled booking must never pay the supplier — close any payout
    // that was queued when the payment succeeded.
    if (needsRefund) {
      await tx.payout.updateMany({
        where: { bookingId: id, status: 'PENDING' },
        data: { status: 'CANCELLED', processedAt: new Date() },
      });
    }

    // Finance v2: detach from any active payout request so the supplier's
    // pending request total no longer includes this booking.
    await detachBookingFromActiveRequests(tx, id);

    // Decrement special offer spotsSold if an offer was applied
    if (booking.appliedOfferId) {
      const travelerCount = (booking.travelers?.adults || 0) + (booking.travelers?.children || 0) + (booking.travelers?.infants || 0);
      await tx.specialOffer.update({
        where: { id: booking.appliedOfferId },
        data: { spotsSold: { decrement: travelerCount } },
      });
    }

    return updated;
  });

  // Attempt Stripe refund OUTSIDE the transaction so a slow/failing Stripe
  // call doesn't hold the DB connection open. Only mark REFUNDED on success.
  let refundSucceeded = false;
  if (needsRefund) {
    try {
      const refundCents = Math.round(refundAmount * 100);
      await createRefund(booking.stripePaymentIntentId, refundCents);
      refundSucceeded = true;
      await prisma.booking.update({
        where: { id },
        data: { paymentStatus: 'REFUNDED', refundAmount, refundedAt: new Date() },
      });
    } catch (refundErr) {
      console.error(`[Expedition] Stripe refund failed for booking ${id}:`, refundErr.message);
      // Booking is already CANCELLED but paymentStatus stays SUCCEEDED so
      // the refund can be retried manually from the admin dashboard.
    }
  }

  enqueueEmail({
    type: 'booking-cancellation',
    bookingId: booking.id,
    refundAmount: refundSucceeded ? refundAmount : 0,
    brandName: 'Expedition',
  }).catch((err) => console.error('[Expedition] Cancellation email failed:', err.message));

  logActivity({
    userId: customerId,
    action: 'booking.cancelled',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason, refundAmount: refundSucceeded ? refundAmount : 0, refundSucceeded, source: 'expedition' },
  }).catch(() => {});

  res.status(200).json({ status: 'success', data: { booking: result } });
});

// ================================
// REVIEWS
// ================================

exports.createReview = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const { bookingId, rating, title, comment } = req.body;

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, customerId, source: 'EXPEDITION' },
    select: { id: true, tourId: true, status: true, paymentStatus: true, review: { select: { id: true } } },
  });

  if (!booking) {
    return next(new AppError('Booking not found or not yours', 404));
  }

  if (booking.status !== 'COMPLETED') {
    return next(new AppError('You can only review completed bookings', 400));
  }

  if (booking.review) {
    return next(new AppError('You have already reviewed this booking', 409));
  }

  const review = await prisma.review.create({
    data: {
      bookingId: booking.id,
      tourId: booking.tourId,
      customerId,
      rating,
      title: title || null,
      comment,
      source: 'EXPEDITION',
      isApproved: false,
    },
    include: {
      tour: { select: { id: true, title: true, slug: true } },
    },
  });

  enqueueEvent({
    name: 'expedition.review_created',
    userId: customerId,
    req,
    resource: 'Review',
    resourceId: review.id,
    properties: { tourId: booking.tourId, rating, source: 'expedition' },
  });

  res.status(201).json({
    status: 'success',
    data: { review },
    message: 'Review submitted and pending approval.',
  });
});

// ================================
// SUPPLIER BOOKING MANAGEMENT
// ================================

exports.getSupplierBookings = catchAsync(async (req, res, next) => {
  const supplierId = req.user.id;
  const { status, page = 1, limit = 10 } = req.query;

  const supplierProfile = await prisma.supplierProfile.findUnique({ where: { userId: supplierId } });
  if (!supplierProfile) return next(new AppError('Supplier profile not found', 404));

  const where = {
    tour: { supplierId },
    source: 'EXPEDITION',
    isSimulated: false,
  };
  if (status) where.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = Math.min(parseInt(limit), 100);

  const [bookings, totalCount] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        tour: {
          select: {
            id: true,
            title: true,
            slug: true,
            coverPhoto: true,
            category: true,
            city: true,
            country: true,
          },
        },
        customer: {
          select: { id: true, name: true, email: true, photoURL: true },
        },
        review: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.booking.count({ where }),
  ]);

  res.status(200).json({
    status: 'success',
    data: { bookings },
    pagination: {
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalCount / take),
      totalCount,
      limit: take,
    },
  });
});

exports.updateBookingStatus = catchAsync(async (req, res, next) => {
  const supplierId = req.user.id;
  const { id } = req.params;
  const { status, reason } = req.body;

  const booking = await prisma.booking.findFirst({
    where: {
      id,
      source: 'EXPEDITION',
      tour: { supplierId },
    },
    include: { tour: { select: { id: true, title: true } } },
  });

  if (!booking) {
    return next(new AppError('Booking not found or not yours', 404));
  }

  if (status === 'COMPLETED' && new Date(booking.travelDate) >= new Date()) {
    return next(new AppError('Cannot mark a future booking as COMPLETED', 400));
  }

  const validTransitions = {
    PROCESSING: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
    PENDING: ['CONFIRMED', 'CANCELLED'],
  };

  const allowed = validTransitions[booking.status];
  if (!allowed || !allowed.includes(status)) {
    return next(new AppError(`Cannot transition from ${booking.status} to ${status}`, 400));
  }

  const updateData = { status };
  if (status === 'CANCELLED') {
    updateData.cancellationReason = reason || null;
    updateData.cancelledAt = new Date();
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: updateData,
    include: {
      tour: { select: { id: true, title: true } },
      customer: { select: { id: true, name: true, email: true } },
    },
  });

  enqueueNotification({
    userId: booking.customerId,
    type: 'BOOKING_STATUS_UPDATED',
    title: 'Booking Status Updated',
    message: `Your booking "${booking.tour.title}" is now ${status}.`,
    data: { bookingId: id, status, source: 'expedition' },
  });

  enqueueEvent({
    name: 'expedition.booking_status_updated',
    userId: supplierId,
    req,
    resource: 'Booking',
    resourceId: id,
    properties: { from: booking.status, to: status, source: 'expedition' },
  });

  res.status(200).json({
    status: 'success',
    data: { booking: updated },
  });
});

/**
 * PATCH /expedition/bookings/:id/pickup
 *
 * Customer self-service pickup management (the "Choose pickup location later"
 * completion flow). Lets the customer pick/set or defer their pickup on their
 * own booking — the same selection rules as checkout apply (resolvePickupSelection
 * re-validates against the tour's current zones/locations).
 *
 * Guards: own booking, EXPEDITION source, PENDING/CONFIRMED, future travel
 * date, and not inside the tour's advance-booking cutoff window (mirrors the
 * checkout rule so a pickup can't be changed at the last minute).
 *
 * Body: { pickup: { skipValidation: true } | { mode, areaName?, address? } }
 */
exports.updateMyPickup = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const { id } = req.params;
  const { pickup } = req.body;

  const booking = await prisma.booking.findFirst({
    where: { id, customerId, source: 'EXPEDITION' },
    include: {
      tour: { select: { id: true, title: true, bookingAndTickets: true, supplierId: true } },
    },
  });

  if (!booking) return next(new AppError('Booking not found', 404));
  if (!['PENDING', 'CONFIRMED'].includes(booking.status)) {
    return next(new AppError('Pickup can no longer be updated for this booking', 400));
  }

  const dateAt = new Date(booking.travelDate);
  if (Number.isNaN(dateAt.getTime()) || dateAt.getTime() <= Date.now()) {
    return next(new AppError('Pickup can only be updated before the activity date', 400));
  }

  // Cutoff lock — mirror the checkout rule (per-tour advance cutoff wins;
  // slot-aware when the tour uses per-slot cutoffs).
  const parsedBt = parseBlob(booking.tour.bookingAndTickets) || {};
  const perSlotCutoff = !!parsedBt.perSlotCutoff;
  const minAdvanceHours = parseInt(await getConfig('booking.min_advance_hours', '24'), 10);
  const effectiveCutoff = resolveSlotCutoffHours(parsedBt, booking.selectedTime || null, minAdvanceHours);
  const tourTz = getTourTimezone(parsedBt);

  let startAt;
  if (booking.selectedTime && perSlotCutoff) {
    const localDate = zonedDateKey(toDateKey(dateAt), tourTz);
    startAt = zonedTimeToUtc(`${localDate} ${booking.selectedTime}`, tourTz);
  } else {
    startAt = new Date(Date.UTC(dateAt.getUTCFullYear(), dateAt.getUTCMonth(), dateAt.getUTCDate()));
  }
  const hoursUntilTour = (startAt - new Date()) / (1000 * 60 * 60);
  if (hoursUntilTour < effectiveCutoff) {
    return next(new AppError(`Pickup can be updated until ${cutoffLabel(effectiveCutoff)} before the activity`, 400));
  }

  const pickupConfig = parsedBt;
  const snapshot = normalizePickupSnapshot(pickup, pickupConfig);
  if (!snapshot) return next(new AppError('Invalid pickup selection', 400));

  await prisma.booking.update({
    where: { id },
    data: { pickup: snapshot },
  });

  // Notify the supplier (in-app + email) so they can plan the pickup.
  enqueueNotification({
    userId: booking.tour.supplierId,
    type: 'PICKUP_UPDATED',
    title: 'Customer updated pickup details',
    message: `Customer updated pickup for booking "${booking.tour.title}"`,
    data: { bookingId: booking.id, pickup: true, source: 'expedition' },
  }).catch((err) => console.error('[Expedition] enqueueNotification (customer pickup update) failed:', err.message));

  enqueueEmail({ type: 'supplier-pickup-updated', bookingId: booking.id })
    .catch((err) => console.error('[Expedition] supplier-pickup-updated email failed:', err.message));

  logActivity({
    userId: customerId,
    action: 'booking.pickup_updated',
    resource: 'Booking',
    resourceId: id,
    metadata: { by: 'customer', source: 'expedition' },
  }).catch((err) => console.warn('[Expedition] logActivity (customer pickup update) failed:', err?.message));

  res.status(200).json({ status: 'success', data: { pickup: snapshot } });
});
