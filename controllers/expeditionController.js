const crypto = require('crypto');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const cache = require('../utils/cacheHelper');
const { sendEmail } = require('../utils/emailService');
const { enqueueEvent, enqueueEmail, enqueueNotification } = require('../utils/queue');
const { validateTravelerInfo, generateBookingNumber, evaluateCancellationPolicy } = require('../utils/bookingHelpers');
const { checkTourAvailability, calculateTourPrice } = require('../utils/tourHelpers');
const { evaluateBookingAvailability, resolveSlotCutoffHours, cutoffLabel, getTourTimezone, zonedDateKey, zonedTimeToUtc, toDateKey, travelerCount, parseBlob } = require('../utils/availabilityCore');
const { resolvePickupSelection } = require('../utils/geoUtils');
const { validatePassengerMix } = require('../utils/passengerMix');
const { createPaymentIntent, calculateCommission, createRefund, getStripe, ensureStripeCustomer } = require('../utils/stripeHelpers');
const { notifyAdmin } = require('../utils/adminNotificationService');
const getConfig = require('../utils/getConfig');
const { logActivity } = require('../utils/auditLogger');
const { shouldCountTourView } = require('../utils/viewTracking');
const eventEmitter = require('../utils/eventEmitter');

const CACHE_PREFIX = 'expedition:';
const LIST_CACHE_KEY = `${CACHE_PREFIX}tours:list`;
const FEATURED_CACHE_KEY = `${CACHE_PREFIX}tours:featured`;
const DETAIL_CACHE_KEY = (slug) => `${CACHE_PREFIX}detail:${slug}`;
const SITEMAP_CACHE_KEY = `${CACHE_PREFIX}sitemap`;
const CHECKOUT_CACHE_TTL = 60;

