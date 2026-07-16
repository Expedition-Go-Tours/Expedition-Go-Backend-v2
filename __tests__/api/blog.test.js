const request = require('supertest');

jest.mock('../../config/jwt', () => ({
  verifyAccessToken: jest.fn(),
  signAccessToken: jest.fn(),
  signRefreshToken: jest.fn(),
}));

jest.mock('../../utils/prismaClient', () => ({
  article: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  articleCategory: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  articleTag: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  articleTagOnArticle: { deleteMany: jest.fn() },
  articleTour: { deleteMany: jest.fn() },
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
  tour: { findUnique: jest.fn() },
  $transaction: jest.fn(),
}));

jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  _clearMemory: jest.fn(),
}));
jest.mock('../../utils/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()) }));
jest.mock('@sanity/client', () => jest.fn(() => ({
  fetch: jest.fn().mockResolvedValue(null),
})));
const mockMulterMiddleware = (req, _res, next) => next();
jest.mock('../../middleware/uploadMiddleware', () => {
  const fn = (req, _res, next) => next();
  fn._cloudinaryMissing = false;
  return {
    uploadUserPhoto: fn,
    uploadTourPhotos: fn,
    uploadReviewPhotos: fn,
    uploadSupplierDocuments: fn,
    uploadChatImage: fn,
    uploadSupplierLogo: fn,
    uploadBlogImage: (req, _res, next) => {
      req.file = {
        path: 'https://res.cloudinary.com/test/image/upload/v1/blog/test.jpg',
        filename: 'test-public-id',
        width: 1200,
        height: 800,
        format: 'jpg',
      };
      next();
    },
  };
});

const app = require('../../app');
const prisma = require('../../utils/prismaClient');
const jwt = require('../../config/jwt');
const cache = require('../../utils/cacheHelper');

const mockAuthor = { id: 'author-1', name: 'Admin User', photoURL: '/photos/admin.jpg' };
const mockCategory = { id: 'cat-1', name: 'Destinations', slug: 'destinations' };
const mockTag = { id: 'tag-1', name: 'Africa', slug: 'africa', _count: { articles: 0 } };
const mockCategoryNoParent = { id: 'cat-2', name: 'Travel Tips', slug: 'travel-tips', description: 'Helpful travel advice', parentId: null, _count: { articles: 0 }, children: [] };

const mockArticle = {
  id: 'article-1',
  title: 'Test Article',
  slug: 'test-article',
  excerpt: 'This is a test article excerpt',
  body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] },
  featuredImage: 'https://res.cloudinary.com/test/image/upload/v1/blog/test.jpg',
  images: null,
  metaTitle: 'Test Article SEO Title',
  metaDescription: 'Test article meta description',
  canonicalUrl: null,
  publishedAt: new Date('2026-07-01'),
  status: 'PUBLISHED',
  readTime: 5,
  locale: 'en',
  viewCount: 42,
  shareCount: 3,
  authorId: 'author-1',
  categoryId: 'cat-1',
  author: mockAuthor,
  category: mockCategory,
  tags: [{ tag: mockTag }],
  relatedTours: [],
  createdAt: new Date('2026-07-01'),
  updatedAt: new Date('2026-07-01'),
};

const mockDraftArticle = {
  ...mockArticle,
  id: 'article-2',
  slug: 'draft-article',
  title: 'Draft Article',
  status: 'DRAFT',
  publishedAt: null,
};

const mockArticleDetail = {
  ...mockArticle,
  body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] },
};

