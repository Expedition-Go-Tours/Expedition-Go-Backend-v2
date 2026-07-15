const crypto = require('crypto');
const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { cloudinaryUrl } = require('../utils/imageOptimizer');
const cache = require('../utils/cacheHelper');
const { enqueueEvent } = require('../utils/queue');
const { buildArticleSchema, buildArticleListSchema } = require('../utils/blogSEO');
const { invalidateBlogCaches, LIST_CACHE_KEY, FEATURED_CACHE_KEY, DETAIL_CACHE_KEY, SITEMAP_CACHE_KEY, CATEGORIES_CACHE_KEY, TAGS_CACHE_KEY } = require('../utils/blogCache');

const VIEW_CACHE_MAX = 10000;
const viewTrackingCache = new Map();

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

function shouldCountView(req) {
  if (req.user?.roles?.includes('admin')) return false;
  const viewerId = getViewerFingerprint(req);
  const viewKey = `blog:view:${viewerId}`;
  const now = Date.now();
  const lastTime = viewTrackingCache.get(viewKey);
  if (lastTime && now - lastTime < 30 * 60 * 1000) return false;
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
  viewTrackingCache.set(viewerId, now);
  return true;
}

function transformArticle(article) {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    featuredImage: article.featuredImage ? cloudinaryUrl(article.featuredImage, 800) : null,
    category: article.category ? { id: article.category.id, name: article.category.name, slug: article.category.slug } : null,
    tags: article.tags?.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })) || [],
    author: article.author ? { id: article.author.id, name: article.author.name, photoURL: article.author.photoURL ? cloudinaryUrl(article.author.photoURL, 100) : null } : null,
    status: article.status,
    publishedAt: article.publishedAt,
    readTime: article.readTime,
    locale: article.locale,
    viewCount: article.viewCount,
    createdAt: article.createdAt,
  };
}

function transformArticleDetail(article) {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    body: article.body,
    featuredImage: article.featuredImage ? cloudinaryUrl(article.featuredImage, 1400) : null,
    images: Array.isArray(article.images) ? article.images.map((url) => cloudinaryUrl(url, 800)) : [],
    metaTitle: article.metaTitle,
    metaDescription: article.metaDescription,
    canonicalUrl: article.canonicalUrl,
    category: article.category ? { id: article.category.id, name: article.category.name, slug: article.category.slug } : null,
    tags: article.tags?.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })) || [],
    author: article.author ? { id: article.author.id, name: article.author.name, photoURL: article.author.photoURL ? cloudinaryUrl(article.author.photoURL, 100) : null } : null,
    publishedAt: article.publishedAt,
    readTime: article.readTime,
    locale: article.locale,
    viewCount: article.viewCount,
    relatedTours: article.relatedTours?.map((rt) => ({
      id: rt.tour.id,
      title: rt.tour.title,
      slug: rt.tour.slug,
      coverPhoto: rt.tour.coverPhoto ? cloudinaryUrl(rt.tour.coverPhoto, 400) : null,
      category: rt.tour.category,
      city: rt.tour.city,
      country: rt.tour.country,
      startingPrice: extractStartingPrice(rt.tour.schedulesAndPricing),
      currency: extractCurrency(rt.tour.schedulesAndPricing),
      averageRating: rt.tour.averageRating ? Number(rt.tour.averageRating) : null,
      reviewCount: rt.tour.reviewCount,
    })),
  };
}

function extractStartingPrice(schedulesAndPricing) {
  if (!schedulesAndPricing) return null;
  try {
    const sp = typeof schedulesAndPricing === 'string' ? JSON.parse(schedulesAndPricing) : schedulesAndPricing;
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
    const sp = typeof schedulesAndPricing === 'string' ? JSON.parse(schedulesAndPricing) : schedulesAndPricing;
    return sp?.pricingSchedules?.currency || 'USD';
  } catch {
    return 'USD';
  }
}