function extractStartingPrice(schedulesAndPricing) {
  if (!schedulesAndPricing) return null;
  try {
    const sp = typeof schedulesAndPricing === 'string'
      ? JSON.parse(schedulesAndPricing)
      : schedulesAndPricing;

    const schedules = sp?.pricingSchedules?.schedules;
    if (Array.isArray(schedules) && schedules.length > 0) {
      let lowest = Infinity;
      for (const s of schedules) {
        const prices = s?.prices;
        if (!Array.isArray(prices)) continue;
        for (const p of prices) {
          if (p.retailPrice != null) {
            lowest = Math.min(lowest, Number(p.retailPrice));
          }
        }
      }
      if (lowest !== Infinity) return lowest;
    }

    const td = sp?.travelerDetails;
    if (td?.pricingModel === 'perGroup' && Array.isArray(td?.groupSizes)) {
      let lowest = Infinity;
      for (const gs of td.groupSizes) {
        if (gs.price != null) lowest = Math.min(lowest, Number(gs.price));
      }
      if (lowest !== Infinity) return lowest;
    }

    if (td?.uniformPrice != null) return Number(td.uniformPrice);

    return null;
  } catch {
    return null;
  }
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
      url: `https://travioafrica.com/tours/${tour.slug}`,
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
  const { page = 1, limit = 12, search, category, city, country, minPrice, maxPrice, sortBy } = req.query;

  const cacheKey = `${LIST_CACHE_KEY}:${crypto.createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const tourWhere = {
      status: 'ACTIVE',
      supplier: { supplierProfile: { status: 'ACTIVE' } },
    };
    if (category) tourWhere.category = category;
    if (city) tourWhere.city = city;
    if (country) tourWhere.country = country;
    if (search) {
      tourWhere.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { country: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderBy = [{ displayOrder: 'asc' }];
    if (sortBy === 'rating') orderBy.unshift({ tour: { averageRating: { sort: 'desc', nulls: 'last' } } });
    else if (sortBy === 'newest') orderBy.unshift({ createdAt: 'desc' });
    else if (sortBy === 'popular') orderBy.unshift({ tour: { reviewCount: { sort: 'desc', nulls: 'last' } } });
    else if (sortBy === 'views') orderBy.unshift({ tour: { viewCount: { sort: 'desc', nulls: 'last' } } });
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
      include: { tour: { select: { id: true, category: true } } },
    });

    if (!expeditionTour) return null;

    const tours = await prisma.expeditionTour.findMany({
      where: {
        isActive: true,
        tour: {
          status: 'ACTIVE',
          supplier: { supplierProfile: { status: 'ACTIVE' } },
          id: { not: expeditionTour.tourId },
          category: expeditionTour.tour.category,
        },
      },
      orderBy: { displayOrder: 'asc' },
      take: 4,
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, coverPhoto: true,
            category: true, durationMinutes: true, averageRating: true,
            reviewCount: true, city: true, country: true,
            schedulesAndPricing: true,
            supplier: { select: { name: true, photoURL: true } },
          },
        },
      },
    });

    return {
      status: 'success',
      data: {
        tours: tours.map((r) => ({
          id: r.id,
          tour: transformForListing(r.tour),
        })),
      },
    };
  }, 600); // Cache for 10 minutes — similar tours rarely change

  if (!result) return next(new AppError('Tour not found', 404));
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
  if (await shouldCountTourView({
    req,
    res,
    tourSupplierId: tourSupId,
    tourId: result.data?.tour?.tour?.id,
    prefix: 'expedition:view',
  })) {
    prisma.tour
      .update({
        where: { slug },
        data: { viewCount: { increment: 1 } },
      })
      .catch(() => {});

    eventEmitter.emit({
      name: 'expedition.tour_viewed',
      userId: req.user?.id,
      req,
      resource: 'Tour',
      resourceId: result.data.tour.tour.id,
      properties: { slug, source: 'expedition' },
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
    tourSlug ? `Tour: https://travioafrica.com/tours/${tourSlug}` : null,
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
  const { tourId, selectedDate, travelers, promoCode } = req.body;

  if (!tourId || !selectedDate || !travelers) {
    return next(new AppError('tourId, selectedDate, and travelers are required', 400));
  }

  const cacheKey = `${CACHE_PREFIX}checkout:${crypto.createHash('md5').update(JSON.stringify({ tourId, selectedDate, travelers, promoCode: promoCode || null })).digest('hex')}`;

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

    const availability = await checkTourAvailability(tourId, selectedDate, null);
    if (!availability.available) {
      throw new AppError(availability.reason || 'Tour is not available on the selected date', 400);
    }

    const totalTravelers = travelerCount(travelers);
    if (totalTravelers > availability.availableSpots) {
      throw new AppError(`Only ${availability.availableSpots} spots available, but ${totalTravelers} travelers requested`, 400);
    }

    const pricing = await calculateTourPrice(tour, travelers, selectedDate, null, null, req.user?.id, promoCode || null)
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
    selectedDate,
    selectedTime,
    travelers,
    specialRequests,
    pickup,
    paymentTiming = 'now',
  } = req.body;

  if (!tourId || !selectedDate || !travelers) {
    return next(new AppError('tourId, selectedDate, and travelers are required', 400));
  }
  if (paymentTiming !== 'now' && paymentTiming !== 'later') {
    return next(new AppError("paymentTiming must be 'now' or 'later'", 400));
  }

  const travelerValidation = validateTravelerInfo(travelers);
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

  // Validate pickup selection against the tour's current pickup config.
  let pickupSnapshot = null;
  if (pickup) {
    const pickupConfig = parseBlob(tour.bookingAndTickets) || {};
    const pickupResult = resolvePickupSelection(pickup, pickupConfig);
    if (!pickupResult.ok) {
      return next(new AppError(pickupResult.error, 400));
    }
    pickupSnapshot = pickupResult.pickup;
  }

  // Enforce supplier passenger-mix rules (min/max, disallowed categories,
  // requires-adult supervision) before any charge.
  const mixResult = validatePassengerMix(parseBlob(tour.schedulesAndPricing), travelers);
  if (!mixResult.ok) {
    return next(new AppError(mixResult.errors[0], 400));
  }

  const pricing = await calculateTourPrice(tour, travelers, selectedDate, selectedTime || null, null, customerId, req.body.promoCode || null)
    .catch(() => ({ success: false, error: 'Unable to calculate pricing' }));

  if (!pricing.success) {
    return next(new AppError(pricing.error, 400));
  }
  if (!Number.isFinite(pricing.total) || pricing.total <= 0) {
    return next(new AppError('Booking total must be greater than 0', 400));
  }

  const availability = await checkTourAvailability(tourId, selectedDate, { selectedTime, travelers });
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

  const dateAt = new Date(selectedDate);
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
      selectedDate: new Date(selectedDate),
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

  // Create Stripe PaymentIntent (no charge yet — confirm: false)
  let paymentIntent;
  try {
    // Attach a Stripe customer if one exists or can be created lazily; `null`
    // means "charge without a customer" (PaymentIntents don't require one).
    // The idempotency key is derived inside createPaymentIntent from the final
    // request body, so a retry whose customer attachment changed (async
    // creation completing in between) can never collide with the earlier
    // customer-less request.
    const stripeCustomerId = await ensureStripeCustomer(req.user);
    paymentIntent = await createPaymentIntent({
      amount: Math.round(pricing.total * 100),
      currency: pricing.currency,
      customerId: stripeCustomerId,
      paymentMethodId: req.body.paymentMethodId,
      confirm: false,
      metadata: {
        customerId,
        tourId,
        source: 'expedition',
      },
    });
  } catch (err) {
    return next(new AppError(`Payment failed: ${err.message}`, 400));
  }

  // Create booking in transaction
  const result = await prisma.$transaction(async (tx) => {
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
      String(selectedDate).slice(0, 10),
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
        selectedDate: new Date(selectedDate),
        selectedTime: selectedTime || null,
        travelers,
        subtotal: pricing.subtotal,
        total: pricing.total,
        discounts: pricing.discount || 0,
        currency: pricing.currency,
        commissionRate: commission.rate,
        commissionAmount: commission.amount,
        supplierPayout: commission.supplierPayout,
        specialRequests,
        ...(pickupSnapshot && { pickup: pickupSnapshot }),
        stripePaymentIntentId: paymentIntent.id,
        appliedOfferId: appliedOffer?.id || null,
        paymentTiming,
        paymentStatus: 'PENDING',
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
        where: { customerId, tourId, selectedDate: new Date(selectedDate) },
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
      message: `Booking #${result.bookingNumber} — $${parseFloat(pricing.total).toFixed(2)} for "${tour.title}" — reserved, payment pending`,
      data: { bookingId: result.id, tourTitle: tour.title, total: pricing.total, source: 'expedition' },
    }).catch(() => {});

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
        paymentIntent: {
          id: paymentIntent.id,
          clientSecret: paymentIntent.client_secret,
          status: paymentIntent.status,
          requiresAction: false,
        },
        message: 'Your spot is reserved. Payment will be collected before the activity.',
      },
    });
  }

  // Charge the card now that the booking is safely created.
  let intentStatus = 'pending';
  try {
    const confirmResult = await getStripe().paymentIntents.confirm(paymentIntent.id);
    paymentIntent = confirmResult;
    intentStatus = confirmResult.status;
  } catch (confirmErr) {
    // confirm() throws for declined cards and 3DS challenges. Retrieve the
    // authoritative state instead of trusting the error alone.
    console.log(`[Expedition] confirm threw: ${confirmErr.message}`);
    try {
      paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntent.id);
      intentStatus = paymentIntent.status;
    } catch (retrieveErr) {
      console.error('[Expedition] Failed to retrieve PI after confirm error:', retrieveErr.message);
    }
    console.log(`[Expedition] PaymentIntent ${paymentIntent.id} confirm returned status: ${intentStatus}`);
  }

  // Decline / unattachable payment method: release the booking immediately so
  // the customer can retry (the dedup guard only blocks PENDING/CONFIRMED).
  if (intentStatus === 'requires_payment_method' || intentStatus === 'canceled') {
    const cancelled = await prisma.booking.updateMany({
      where: {
        id: result.id,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        stripePaymentIntentId: paymentIntent.id,
      },
      data: {
        status: 'CANCELLED',
        paymentStatus: 'FAILED',
        cancellationReason: 'Payment declined',
        cancelledAt: new Date(),
      },
    });
    if (cancelled.count > 0) {
      console.log(`[Expedition] Booking ${result.id} released after payment decline`);
    }
    return next(new AppError('Payment was declined. Please try another card.', 400));
  }

  // Attach booking ID to PI metadata so the webhook can find it
  try {
    await getStripe().paymentIntents.update(paymentIntent.id, {
      metadata: { bookingIds: result.id, source: 'expedition' },
    });
  } catch (err) {
    console.error('[Expedition] Failed to update PI metadata:', err.message);
  }

  // Clean up any cart items for this tour+date+customer
  prisma.cartItem
    .deleteMany({
      where: { customerId, tourId, selectedDate: new Date(selectedDate) },
    })
    .catch(() => {});

  // Notify supplier immediately
  enqueueNotification({
    userId: tour.supplierId,
    type: 'BOOKING_CONFIRMED',
    title: 'New Expedition Booking',
    message: `A new booking (${result.bookingNumber}) was made through Expedition Go Tours for "${tour.title}"`,
    data: { bookingId: result.id, source: 'expedition' },
  });

  // Notify expedition admins
  notifyAdmin({
    type: 'BOOKING_CREATED',
    title: 'New Expedition Booking',
    message: `Booking #${result.bookingNumber} — $${parseFloat(pricing.total).toFixed(2)} for "${tour.title}" — payment processing`,
    data: { bookingId: result.id, tourTitle: tour.title, total: pricing.total, source: 'expedition' },
  }).catch(() => {});

  enqueueEvent({
    name: 'expedition.booking_created',
    userId: customerId,
    req,
    resource: 'Booking',
    resourceId: result.id,
    properties: {
      tourId,
      total: pricing.total,
      currency: pricing.currency,
      travelers: totalTravelers,
    },
  });

  // Invalidate checkout cache so availability is re-checked on next request
  cache.invalidateKeys([`${CACHE_PREFIX}checkout:*`]).catch(() => {});

  res.status(201).json({
    status: 'success',
    data: {
      booking: result,
      paymentIntent: {
        id: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        status: intentStatus,
        requiresAction: intentStatus === 'requires_action',
      },
      message: intentStatus === 'requires_action'
        ? 'Additional authentication is required to complete your booking.'
        : 'Booking is being processed. You will receive a confirmation email shortly.',
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

  const where = { customerId, source: 'EXPEDITION' };
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

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.booking.update({
      where: { id },
      data: { status: 'CANCELLED', cancellationReason: reason || null, cancelledAt: new Date() },
    });

    if (booking.paymentStatus === 'SUCCEEDED' && refundAmount > 0) {
      try {
        const refundCents = Math.round(refundAmount * 100);
        await createRefund(booking.stripePaymentIntentId, refundCents);
      } catch (refundErr) {
        console.error(`[Expedition] Stripe refund failed for booking ${id}:`, refundErr.message);
      }

      await tx.booking.update({
        where: { id },
        data: { paymentStatus: 'REFUNDED', refundAmount, refundedAt: new Date() },
      });

      // A refunded booking must never pay the supplier — close any payout
      // that was queued when the payment succeeded.
      await tx.payout.updateMany({
        where: { bookingId: id, status: 'PENDING' },
        data: { status: 'CANCELLED', processedAt: new Date() },
      });
    }

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

  enqueueEmail({
    type: 'booking-cancellation',
    bookingId: booking.id,
    refundAmount,
    brandName: 'Expedition',
  }).catch((err) => console.error('[Expedition] Cancellation email failed:', err.message));

  logActivity({
    userId: customerId,
    action: 'booking.cancelled',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason, refundAmount, source: 'expedition' },
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

  if (status === 'COMPLETED' && new Date(booking.selectedDate) >= new Date()) {
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