beforeEach(() => {
  jest.clearAllMocks();
  cache._clearMemory();

  prisma.article.findMany.mockResolvedValue([mockArticle]);
  prisma.article.findFirst.mockResolvedValue(mockArticle);
  prisma.article.findUnique.mockResolvedValue(mockArticle);
  prisma.article.create.mockResolvedValue(mockArticle);
  prisma.article.update.mockResolvedValue(mockArticle);
  prisma.article.count.mockResolvedValue(1);
  prisma.article.aggregate.mockResolvedValue({ _sum: { viewCount: 42, shareCount: 3 } });
  prisma.article.groupBy.mockResolvedValue([]);

  prisma.articleCategory.findMany.mockResolvedValue([mockCategoryNoParent]);
  prisma.articleCategory.findUnique.mockResolvedValue(mockCategory);
  prisma.articleCategory.findFirst.mockResolvedValue(mockCategory);
  prisma.articleCategory.create.mockResolvedValue(mockCategory);

  prisma.articleTag.findMany.mockResolvedValue([mockTag]);
  prisma.articleTag.findUnique.mockResolvedValue(mockTag);
  prisma.articleTag.findFirst.mockResolvedValue(mockTag);
  prisma.articleTag.create.mockResolvedValue(mockTag);

  prisma.user.findUnique.mockResolvedValue({ id: 'author-1', name: 'Admin User', email: 'admin@test.com', roles: ['admin'], photoURL: null, active: true });
  prisma.user.findFirst.mockResolvedValue({ id: 'author-1', name: 'Admin User', email: 'admin@test.com', roles: ['admin'], photoURL: null, active: true });

  jwt.verifyAccessToken.mockReturnValue({ userId: 'author-1' });

  prisma.$transaction.mockImplementation(async (cb) => {
    if (typeof cb === 'function') return cb(prisma);
    return cb;
  });
});