const articleInclude = {
  author: { select: { id: true, name: true, photoURL: true } },
  category: { select: { id: true, name: true, slug: true } },
  tags: {
    include: { tag: { select: { id: true, name: true, slug: true } } },
  },
};

const articleDetailInclude = {
  ...articleInclude,
  relatedTours: {
    include: {
      tour: {
        select: {
          id: true, title: true, slug: true, coverPhoto: true,
          category: true, city: true, country: true,
          schedulesAndPricing: true, averageRating: true, reviewCount: true,
        },
      },
    },
  },
};

// ================================
// PUBLIC ENDPOINTS
// ================================

exports.getArticles = catchAsync(async (req, res) => {
  const { page = 1, limit = 12, category, tag, locale, search, sortBy } = req.query;

  const cacheKey = `${LIST_CACHE_KEY}:${crypto.createHash('md5').update(JSON.stringify(req.query)).digest('hex')}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const where = { status: 'PUBLISHED' };
    if (locale) where.locale = locale;
    if (category) where.category = { slug: category };
    if (tag) where.tags = { some: { tag: { slug: tag } } };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { excerpt: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderBy = sortBy === 'oldest' ? { publishedAt: 'asc' }
      : sortBy === 'popular' ? { viewCount: 'desc' }
      : { publishedAt: 'desc' };

    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
    const take = Math.min(parseInt(limit), 50);

    const [articles, totalCount] = await Promise.all([
      prisma.article.findMany({
        where,
        orderBy,
        skip,
        take,
        include: articleInclude,
      }),
      prisma.article.count({ where }),
    ]);

    const totalPages = Math.ceil(totalCount / take);

    return {
      status: 'success',
      data: {
        articles: articles.map(transformArticle),
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

exports.getArticleBySlug = catchAsync(async (req, res, next) => {
  const { slug } = req.params;
  const { locale } = req.query;

  const result = await cache.getOrSet(DETAIL_CACHE_KEY(slug), async () => {
    const where = { slug, status: 'PUBLISHED' };
    if (locale) where.locale = locale;

    const article = await prisma.article.findFirst({
      where,
      include: articleDetailInclude,
    });

    if (!article) return null;

    const alternateLocales = await prisma.article.findMany({
      where: { slug: { startsWith: slug.split('--')[0] || slug }, status: 'PUBLISHED', id: { not: article.id } },
      select: { locale: true, slug: true },
    });

    return {
      status: 'success',
      data: {
        article: {
          ...transformArticleDetail(article),
          jsonLd: buildArticleSchema(article),
          alternateLocales: alternateLocales.map((a) => ({ locale: a.locale, slug: a.slug })),
        },
      },
    };
  }, 300);

  if (!result) return next(new AppError('Article not found', 404));

  if (shouldCountView(req)) {
    prisma.article.update({
      where: { slug },
      data: { viewCount: { increment: 1 } },
    }).catch(() => {});

    enqueueEvent({
      name: 'blog.article_viewed',
      userId: req.user?.id,
      req,
      resource: 'Article',
      resourceId: result.data.article.id,
      properties: { slug },
    });
  }

  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).json(result);
});

exports.getArticlesByCategory = catchAsync(async (req, res, next) => {
  const { slug } = req.params;
  const { page = 1, limit = 12, locale } = req.query;

  const cacheKey = `${LIST_CACHE_KEY}:category:${slug}:${page}:${limit}:${locale || 'all'}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const categoryRecord = await prisma.articleCategory.findUnique({ where: { slug } });
    if (!categoryRecord) return null;

    const where = { status: 'PUBLISHED', categoryId: categoryRecord.id };
    if (locale) where.locale = locale;

    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
    const take = Math.min(parseInt(limit), 50);

    const [articles, totalCount] = await Promise.all([
      prisma.article.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip,
        take,
        include: articleInclude,
      }),
      prisma.article.count({ where }),
    ]);

    const totalPages = Math.ceil(totalCount / take);

    return {
      status: 'success',
      data: { articles: articles.map(transformArticle) },
      pagination: { currentPage: parseInt(page), totalPages, totalCount, limit: take },
    };
  }, 300);

  if (!result) return next(new AppError('Category not found', 404));
  res.status(200).json(result);
});

