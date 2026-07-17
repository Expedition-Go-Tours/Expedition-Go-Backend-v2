const crypto = require('crypto');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { cloudinaryUrl } = require('../utils/imageOptimizer');
const cache = require('../utils/cacheHelper');
const { sendEmail } = require('../utils/emailService');
const { enqueueEvent, enqueueEmail, enqueueNotification } = require('../utils/queue');
const { validateTravelerInfo, generateBookingNumber } = require('../utils/bookingHelpers');
const { checkTourAvailability, calculateTourPrice } = require('../utils/tourHelpers');
const { createPaymentIntent, calculateCommission, createRefund } = require('../utils/stripeHelpers');
const { notifyAdmin } = require('../utils/adminNotificationService');
const getConfig = require('../utils/getConfig');
const { logActivity } = require('../utils/auditLogger');

const CACHE_PREFIX = 'expedition:';
const LIST_CACHE_KEY = `${CACHE_PREFIX}tours:list`;
const FEATURED_CACHE_KEY = `${CACHE_PREFIX}tours:featured`;
const DETAIL_CACHE_KEY = (slug) => `${CACHE_PREFIX}detail:${slug}`;
const SITEMAP_CACHE_KEY = `${CACHE_PREFIX}sitemap`;
const CHECKOUT_CACHE_TTL = 60;

// In-memory view dedup cache (same pattern as tourController)
const VIEW_CACHE_MAX = 10000;
const viewTrackingCache = new Map();