describe('Blog API — Public Endpoints', () => {
  describe('GET /api/blog/articles', () => {
    it('returns 200 with paginated published articles', async () => {
      const res = await request(app).get('/api/blog/articles');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.articles).toBeDefined();
      expect(Array.isArray(res.body.data.articles)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.currentPage).toBe(1);
    });

    it('respects limit query parameter', async () => {
      const res = await request(app).get('/api/blog/articles?limit=5');
      expect(res.status).toBe(200);
    });

    it('filters by category slug', async () => {
      const res = await request(app).get('/api/blog/articles?category=destinations');
      expect(res.status).toBe(200);
      expect(prisma.article.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            category: { slug: 'destinations' },
          }),
        }),
      );
    });

    it('filters by tag slug', async () => {
      const res = await request(app).get('/api/blog/articles?tag=africa');
      expect(res.status).toBe(200);
    });

    it('filters by locale', async () => {
      const res = await request(app).get('/api/blog/articles?locale=fr');
      expect(res.status).toBe(200);
      expect(prisma.article.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ locale: 'fr' }),
        }),
      );
    });

    it('searches by text', async () => {
      const res = await request(app).get('/api/blog/articles?search=test');
      expect(res.status).toBe(200);
    });

    it('sorts by popularity', async () => {
      const res = await request(app).get('/api/blog/articles?sortBy=popular');
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid sortBy', async () => {
      const res = await request(app).get('/api/blog/articles?sortBy=invalid');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/blog/articles/sitemap', () => {
    it('returns 200 with sitemap entries', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.urls).toBeDefined();
      expect(Array.isArray(res.body.data.urls)).toBe(true);
    });

    it('only includes published articles', async () => {
      prisma.article.findMany.mockResolvedValue([]);
      const res = await request(app).get('/api/blog/articles/sitemap');
      expect(res.status).toBe(200);
      expect(res.body.data.urls).toHaveLength(0);
      expect(prisma.article.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'PUBLISHED' }),
        }),
      );
    });

    it('orders by publishedAt desc', async () => {
      const newer = { slug: 'newer', updatedAt: new Date('2026-07-10'), locale: 'en' };
      const older = { slug: 'older', updatedAt: new Date('2026-06-01'), locale: 'en' };
      prisma.article.findMany.mockResolvedValue([newer, older]);
      const res = await request(app).get('/api/blog/articles/sitemap');
      expect(res.body.data.urls[0].slug).toBe('newer');
      expect(res.body.data.urls[1].slug).toBe('older');
    });

    it('returns each entry with slug, updatedAt, and locale', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap');
      const entry = res.body.data.urls[0];
      expect(entry).toHaveProperty('slug');
      expect(entry).toHaveProperty('updatedAt');
      expect(entry).toHaveProperty('locale');
      expect(typeof entry.updatedAt).toBe('string');
      expect(new Date(entry.updatedAt).toISOString()).toBe(entry.updatedAt);
    });

    it('returns XML sitemap when format=xml', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap?format=xml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/xml');
      expect(res.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    });

    it('XML sitemap contains article URLs', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap?format=xml');
      expect(res.text).toContain('<loc>');
      expect(res.text).toContain('/blog/test-article');
      expect(res.text).toContain('<lastmod>');
      expect(res.text).toContain('<changefreq>weekly</changefreq>');
      expect(res.text).toContain('<priority>0.8</priority>');
    });
  });

  describe('GET /api/blog/articles/:slug', () => {
    it('returns 200 with article detail', async () => {
      const res = await request(app).get('/api/blog/articles/test-article');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.article).toBeDefined();
      expect(res.body.data.article.title).toBe('Test Article');
    });

    it('returns 404 for non-existent article', async () => {
      prisma.article.findFirst.mockResolvedValue(null);
      const res = await request(app).get('/api/blog/articles/non-existent');
      expect(res.status).toBe(404);
    });

    it('includes JSON-LD structured data', async () => {
      const res = await request(app).get('/api/blog/articles/test-article');
      expect(res.status).toBe(200);
      expect(res.body.data.article.jsonLd).toBeDefined();
    });

    it('returns 200 (falls through to list) for missing slug', async () => {
      const res = await request(app).get('/api/blog/articles/');
      expect(res.status).toBe(200);
      expect(res.body.data.articles).toBeDefined();
    });
  });

  describe('GET /api/blog/articles/category/:slug', () => {
    it('returns 200 with articles by category', async () => {
      const res = await request(app).get('/api/blog/articles/category/destinations');
      expect(res.status).toBe(200);
      expect(res.body.data.articles).toBeDefined();
    });

    it('returns 404 for non-existent category', async () => {
      prisma.articleCategory.findUnique.mockResolvedValue(null);
      const res = await request(app).get('/api/blog/articles/category/non-existent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/blog/articles/tag/:slug', () => {
    it('returns 200 with articles by tag', async () => {
      const res = await request(app).get('/api/blog/articles/tag/africa');
      expect(res.status).toBe(200);
      expect(res.body.data.articles).toBeDefined();
    });

    it('returns 404 for non-existent tag', async () => {
      prisma.articleTag.findUnique.mockResolvedValue(null);
      const res = await request(app).get('/api/blog/articles/tag/non-existent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/blog/categories', () => {
    it('returns 200 with category tree', async () => {
      const res = await request(app).get('/api/blog/categories');
      expect(res.status).toBe(200);
      expect(res.body.data.categories).toBeDefined();
      expect(Array.isArray(res.body.data.categories)).toBe(true);
    });
  });

  describe('GET /api/blog/tags', () => {
    it('returns 200 with tags list', async () => {
      const res = await request(app).get('/api/blog/tags');
      expect(res.status).toBe(200);
      expect(res.body.data.tags).toBeDefined();
      expect(Array.isArray(res.body.data.tags)).toBe(true);
    });
  });
});

describe('Blog API — Sanity Webhook', () => {
  describe('POST /api/blog/webhook/sanity', () => {
    it('returns 200 and processes publish action', async () => {
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .send({ _type: 'article', _id: 'test-123', slug: { current: 'test-article' }, action: 'publish' });
      expect(res.status).toBe(200);
    });

    it('ignores non-article webhooks', async () => {
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .send({ _type: 'page', _id: 'page-1', action: 'publish' });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Ignored');
    });

    it('validates required fields', async () => {
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .send({});
      expect(res.status).toBe(400);
    });
  });
});

describe('Blog API — Admin Endpoints (authenticated)', () => {
  beforeEach(() => {
    jwt.verifyAccessToken.mockReturnValue({ userId: 'author-1' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'author-1', name: 'Admin User', email: 'admin@test.com',
      roles: ['admin'], photoURL: null, active: true,
    });
  });

  describe('GET /api/blog/admin/articles', () => {
    it('returns 200 with all articles (including drafts)', async () => {
      const res = await request(app)
        .get('/api/blog/admin/articles')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(res.body.data.articles).toBeDefined();
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get('/api/blog/admin/articles?status=DRAFT')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(prisma.article.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'DRAFT' }),
        }),
      );
    });
  });

  describe('GET /api/blog/admin/articles/:id', () => {
    it('returns 200 with single article by ID', async () => {
      const res = await request(app)
        .get('/api/blog/admin/articles/article-1')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(res.body.data.article).toBeDefined();
    });

    it('returns 404 for non-existent ID', async () => {
      prisma.article.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get('/api/blog/admin/articles/non-existent')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/blog/admin/articles', () => {
    it('returns 201 when creating an article', async () => {
      prisma.article.findUnique.mockResolvedValue(null);
      prisma.article.create.mockResolvedValue(mockArticleDetail);

      const res = await request(app)
        .post('/api/blog/admin/articles')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({
          title: 'New Article',
          slug: 'new-article',
          excerpt: 'A brand new article',
          body: { type: 'doc', content: [] },
          authorId: 'author-1',
          categoryId: 'cat-1',
          status: 'PUBLISHED',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.article).toBeDefined();
    });

    it('returns 409 on duplicate slug', async () => {
      prisma.article.findUnique.mockResolvedValue(mockArticle);
      const res = await request(app)
        .post('/api/blog/admin/articles')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({
          title: 'Another Article',
          slug: 'test-article',
          excerpt: 'Trying to reuse slug',
          body: { type: 'doc', content: [] },
          authorId: 'author-1',
        });
      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /api/blog/admin/articles/:id', () => {
    it('returns 200 on successful update', async () => {
      prisma.article.findUnique.mockResolvedValue(mockArticle);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
      prisma.article.update.mockResolvedValue({ ...mockArticle, title: 'Updated Title' });

      const res = await request(app)
        .patch('/api/blog/admin/articles/article-1')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ title: 'Updated Title' });
      expect(res.status).toBe(200);
      expect(res.body.data.article).toBeDefined();
    });

    it('returns 404 for non-existent article', async () => {
      prisma.article.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .patch('/api/blog/admin/articles/non-existent')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ title: 'Updated' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/blog/admin/articles/:id', () => {
    it('returns 200 (soft-delete / archive)', async () => {
      prisma.article.findUnique.mockResolvedValue(mockArticle);
      prisma.article.update.mockResolvedValue({ ...mockArticle, status: 'ARCHIVED' });

      const res = await request(app)
        .delete('/api/blog/admin/articles/article-1')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('archived');
    });

    it('returns 404 for non-existent article', async () => {
      prisma.article.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .delete('/api/blog/admin/articles/non-existent')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/blog/admin/refresh/:articleId?', () => {
    it('returns 200 when refreshing all caches', async () => {
      const res = await request(app)
        .post('/api/blog/admin/refresh/all')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
    });

    it('returns 200 when refreshing single article cache', async () => {
      prisma.article.findUnique.mockResolvedValue({ slug: 'test-article' });
      const res = await request(app)
        .post('/api/blog/admin/refresh/article-1')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/blog/admin/upload', () => {
    it('returns 200 with image data', async () => {
      const res = await request(app)
        .post('/api/blog/admin/upload')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(res.body.data.url).toBeDefined();
      expect(res.body.data.publicId).toBeDefined();
    });
  });

  describe('GET /api/blog/admin/analytics', () => {
    it('returns 200 with analytics data', async () => {
      prisma.article.count.mockResolvedValue(5);
      prisma.article.aggregate.mockResolvedValue({ _sum: { viewCount: 100, shareCount: 10 } });
      prisma.article.findMany.mockResolvedValue([{
        id: 'article-1', title: 'Top Article', slug: 'top-article',
        viewCount: 50, publishedAt: new Date('2026-07-01'),
        category: { name: 'Destinations' },
      }]);
      prisma.article.groupBy.mockResolvedValue([{ categoryId: 'cat-1', _count: { id: 3 } }]);
      prisma.articleCategory.findMany.mockResolvedValue([{ id: 'cat-1', name: 'Destinations' }]);

      const res = await request(app)
        .get('/api/blog/admin/analytics')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.totals).toBeDefined();
      expect(res.body.data.totals.totalArticles).toBe(5);
      expect(res.body.data.totals.totalViews).toBe(100);
      expect(res.body.data.totals.totalShares).toBe(10);
      expect(res.body.data.topViewed).toHaveLength(1);
      expect(res.body.data.topViewed[0].title).toBe('Top Article');
      expect(res.body.data.categoryDistribution).toBeDefined();
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/blog/admin/analytics');
      expect(res.status).toBe(401);
    });
  });
});

describe('Blog API — Admin Category CRUD', () => {
  beforeEach(() => {
    jwt.verifyAccessToken.mockReturnValue({ userId: 'author-1' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'author-1', name: 'Admin User', email: 'admin@test.com',
      roles: ['admin'], photoURL: null, active: true,
    });
  });

  describe('POST /api/blog/admin/categories', () => {
    it('returns 201 on creating a category', async () => {
      prisma.articleCategory.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/blog/admin/categories')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'New Cat', slug: 'new-cat' });
      expect(res.status).toBe(201);
    });

    it('returns 409 on duplicate slug', async () => {
      const res = await request(app)
        .post('/api/blog/admin/categories')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'Destinations', slug: 'destinations' });
      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /api/blog/admin/categories/:id', () => {
    it('returns 200 on update', async () => {
      const res = await request(app)
        .patch('/api/blog/admin/categories/cat-1')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'Updated Cat' });
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent', async () => {
      prisma.articleCategory.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .patch('/api/blog/admin/categories/non-existent')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'Updated' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/blog/admin/categories/:id', () => {
    it('returns 200 on delete', async () => {
      const res = await request(app)
        .delete('/api/blog/admin/categories/cat-1')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent', async () => {
      prisma.articleCategory.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .delete('/api/blog/admin/categories/non-existent')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(404);
    });
  });
});

describe('Blog API — Admin Tag CRUD', () => {
  beforeEach(() => {
    jwt.verifyAccessToken.mockReturnValue({ userId: 'author-1' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'author-1', name: 'Admin User', email: 'admin@test.com',
      roles: ['admin'], photoURL: null, active: true,
    });
  });

  describe('POST /api/blog/admin/tags', () => {
    it('returns 201 on creating a tag', async () => {
      prisma.articleTag.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/blog/admin/tags')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'New Tag', slug: 'new-tag' });
      expect(res.status).toBe(201);
    });

    it('returns 409 on duplicate slug', async () => {
      const res = await request(app)
        .post('/api/blog/admin/tags')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'Africa', slug: 'africa' });
      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /api/blog/admin/tags/:id', () => {
    it('returns 200 on update', async () => {
      const res = await request(app)
        .patch('/api/blog/admin/tags/tag-1')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'Updated Tag' });
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent', async () => {
      prisma.articleTag.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .patch('/api/blog/admin/tags/non-existent')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ name: 'Updated' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/blog/admin/tags/:id', () => {
    it('returns 200 on delete', async () => {
      const res = await request(app)
        .delete('/api/blog/admin/tags/tag-1')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent', async () => {
      prisma.articleTag.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .delete('/api/blog/admin/tags/non-existent')
        .set('Authorization', 'Bearer valid-admin-token');
      expect(res.status).toBe(404);
    });
  });
});

describe('Blog API — Auth Enforcement on Admin Routes', () => {
  it('returns 401 for admin articles without auth token', async () => {
    const res = await request(app).get('/api/blog/admin/articles');
    expect(res.status).toBe(401);
  });

  it('returns 401 for admin article detail without auth', async () => {
    const res = await request(app).get('/api/blog/admin/articles/article-1');
    expect(res.status).toBe(401);
  });

  it('returns 401 for creating article without auth', async () => {
    const res = await request(app)
      .post('/api/blog/admin/articles')
      .send({ title: 'Test', slug: 'test', excerpt: 'test', body: {}, authorId: 'a1' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for category CRUD without auth', async () => {
    const res = await request(app)
      .post('/api/blog/admin/categories')
      .send({ name: 'Test', slug: 'test' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for tag CRUD without auth', async () => {
    const res = await request(app)
      .post('/api/blog/admin/tags')
      .send({ name: 'Test', slug: 'test' });
    expect(res.status).toBe(401);
  });
});

describe('JSON-LD Structured Data Validation', () => {
  const { buildArticleSchema, buildArticleListSchema } = require('../../utils/blogSEO');

  const article = {
    title: 'Test Article',
    excerpt: 'Test excerpt',
    featuredImage: 'https://example.com/img.jpg',
    publishedAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-02'),
    slug: 'test-article',
    author: { name: 'Admin User', photoURL: '/photos/admin.jpg' },
  };

  const articleNoImage = { ...article, featuredImage: null };
  const articleNoDates = { ...article, publishedAt: null, updatedAt: null };
  const articleNoAuthor = { ...article, author: null };

  describe('buildArticleSchema', () => {
    it('returns valid schema.org BlogPosting structure', () => {
      const schema = buildArticleSchema(article);
      expect(schema).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
      });
    });

    it('includes headline and description', () => {
      const schema = buildArticleSchema(article);
      expect(schema.headline).toBe('Test Article');
      expect(schema.description).toBe('Test excerpt');
    });

    it('includes image when featuredImage is present', () => {
      const schema = buildArticleSchema(article);
      expect(schema.image).toBe('https://example.com/img.jpg');
    });

    it('omits image when featuredImage is null', () => {
      const schema = buildArticleSchema(articleNoImage);
      expect(schema.image).toBeUndefined();
    });

    it('includes datePublished when publishedAt is present', () => {
      const schema = buildArticleSchema(article);
      expect(schema.datePublished).toBe('2026-07-01T00:00:00.000Z');
    });

    it('omits datePublished when publishedAt is null', () => {
      const schema = buildArticleSchema(articleNoDates);
      expect(schema.datePublished).toBeUndefined();
    });

    it('includes dateModified when updatedAt is present', () => {
      const schema = buildArticleSchema(article);
      expect(schema.dateModified).toBe('2026-07-02T00:00:00.000Z');
    });

    it('omits dateModified when updatedAt is null', () => {
      const schema = buildArticleSchema(articleNoDates);
      expect(schema.dateModified).toBeUndefined();
    });

    it('builds valid author object', () => {
      const schema = buildArticleSchema(article);
      expect(schema.author).toMatchObject({
        '@type': 'Person',
        name: 'Admin User',
        image: '/photos/admin.jpg',
      });
    });

    it('omits author when article has no author', () => {
      const schema = buildArticleSchema(articleNoAuthor);
      expect(schema.author).toBeUndefined();
    });

    it('includes publisher with brand name', () => {
      const schema = buildArticleSchema(article);
      expect(schema.publisher).toMatchObject({
        '@type': 'Organization',
        name: expect.any(String),
      });
    });

    it('includes mainEntityOfPage with correct URL', () => {
      const schema = buildArticleSchema(article);
      expect(schema.mainEntityOfPage).toMatchObject({
        '@type': 'WebPage',
        '@id': expect.stringContaining('/blog/test-article'),
      });
    });
  });

  describe('buildArticleListSchema', () => {
    it('returns valid CollectionPage structure', () => {
      const schema = buildArticleListSchema([article, articleNoImage], 2);
      expect(schema).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
      });
    });

    it('builds ItemList with correct item count', () => {
      const schema = buildArticleListSchema([article, articleNoImage], 2);
      expect(schema.mainEntity).toMatchObject({
        '@type': 'ItemList',
        numberOfItems: 2,
      });
    });

    it('assigns correct positions and URLs', () => {
      const schema = buildArticleListSchema([article, articleNoImage], 2);
      expect(schema.mainEntity.itemListElement).toHaveLength(2);
      expect(schema.mainEntity.itemListElement[0]).toMatchObject({
        '@type': 'ListItem',
        position: 1,
      });
      expect(schema.mainEntity.itemListElement[0].url).toContain('/blog/test-article');
      expect(schema.mainEntity.itemListElement[1].position).toBe(2);
    });

    it('handles empty article list', () => {
      const schema = buildArticleListSchema([], 0);
      expect(schema.mainEntity.itemListElement).toHaveLength(0);
      expect(schema.mainEntity.numberOfItems).toBe(0);
    });
  });
});