exports.getArticlesByTag = catchAsync(async (req, res, next) => {
  const { slug } = req.params;
  const { page = 1, limit = 12, locale } = req.query;

  const cacheKey = `${LIST_CACHE_KEY}:tag:${slug}:${page}:${limit}:${locale || 'all'}`;

  const result = await cache.getOrSet(cacheKey, async () => {
    const tagRecord = await prisma.articleTag.findUnique({ where: { slug } });
    if (!tagRecord) return null;

    const where = { status: 'PUBLISHED', tags: { some: { tagId: tagRecord.id } } };
    if (locale) where.locale = locale;

    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
    const take = Math.min(parseInt(limit), 50);

    const [articles, totalCount] = await Promise.all([
      prisma.article.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip,
        take,
        include: articleInclude,
      }),
      prisma.article.count({ where }),
    ]);

    const totalPages = Math.ceil(totalCount / take);

    return {
      status: 'success',
      data: { articles: articles.map(transformArticle) },
      pagination: { currentPage: parseInt(page), totalPages, totalCount, limit: take },
    };
  }, 300);

  if (!result) return next(new AppError('Tag not found', 404));
  res.status(200).json(result);
});

exports.getCategories = catchAsync(async (req, res) => {
  const result = await cache.getOrSet(CATEGORIES_CACHE_KEY, async () => {
    const categories = await prisma.articleCategory.findMany({
      where: { parentId: null },
      include: {
        children: {
          include: {
            _count: { select: { articles: { where: { status: 'PUBLISHED' } } } },
          },
        },
        _count: { select: { articles: { where: { status: 'PUBLISHED' } } } },
      },
      orderBy: { name: 'asc' },
    });

    return {
      status: 'success',
      data: {
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
          description: c.description,
          articleCount: c._count.articles,
          children: c.children.map((child) => ({
            id: child.id,
            name: child.name,
            slug: child.slug,
            articleCount: child._count.articles,
          })),
        })),
      },
    };
  }, 600);

  res.status(200).json(result);
});

exports.getTags = catchAsync(async (req, res) => {
  const result = await cache.getOrSet(TAGS_CACHE_KEY, async () => {
    const tags = await prisma.articleTag.findMany({
      include: {
        _count: { select: { articles: true } },
      },
      orderBy: { name: 'asc' },
    });

    return {
      status: 'success',
      data: {
        tags: tags.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          articleCount: t._count.articles,
        })),
      },
    };
  }, 600);

  res.status(200).json(result);
});