function extractStartingPrice(schedulesAndPricing) {
  if (!schedulesAndPricing) return null;
  try {
    const sp = typeof schedulesAndPricing === 'string'
      ? JSON.parse(schedulesAndPricing)
      : schedulesAndPricing;
    const schedules = sp?.pricingSchedules?.schedules;
    if (!Array.isArray(schedules) || schedules.length === 0) return null;
    let lowest = Infinity;
    for (const s of schedules) {
      const prices = s?.prices;
      if (!Array.isArray(prices)) continue;
      for (const p of prices) {
        if (p?.ageGroup?.toLowerCase() === 'adult' && p?.retailPrice != null) {
          lowest = Math.min(lowest, Number(p.retailPrice));
        }
      }
    }
    return lowest === Infinity ? null : lowest;
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

function transformForListing(tour) {
  return {
    id: tour.id,
    title: tour.title,
    slug: tour.slug,
    description: tour.description ? tour.description.slice(0, 300) : null,
    coverPhoto: tour.coverPhoto ? cloudinaryUrl(tour.coverPhoto, 800) : null,
    photos: Array.isArray(tour.photos)
      ? tour.photos.map((url) => cloudinaryUrl(url, 400))
      : [],
    category: tour.category,
    durationMinutes: tour.durationMinutes,
    startingPrice: extractStartingPrice(tour.schedulesAndPricing),
    currency: extractCurrency(tour.schedulesAndPricing),
    averageRating: tour.averageRating ? Number(tour.averageRating) : null,
    reviewCount: tour.reviewCount,
    city: tour.city,
    country: tour.country,
    supplierName: tour.supplier?.name || null,
    supplierPhoto: tour.supplier?.photoURL
      ? cloudinaryUrl(tour.supplier.photoURL, 100)
      : null,
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

function getViewerFingerprint(req) {
  if (req.user?.id) return req.user.id;
  const realIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown';
  const ua = req.headers['user-agent'] || '';
  return crypto.createHash('sha256').update(`${realIp}:${ua}`).digest('hex').slice(0, 16);
}

function shouldCountView(req, tourSupplierId) {
  if (req.user?.id && req.user.id === tourSupplierId) return false;
  if (req.user?.roles?.includes('admin')) return false;

  const viewerId = getViewerFingerprint(req);
  const viewKey = `expedition:view:${tourSupplierId}:${viewerId}`;
  const now = Date.now();
  const lastTime = viewTrackingCache.get(viewKey);

  if (lastTime && now - lastTime < 30 * 60 * 1000) return false;

  // Enforce hard cap to prevent unbounded growth
  if (viewTrackingCache.size >= VIEW_CACHE_MAX) {
    const cutoff = now - 30 * 60 * 1000;
    for (const [k, t] of viewTrackingCache.entries()) {
      if (t < cutoff) viewTrackingCache.delete(k);
    }
    // If still over cap after cleanup, clear oldest entries
    if (viewTrackingCache.size >= VIEW_CACHE_MAX) {
      const iter = viewTrackingCache.keys();
      for (let i = 0; i < 1000; i++) {
        const key = iter.next().value;
        if (key) viewTrackingCache.delete(key);
        else break;
      }
    }
  }

  viewTrackingCache.set(viewKey, now);
  return true;
}

// ================================
// PUBLIC ENDPOINTS
// ================================

exports.getTours = catchAsync(async (req, res) => {
  const { page = 1, limit = 12, search, category, city, country, sortBy } = req.query;

  const cacheKey = `${LIST_CACHE_KEY}:${crypto.createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const tourWhere = { status: 'ACTIVE' };
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

    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
    const take = Math.min(parseInt(limit), 50);

    const [records, totalCount] = await Promise.all([
      prisma.expeditionTour.findMany({
        where: { isActive: true, tour: tourWhere },
        orderBy,
        skip,
        take,
        include: {
          tour: {
            select: {
              id: true, title: true, slug: true, description: true,
              coverPhoto: true, photos: true, category: true,
              durationMinutes: true, averageRating: true, reviewCount: true,
              city: true, country: true, schedulesAndPricing: true,
              supplier: { select: { name: true, photoURL: true } },
            },
          },
        },
      }),
      prisma.expeditionTour.count({ where: { isActive: true, tour: tourWhere } }),
    ]);

    const totalPages = Math.ceil(totalCount / take);

    return {
      status: 'success',
      data: {
        tours: records.map((r) => ({
          id: r.id,
          displayOrder: r.displayOrder,
          isFeatured: r.isFeatured,
          tour: transformForListing(r.tour),
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
      where: { isActive: true, isFeatured: true, tour: { status: 'ACTIVE' } },
      orderBy: { displayOrder: 'asc' },
      take: 8,
      include: {
        tour: {
          select: {
            id: true, title: true, slug: true, description: true,
            coverPhoto: true, photos: true, category: true,
            durationMinutes: true, averageRating: true, reviewCount: true,
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
          tour: transformForListing(r.tour),
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
      where: { isActive: true, tour: { slug, status: 'ACTIVE' } },
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
      coverPhoto: t.coverPhoto ? cloudinaryUrl(t.coverPhoto, 1400) : null,
      photos: Array.isArray(t.photos)
        ? t.photos.map((url) => cloudinaryUrl(url, 800))
        : [],
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
      cancellationPolicy: bookingAndTickets.cancellationPolicy || null,
      confirmationType: bookingAndTickets.confirmationType || null,
      supplierName: t.supplier?.name || null,
      supplierPhoto: t.supplier?.photoURL
        ? cloudinaryUrl(t.supplier.photoURL, 100)
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

  // View tracking
  const tourSupId = result.data?.tour?.tour?.supplierId || result.data?.tour?.tour?.id;
  if (shouldCountView(req, tourSupId)) {
    prisma.tour
      .update({
        where: { slug },
        data: { viewCount: { increment: 1 } },
      })
      .catch(() => {});

    enqueueEvent({
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
      where: { isActive: true, tour: { status: 'ACTIVE' } },
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
        coverPhoto: t.coverPhoto ? cloudinaryUrl(t.coverPhoto, 200) : null,
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
            ? cloudinaryUrl(r.tour.coverPhoto, 200)
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

  const maxRange = 31;
  const daysInRange = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  if (daysInRange > maxRange) {
    return next(new AppError(`Date range cannot exceed ${maxRange} days`, 400));
  }

  const calendar = await buildAvailabilityCalendar(tour.id, tour.schedulesAndPricing, start, end);

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
  const { tourId, selectedDate, travelers } = req.body;

  if (!tourId || !selectedDate || !travelers) {
    return next(new AppError('tourId, selectedDate, and travelers are required', 400));
  }

  const cacheKey = `${CACHE_PREFIX}checkout:${crypto.createHash('md5').update(JSON.stringify({ tourId, selectedDate, travelers })).digest('hex')}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const tour = await prisma.tour.findFirst({
      where: { id: tourId, status: 'ACTIVE', supplier: { supplierProfile: { status: 'ACTIVE' } } },
      include: { supplier: { include: { supplierProfile: true } } },
    });

    if (!tour) {
      throw new AppError('Tour not found or not available for booking', 404);
    }

    const availability = await checkTourAvailability(tourId, selectedDate, null);
    if (!availability.available) {
      throw new AppError(availability.reason || 'Tour is not available on the selected date', 400);
    }

    const totalTravelers = (travelers.adults || 0) + (travelers.children || 0) + (travelers.infants || 0);
    if (totalTravelers > availability.availableSpots) {
      throw new AppError(`Only ${availability.availableSpots} spots available, but ${totalTravelers} travelers requested`, 400);
    }

    const pricing = await calculateTourPrice(tour, travelers, selectedDate, null, null, req.user?.id)
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
  const { tourId, selectedDate, travelers, specialRequests } = req.body;

  if (!tourId || !selectedDate || !travelers) {
    return next(new AppError('tourId, selectedDate, and travelers are required', 400));
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

  if (tour.supplier.supplierProfile.status !== 'ACTIVE') {
    return next(new AppError('Supplier is not active', 400));
  }

  const pricing = await calculateTourPrice(tour, travelers, selectedDate, null, null, customerId)
    .catch(() => ({ success: false, error: 'Unable to calculate pricing' }));

  if (!pricing.success) {
    return next(new AppError(pricing.error, 400));
  }

  const availability = await checkTourAvailability(tourId, selectedDate, null);
  if (!availability.available) {
    return next(new AppError(availability.reason || 'Tour is not available on the selected date', 400));
  }

  const totalTravelers = (travelers.adults || 0) + (travelers.children || 0) + (travelers.infants || 0);
  if (totalTravelers > availability.availableSpots) {
    return next(new AppError(`Only ${availability.availableSpots} spots available, but ${totalTravelers} travelers requested`, 400));
  }

  // Validate advance booking rules
  const [minAdvanceHours, maxAdvanceDays] = await Promise.all([
    getConfig('booking.min_advance_hours', '24').then((v) => parseInt(v)),
    getConfig('booking.max_advance_days', '365').then((v) => parseInt(v)),
  ]);

  const hoursUntilTour = (new Date(selectedDate) - new Date()) / (1000 * 60 * 60);
  if (hoursUntilTour < minAdvanceHours) {
    return next(new AppError(`Bookings must be made at least ${minAdvanceHours} hours before the tour`, 400));
  }
  if (hoursUntilTour / 24 > maxAdvanceDays) {
    return next(new AppError(`Bookings can only be made up to ${maxAdvanceDays} days in advance`, 400));
  }

  const appliedOffer = pricing.appliedOffer || null;

  // Create Stripe PaymentIntent
  let paymentIntent;
  try {
    paymentIntent = await createPaymentIntent({
      amount: Math.round(pricing.total * 100),
      currency: pricing.currency,
      customerId: req.user.stripeCustomerId,
      paymentMethodId: req.body.paymentMethodId,
      idempotencyKey: `expedition:${customerId}:${tourId}:${selectedDate}:${Date.now()}`,
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
    // Lock tour row
    const [lockedTour] = await tx.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE`,
      tourId
    );
    if (!lockedTour) throw new Error('Tour not found');

    // Re-check capacity within transaction
    const [capacityCheck] = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(
        CASE WHEN status IN ('PENDING', 'PROCESSING', 'CONFIRMED')
        THEN COALESCE((travelers->>'adults')::int, 0)
           + COALESCE((travelers->>'children')::int, 0)
           + COALESCE((travelers->>'infants')::int, 0)
        ELSE 0 END
      ), 0) AS "currentBookings"
      FROM "Booking"
      WHERE "tourId" = $1 AND "selectedDate" = $2::date`,
      tourId,
      selectedDate
    );

    const maxSpots = tour.schedulesAndPricing?.travelerDetails?.maxTravelersPerBooking || 50;
    const availableSpots = maxSpots - parseInt(capacityCheck.currentBookings);
    if (totalTravelers > availableSpots) {
      throw new Error(`Only ${availableSpots} spots left, but ${totalTravelers} requested`);
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
        travelers,
        subtotal: pricing.subtotal,
        total: pricing.total,
        discounts: pricing.discount || 0,
        currency: pricing.currency,
        commissionRate: commission.rate,
        commissionAmount: commission.amount,
        supplierPayout: commission.supplierPayout,
        specialRequests,
        stripePaymentIntentId: paymentIntent.id,
        appliedOfferId: appliedOffer?.id || null,
        paymentStatus: 'PENDING',
        status: 'PROCESSING',
      },
      include: {
        tour: { select: { id: true, title: true, slug: true, coverPhoto: true } },
        customer: { select: { id: true, name: true, email: true } },
      },
    });

    return booking;
  });

  // Attach booking ID to PI metadata so the webhook can find it
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    await stripe.paymentIntents.update(paymentIntent.id, {
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
      message: 'Booking is being processed. You will receive a confirmation email shortly.',
    },
  });
});

// ================================
// WISHLIST ENDPOINTS
// ================================

exports.getExpeditionWishlist = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { wishlist: true },
  });
  if (!user) return next(new AppError('User not found', 404));

  if (user.wishlist.length === 0) {
    return res.status(200).json({ status: 'success', results: 0, data: { tours: [] } });
  }

  const tours = await prisma.tour.findMany({
    where: {
      id: { in: user.wishlist },
      status: { not: 'DRAFT' },
      expeditionTours: { some: { isActive: true } },
    },
    select: {
      id: true, title: true, slug: true, description: true,
      coverPhoto: true, photos: true, category: true,
      durationMinutes: true, averageRating: true, reviewCount: true,
      city: true, country: true, schedulesAndPricing: true,
      supplier: { select: { name: true, photoURL: true } },
    },
  });

  const tourMap = Object.fromEntries(tours.map((t) => [t.id, t]));
  const ordered = user.wishlist.map((id) => tourMap[id]).filter(Boolean);

  res.status(200).json({
    status: 'success',
    results: ordered.length,
    data: { tours: ordered.map((t) => transformForListing(t)) },
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

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return next(new AppError('User not found', 404));

  const isWishlisted = user.wishlist.includes(tourId);
  const nextWishlist = isWishlisted
    ? user.wishlist.filter((id) => id !== tourId)
    : [...user.wishlist, tourId];

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { wishlist: nextWishlist },
  });

  logActivity({
    userId: req.user.id,
    action: isWishlisted ? 'user.wishlist_removed' : 'user.wishlist_added',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { tourId, source: 'expedition' },
  });

  res.status(200).json({
    status: 'success',
    data: {
      wishlist: updatedUser.wishlist,
      isWishlisted: !isWishlisted,
    },
  });
});

exports.getMyBookings = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const { status, page = 1, limit = 10 } = req.query;

  const where = { customerId, source: 'EXPEDITION' };
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

  const now = new Date();
  const bookingDate = new Date(booking.selectedDate);
  const hoursUntilBooking = (bookingDate - now) / (1000 * 60 * 60);
  const policy = booking.tour.bookingAndTickets?.cancellationPolicy;
  const windowHours = policy?.cancellationWindowHours || 24;

  if (hoursUntilBooking < windowHours) {
    return next(new AppError(`Cancellation not allowed within ${windowHours} hours of tour`, 400));
  }

  const refundAmount = parseFloat(booking.total);

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