function buildXmlSitemap(articles, baseUrl) {
  const urls = articles.map((a) => {
    const lastmod = a.updatedAt.toISOString();
    return `  <url>
    <loc>${baseUrl}/blog/${a.slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

exports.getSitemap = catchAsync(async (req, res) => {
  const format = req.query.format || 'json';
  const cacheKey = format === 'xml' ? `${SITEMAP_CACHE_KEY}:xml` : SITEMAP_CACHE_KEY;

  const result = await cache.getOrSet(cacheKey, async () => {
    const articles = await prisma.article.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      select: { slug: true, updatedAt: true, locale: true },
    });

    if (format === 'xml') {
      const baseUrl = process.env.FRONTEND_URL || 'https://travioafrica.com';
      return buildXmlSitemap(articles, baseUrl);
    }

    return {
      status: 'success',
      data: {
        urls: articles.map((a) => ({
          slug: a.slug,
          updatedAt: a.updatedAt.toISOString(),
          locale: a.locale,
        })),
      },
    };
  }, 3600);

  if (format === 'xml') {
    res.set('Content-Type', 'application/xml');
    res.status(200).send(result);
  } else {
    res.status(200).json(result);
  }
});

// ================================
// ANALYTICS
// ================================

exports.getBlogAnalytics = catchAsync(async (req, res) => {
  const ANALYTICS_CACHE_KEY = 'blog:analytics';
  const result = await cache.getOrSet(ANALYTICS_CACHE_KEY, async () => {
    const [
      totalArticles,
      publishedCount,
      draftCount,
      archivedCount,
      totalViewsResult,
      totalSharesResult,
      topViewed,
    ] = await Promise.all([
      prisma.article.count(),
      prisma.article.count({ where: { status: 'PUBLISHED' } }),
      prisma.article.count({ where: { status: 'DRAFT' } }),
      prisma.article.count({ where: { status: 'ARCHIVED' } }),
      prisma.article.aggregate({ _sum: { viewCount: true } }),
      prisma.article.aggregate({ _sum: { shareCount: true } }),
      prisma.article.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: { viewCount: 'desc' },
        take: 10,
        select: {
          id: true, title: true, slug: true, viewCount: true,
          publishedAt: true, category: { select: { name: true } },
        },
      }),
    ]);

    const categoryDistribution = await prisma.article.groupBy({
      by: ['categoryId'],
      where: { status: 'PUBLISHED', categoryId: { not: null } },
      _count: { id: true },
    });

    const categoryNames = categoryDistribution.length > 0 ? await prisma.articleCategory.findMany({
      where: { id: { in: categoryDistribution.map((c) => c.categoryId) } },
      select: { id: true, name: true },
    }) : [];
    const categoryMap = Object.fromEntries((categoryNames || []).map((c) => [c.id, c.name]));

    return {
      status: 'success',
      data: {
        totals: {
          totalArticles,
          publishedCount,
          draftCount,
          archivedCount,
          totalViews: totalViewsResult._sum.viewCount || 0,
          totalShares: totalSharesResult._sum.shareCount || 0,
        },
        topViewed: topViewed.map((a) => ({
          id: a.id,
          title: a.title,
          slug: a.slug,
          viewCount: a.viewCount,
          publishedAt: a.publishedAt,
          category: a.category?.name || null,
        })),
        categoryDistribution: categoryDistribution.map((c) => ({
          categoryId: c.categoryId,
          categoryName: categoryMap[c.categoryId] || 'Unknown',
          articleCount: c._count.id,
        })),
      },
    };
  }, 300);

  res.status(200).json(result);
});

// ================================
// ADMIN ENDPOINTS
// ================================

exports.getAdminArticle = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const article = await prisma.article.findUnique({
    where: { id },
    include: articleDetailInclude,
  });
  if (!article) return next(new AppError('Article not found', 404));
  res.status(200).json({
    status: 'success',
    data: { article: transformArticleDetail(article) },
  });
});

exports.getAdminArticles = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, status, locale, category } = req.query;

  const where = {};
  if (status) where.status = status;
  if (locale) where.locale = locale;
  if (category) where.category = { slug: category };

  const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);
  const take = Math.min(parseInt(limit), 100);

  const [articles, totalCount] = await Promise.all([
    prisma.article.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: articleInclude,
    }),
    prisma.article.count({ where }),
  ]);

  const totalPages = Math.ceil(totalCount / take);

  res.status(200).json({
    status: 'success',
    data: { articles: articles.map(transformArticle) },
    pagination: { currentPage: parseInt(page), totalPages, totalCount, limit: take },
  });
});

exports.createArticle = catchAsync(async (req, res, next) => {
  const { title, slug, excerpt, body, featuredImage, images, metaTitle, metaDescription, canonicalUrl, status, readTime, locale, authorId, categoryId, tagIds, relatedTourIds } = req.body;

  const existing = await prisma.article.findUnique({ where: { slug } });
  if (existing) {
    return next(new AppError('An article with this slug already exists', 409));
  }

  const article = await prisma.article.create({
    data: {
      title,
      slug,
      excerpt,
      body,
      featuredImage,
      images: images || undefined,
      metaTitle,
      metaDescription,
      canonicalUrl,
      status: status || 'DRAFT',
      readTime,
      locale: locale || 'en',
      authorId,
      categoryId,
      publishedAt: status === 'PUBLISHED' ? new Date() : undefined,
      tags: tagIds ? {
        create: tagIds.map((tagId) => ({ tagId })),
      } : undefined,
      relatedTours: relatedTourIds ? {
        create: relatedTourIds.map((tourId) => ({ tourId })),
      } : undefined,
    },
    include: articleDetailInclude,
  });

  await invalidateBlogCaches();

  res.status(201).json({
    status: 'success',
    data: { article: transformArticleDetail(article) },
  });
});

exports.updateArticle = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { title, slug, excerpt, body, featuredImage, images, metaTitle, metaDescription, canonicalUrl, status, readTime, locale, categoryId, tagIds, relatedTourIds } = req.body;

  const existing = await prisma.article.findUnique({ where: { id } });
  if (!existing) return next(new AppError('Article not found', 404));

  if (slug && slug !== existing.slug) {
    const slugConflict = await prisma.article.findUnique({ where: { slug } });
    if (slugConflict) return next(new AppError('An article with this slug already exists', 409));
  }

  const article = await prisma.$transaction(async (tx) => {
    if (tagIds !== undefined) {
      await tx.articleTagOnArticle.deleteMany({ where: { articleId: id } });
    }
    if (relatedTourIds !== undefined) {
      await tx.articleTour.deleteMany({ where: { articleId: id } });
    }

    return tx.article.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(slug !== undefined && { slug }),
        ...(excerpt !== undefined && { excerpt }),
        ...(body !== undefined && { body }),
        ...(featuredImage !== undefined && { featuredImage }),
        ...(images !== undefined && { images }),
        ...(metaTitle !== undefined && { metaTitle }),
        ...(metaDescription !== undefined && { metaDescription }),
        ...(canonicalUrl !== undefined && { canonicalUrl }),
        ...(status !== undefined && { status, ...(status === 'PUBLISHED' && !existing.publishedAt ? { publishedAt: new Date() } : {}) }),
        ...(readTime !== undefined && { readTime }),
        ...(locale !== undefined && { locale }),
        ...(categoryId !== undefined && { categoryId }),
        ...(tagIds !== undefined && {
          tags: {
            deleteMany: {},
            create: tagIds.map((tagId) => ({ tagId })),
          },
        }),
        ...(relatedTourIds !== undefined && {
          relatedTours: {
            deleteMany: {},
            create: relatedTourIds.map((tourId) => ({ tourId })),
          },
        }),
      },
      include: articleDetailInclude,
    });
  });

  await invalidateBlogCaches(article.slug);

  res.status(200).json({
    status: 'success',
    data: { article: transformArticleDetail(article) },
  });
});

exports.deleteArticle = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const existing = await prisma.article.findUnique({ where: { id } });
  if (!existing) return next(new AppError('Article not found', 404));

  await prisma.article.update({
    where: { id },
    data: { status: 'ARCHIVED' },
  });

  await invalidateBlogCaches(existing.slug);

  res.status(200).json({
    status: 'success',
    message: 'Article archived',
  });
});

exports.refreshCache = catchAsync(async (req, res, next) => {
  const { articleId } = req.params;

  if (articleId && articleId !== 'all') {
    const article = await prisma.article.findUnique({
      where: { id: articleId },
      select: { slug: true },
    });
    if (!article) return next(new AppError('Article not found', 404));
    await invalidateBlogCaches(article.slug);
  } else {
    await invalidateBlogCaches();
  }

  res.status(200).json({
    status: 'success',
    message: articleId && articleId !== 'all' ? `Cache cleared for article ${articleId}` : 'All blog caches cleared',
  });
});

// ================================
// SANITY WEBHOOK
// ================================

// ================================
// ADMIN CATEGORY ENDPOINTS
// ================================

exports.createCategory = catchAsync(async (req, res, next) => {
  const { name, slug, description, parentId } = req.body;
  const existing = await prisma.articleCategory.findUnique({ where: { slug } });
  if (existing) return next(new AppError('A category with this slug already exists', 409));
  const category = await prisma.articleCategory.create({
    data: { name, slug, description, parentId },
  });
  await cache.invalidateKeys([CATEGORIES_CACHE_KEY]);
  res.status(201).json({ status: 'success', data: { category } });
});

exports.updateCategory = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, slug, description, parentId } = req.body;
  const existing = await prisma.articleCategory.findUnique({ where: { id } });
  if (!existing) return next(new AppError('Category not found', 404));
  if (slug && slug !== existing.slug) {
    const conflict = await prisma.articleCategory.findUnique({ where: { slug } });
    if (conflict) return next(new AppError('A category with this slug already exists', 409));
  }
  const category = await prisma.articleCategory.update({
    where: { id },
    data: { ...(name !== undefined && { name }), ...(slug !== undefined && { slug }), ...(description !== undefined && { description }), ...(parentId !== undefined && { parentId }) },
  });
  await cache.invalidateKeys([CATEGORIES_CACHE_KEY]);
  res.status(200).json({ status: 'success', data: { category } });
});

exports.deleteCategory = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const existing = await prisma.articleCategory.findUnique({ where: { id } });
  if (!existing) return next(new AppError('Category not found', 404));
  await prisma.articleCategory.delete({ where: { id } });
  await cache.invalidateKeys([CATEGORIES_CACHE_KEY]);
  res.status(200).json({ status: 'success', message: 'Category deleted' });
});

// ================================
// ADMIN TAG ENDPOINTS
// ================================

exports.createTag = catchAsync(async (req, res, next) => {
  const { name, slug } = req.body;
  const existing = await prisma.articleTag.findUnique({ where: { slug } });
  if (existing) return next(new AppError('A tag with this slug already exists', 409));
  const tag = await prisma.articleTag.create({ data: { name, slug } });
  await cache.invalidateKeys([TAGS_CACHE_KEY]);
  res.status(201).json({ status: 'success', data: { tag } });
});

exports.updateTag = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name, slug } = req.body;
  const existing = await prisma.articleTag.findUnique({ where: { id } });
  if (!existing) return next(new AppError('Tag not found', 404));
  if (slug && slug !== existing.slug) {
    const conflict = await prisma.articleTag.findUnique({ where: { slug } });
    if (conflict) return next(new AppError('A tag with this slug already exists', 409));
  }
  const tag = await prisma.articleTag.update({
    where: { id },
    data: { ...(name !== undefined && { name }), ...(slug !== undefined && { slug }) },
  });
  await cache.invalidateKeys([TAGS_CACHE_KEY]);
  res.status(200).json({ status: 'success', data: { tag } });
});

exports.deleteTag = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const existing = await prisma.articleTag.findUnique({ where: { id } });
  if (!existing) return next(new AppError('Tag not found', 404));
  await prisma.articleTag.delete({ where: { id } });
  await cache.invalidateKeys([TAGS_CACHE_KEY]);
  res.status(200).json({ status: 'success', message: 'Tag deleted' });
});

exports.uploadImage = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError('No image file provided', 400));
  }
  res.status(200).json({
    status: 'success',
    data: {
      url: req.file.path,
      secureUrl: req.file.path,
      publicId: req.file.filename,
      width: req.file.width,
      height: req.file.height,
      format: req.file.format,
    },
  });
});

exports.handleSanityWebhook = catchAsync(async (req, res, next) => {
  const signature = req.headers['sanity-webhook-signature'];
  const secret = process.env.SANITY_WEBHOOK_SECRET;

  if (secret) {
    if (!signature) return next(new AppError('Missing webhook signature', 401));
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return next(new AppError('Invalid webhook signature', 401));
      }
    } catch {
      return next(new AppError('Invalid webhook signature', 401));
    }
  }

  const { _type, slug: slugObj, action } = req.body;

  if (_type !== 'article') {
    return res.status(200).json({ status: 'success', message: 'Ignored non-article webhook' });
  }

  const slug = slugObj?.current || req.body.slug;
  if (!slug) return res.status(200).json({ status: 'success', message: 'No slug provided' });

  if (action === 'publish') {
    const sanityClient = require('@sanity/client');
    const client = sanityClient({
      projectId: process.env.SANITY_PROJECT_ID,
      dataset: process.env.SANITY_DATASET || 'production',
      apiVersion: '2024-01-01',
      useCdn: true,
    });

    const sanityArticle = await client.fetch(
      `*[_type == "article" && slug.current == $slug][0]{
        title, "slug": slug.current, excerpt, body, featuredImage,
        "categories": categories[]->{_id, name, "slug": slug.current},
        "tags": tags[]->{_id, name, "slug": slug.current},
        "author": author->{name, email},
        locale, "seo": seo
      }`,
      { slug }
    );

    if (!sanityArticle) {
      return res.status(200).json({ status: 'success', message: 'Article not found in Sanity' });
    }

    const author = await prisma.user.findFirst({
      where: { email: sanityArticle.author?.email },
      select: { id: true },
    });

    let category = null;
    if (sanityArticle.categories?.[0]) {
      category = await prisma.articleCategory.upsert({
        where: { slug: sanityArticle.categories[0].slug },
        update: { name: sanityArticle.categories[0].name },
        create: { name: sanityArticle.categories[0].name, slug: sanityArticle.categories[0].slug },
      });
    }

    const tagRecords = [];
    if (sanityArticle.tags) {
      for (const t of sanityArticle.tags) {
        const tag = await prisma.articleTag.upsert({
          where: { slug: t.slug },
          update: { name: t.name },
          create: { name: t.name, slug: t.slug },
        });
        tagRecords.push(tag);
      }
    }

    const article = await prisma.article.upsert({
      where: { slug },
      update: {
        title: sanityArticle.title,
        excerpt: sanityArticle.excerpt || '',
        body: sanityArticle.body || [],
        featuredImage: sanityArticle.featuredImage || null,
        metaTitle: sanityArticle.seo?.metaTitle || null,
        metaDescription: sanityArticle.seo?.metaDescription || null,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        locale: sanityArticle.locale || 'en',
        categoryId: category?.id || (await prisma.articleCategory.findFirst()).id,
        tags: {
          deleteMany: {},
          create: tagRecords.map((t) => ({ tagId: t.id })),
        },
      },
      create: {
        title: sanityArticle.title,
        slug,
        excerpt: sanityArticle.excerpt || '',
        body: sanityArticle.body || [],
        featuredImage: sanityArticle.featuredImage || null,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        locale: sanityArticle.locale || 'en',
        authorId: author?.id || (await prisma.user.findFirst({ where: { roles: { has: 'admin' } }, select: { id: true } })).id,
        categoryId: category?.id || (await prisma.articleCategory.findFirst()).id,
        tags: tagRecords.length > 0 ? {
          create: tagRecords.map((t) => ({ tagId: t.id })),
        } : undefined,
      },
      include: articleDetailInclude,
    });

    await invalidateBlogCaches(slug);

    enqueueEvent({
      name: 'blog.article_published',
      resource: 'Article',
      resourceId: article.id,
      properties: { slug, source: 'sanity' },
    });
  } else if (action === 'unpublish' || action === 'delete') {
    await prisma.article.updateMany({
      where: { slug },
      data: { status: 'ARCHIVED' },
    });
    await invalidateBlogCaches(slug);
  }

  res.status(200).json({ status: 'success' });
});