/**
 * Blog API — public storefront, Sanity webhook, and the admin CMS.
 *
 * Runs against the isolated `travio_test` (gated on TEST_DB_AVAILABLE). The
 * previous version mocked `prismaClient` wholesale, so every
 * `mockResolvedValue(row)` answered whatever it was handed: a filter that
 * dropped its `where` clause still returned "our" article and passed. Two
 * things follow that the mocks could not see, and both are the point of this
 * conversion.
 *
 * Scoping and publication. A DRAFT and an ARCHIVED article exist purely so
 * "published only" has something to be measured against — the public list,
 * both tag and category listings, the sitemap and the article detail page all
 * have to leave them out, while the admin list has to keep them in. A second
 * customer token proves `restrictTo('admin')` actually rejects: the old suite
 * only ever asserted 401s, because a mocked `verifyAccessToken` could not
 * produce anyone *unauthorised*.
 *
 * Referential behaviour. Deleting a category does not delete its articles —
 * `Article.categoryId` is optional, so Postgres nulls the column and the piece
 * survives without its category. Deleting a tag cascades only the join rows.
 * Neither is visible to a mock, which happily reports 200 for either.
 *
 * Kept mocked, deliberately:
 *   - `cacheHelper` as a pass-through (`getOrSet: (_k, fn) => fn()`). The
 *     300-second Redis entries would otherwise make assertions depend on the
 *     order tests ran in; the queries themselves are what is under test.
 *   - `@sanity/client`, which is an external CMS. The webhook is exercised end
 *     to end up to that boundary, including real HMAC signature checking.
 *   - `uploadMiddleware`, because Cloudinary is external; the route's own
 *     response mapping is still asserted.
 *
 * `config/jwt` is NOT mocked: tokens are minted for real users, which is the
 * only way `protect` and `restrictTo` see a real subject.
 *
 * Fixtures are keyed on a `blogtst-` prefix and removed in `afterAll`.
 */
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/core/services/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/cacheHelper', () => ({
  // Pass-through: always run the query, never serve a stored copy.
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  _clearMemory: jest.fn(),
}));
jest.mock('@sanity/client', () => jest.fn(() => ({ fetch: jest.fn() })));
jest.mock('../../middleware/uploadMiddleware', () => {
  const fn = (req, _res, next) => next();
  fn._cloudinaryMissing = false;
  return {
    uploadUserPhoto: fn,
    uploadTourPhotos: fn,
    uploadReviewPhotos: fn,
    uploadSupplierDocuments: fn,
    uploadSupplierDocument: fn,
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
const prisma = require('../../src/core/services/prismaClient');
const { signAccessToken } = require('../../config/jwt');
const cache = require('../../src/core/services/cacheHelper');
const sanityClient = require('@sanity/client');

const dbAvailable = process.env.TEST_DB_AVAILABLE === 'true';
const describeDb = dbAvailable ? describe : describe.skip;

const PREFIX = 'blogtst-';
const ADMIN_EMAIL = `${PREFIX}admin@test.com`;
const CUSTOMER_EMAIL = `${PREFIX}customer@test.com`;

const SLUG_ALPHA = `${PREFIX}alpha`;
const SLUG_BETA = `${PREFIX}beta`;
const SLUG_VIEWS = `${PREFIX}views`;
const SLUG_ADMIN_VIEWS = `${PREFIX}admin-views`;
const SLUG_LOCALE = `${PREFIX}locale`;
const SLUG_LOCALE_FR = `${PREFIX}locale--fr`;
const SLUG_DRAFT = `${PREFIX}draft`;
const SLUG_ARCHIVED = `${PREFIX}archived`;
const SLUG_DOOMED_ARTICLE = `${PREFIX}doomed-article`;

const CAT_DESTINATIONS = `${PREFIX}destinations`;
const CAT_TIPS = `${PREFIX}tips`;
const CAT_EMPTY = `${PREFIX}empty`;
const CAT_DOOMED = `${PREFIX}doomed`;
const TAG_AFRICA = `${PREFIX}africa`;
const TAG_SAFARI = `${PREFIX}safari`;
const TAG_DOOMED = `${PREFIX}doomed-tag`;

const PORTABLE_TEXT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
};

let adminId;
let adminToken;
let customerToken;
let categoryDestinationsId;
let categoryTipsId;
let categoryDoomedId;
let tagAfricaId;
let tagSafariId;
let tagDoomedId;
let articleAlphaId;

const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const customerAuth = () => ({ Authorization: `Bearer ${customerToken}` });

async function upsertUser(email, data) {
  return prisma.user.upsert({
    where: { email },
    update: data,
    create: { firebaseUid: `test-${email}`, email, photoURL: '', active: true, ...data },
  });
}

async function createArticle({ slug, ...overrides }) {
  return prisma.article.create({
    data: {
      title: `Blogtst ${slug}`,
      slug,
      excerpt: `Excerpt for ${slug}`,
      body: PORTABLE_TEXT,
      status: 'PUBLISHED',
      publishedAt: new Date('2026-07-01T00:00:00.000Z'),
      readTime: 4,
      locale: 'en',
      authorId: adminId,
      categoryId: categoryDestinationsId,
      ...overrides,
    },
  });
}

/** Poll until `fn` returns a value, or give up and return whatever it gave. */
async function eventually(fn, { timeout = 3000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const viewCountOf = (slug) => prisma.article.findUnique({ where: { slug } }).then((a) => a && a.viewCount);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('Blog API', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    await prisma.$connect();
    // `getOrSet` is mocked to a pass-through, but the invalidation calls the
    // handlers make go through the same module — clear the real keys anyway so
    // a run that shares a worker with a mocked suite cannot be confused by
    // anything already stored under `blog:*`.
    await cache.invalidateKeys(['blog:articles:list', 'blog:sitemap', 'blog:categories', 'blog:tags']);

    const admin = await upsertUser(ADMIN_EMAIL, {
      name: 'Blogtst Admin',
      roles: ['admin'],
      notificationPreferences: { emailNotifications: {}, pushNotifications: {} },
    });
    adminId = admin.id;
    adminToken = signAccessToken({ userId: admin.id });

    const customer = await upsertUser(CUSTOMER_EMAIL, {
      name: 'Blogtst Customer',
      roles: ['customer'],
      notificationPreferences: { emailNotifications: {}, pushNotifications: {} },
    });
    customerToken = signAccessToken({ userId: customer.id });

    const destinations = await prisma.articleCategory.upsert({
      where: { slug: CAT_DESTINATIONS },
      update: {},
      create: { name: 'Blogtst Destinations', slug: CAT_DESTINATIONS },
    });
    categoryDestinationsId = destinations.id;

    const tips = await prisma.articleCategory.upsert({
      where: { slug: CAT_TIPS },
      update: {},
      create: { name: 'Blogtst Travel Tips', slug: CAT_TIPS },
    });
    categoryTipsId = tips.id;

    await prisma.articleCategory.upsert({
      where: { slug: CAT_EMPTY },
      update: {},
      create: { name: 'Blogtst Empty', slug: CAT_EMPTY },
    });
    const doomed = await prisma.articleCategory.upsert({
      where: { slug: CAT_DOOMED },
      update: {},
      create: { name: 'Blogtst Doomed', slug: CAT_DOOMED },
    });
    categoryDoomedId = doomed.id;

    const africa = await prisma.articleTag.upsert({
      where: { slug: TAG_AFRICA },
      update: {},
      create: { name: 'Blogtst Africa', slug: TAG_AFRICA },
    });
    tagAfricaId = africa.id;

    const safari = await prisma.articleTag.upsert({
      where: { slug: TAG_SAFARI },
      update: {},
      create: { name: 'Blogtst Safari', slug: TAG_SAFARI },
    });
    tagSafariId = safari.id;

    const doomedTag = await prisma.articleTag.upsert({
      where: { slug: TAG_DOOMED },
      update: {},
      create: { name: 'Blogtst Doomed Tag', slug: TAG_DOOMED },
    });
    tagDoomedId = doomedTag.id;

    // `alpha` carries a huge viewCount so `sortBy=popular` and the analytics
    // "top viewed" ranking have a stable winner no matter what else is in the
    // table while this suite runs.
    const alpha = await createArticle({
      slug: SLUG_ALPHA,
      excerpt: 'The zebra migration corridor, walked end to end.',
      publishedAt: new Date('2026-07-10T00:00:00.000Z'),
      viewCount: 999999,
      readTime: 9,
      tags: { create: [{ tagId: tagAfricaId }] },
    });
    articleAlphaId = alpha.id;

    await createArticle({
      slug: SLUG_BETA,
      excerpt: 'A packing list for the wet season.',
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
      viewCount: 7,
      locale: 'fr',
      categoryId: categoryTipsId,
      tags: { create: [{ tagId: tagSafariId }] },
    });

    await createArticle({ slug: SLUG_VIEWS, viewCount: 0 });
    await createArticle({ slug: SLUG_ADMIN_VIEWS, viewCount: 5 });
    await createArticle({ slug: SLUG_LOCALE });
    await createArticle({ slug: SLUG_LOCALE_FR, locale: 'fr' });

    // Visible to the admin list, invisible everywhere public — and tagged with
    // `africa`, so the public tag page returning 1 while `/tags` reports 2
    // articles for that tag is a real, observable difference between the two
    // counts (`_count.articles` is unfiltered; the listing is PUBLISHED-only).
    await createArticle({
      slug: SLUG_DRAFT,
      status: 'DRAFT',
      publishedAt: null,
      tags: { create: [{ tagId: tagAfricaId }] },
    });
    await createArticle({ slug: SLUG_ARCHIVED, status: 'ARCHIVED' });
    // Starts attached to a category it is the only member of, so the delete
    // test below has something real to detach.
    await createArticle({
      slug: SLUG_DOOMED_ARTICLE,
      categoryId: categoryDoomedId,
      excerpt: 'Belongs to the doomed category.',
      tags: { create: [{ tagId: tagDoomedId }] },
    });
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.articleTag.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.articleCategory.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  // ==========================================================================
  // PUBLIC STOREFRONT
  // ==========================================================================

  describe('GET /api/blog/articles', () => {
    it('returns 200 with paginated published articles', async () => {
      const res = await request(app).get('/api/blog/articles?limit=50');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data.articles)).toBe(true);
      expect(res.body.pagination.currentPage).toBe(1);
      expect(res.body.data.articles.length).toBeGreaterThan(0);
      // `pagination` is a sibling of `data`, not inside it.
      expect(res.body.pagination.totalCount).toBe(res.body.data.articles.length);
    });

    it('hides drafts and archived articles from the public list', async () => {
      const res = await request(app).get('/api/blog/articles?limit=50');
      const slugs = res.body.data.articles.map((a) => a.slug);

      expect(slugs).toContain(SLUG_ALPHA);
      expect(slugs).not.toContain(SLUG_DRAFT);
      expect(slugs).not.toContain(SLUG_ARCHIVED);
      expect(res.body.data.articles.every((a) => a.status === 'PUBLISHED')).toBe(true);
    });

    it('returns the shaped fields the storefront reads', async () => {
      const res = await request(app).get('/api/blog/articles?limit=50');
      const alpha = res.body.data.articles.find((a) => a.slug === SLUG_ALPHA);

      expect(alpha).toMatchObject({
        id: articleAlphaId,
        title: `Blogtst ${SLUG_ALPHA}`,
        excerpt: 'The zebra migration corridor, walked end to end.',
        status: 'PUBLISHED',
        readTime: 9,
        locale: 'en',
        viewCount: 999999,
        category: { name: 'Blogtst Destinations', slug: CAT_DESTINATIONS },
        author: { name: 'Blogtst Admin', id: adminId },
      });
      expect(alpha.tags.map((t) => t.slug)).toEqual([TAG_AFRICA]);
      // The list projection deliberately omits `body`; it is only on the detail
      // endpoint.
      expect(alpha.body).toBeUndefined();
    });

    it('respects the limit query parameter', async () => {
      const res = await request(app).get('/api/blog/articles?limit=5');

      expect(res.status).toBe(200);
      expect(res.body.data.tours).toBeUndefined();
      expect(res.body.data.articles.length).toBeLessThanOrEqual(5);
      expect(res.body.pagination.limit).toBe(5);
    });

    it('filters by category slug', async () => {
      const res = await request(app).get(`/api/blog/articles?category=${CAT_TIPS}`);
      const slugs = res.body.data.articles.map((a) => a.slug);

      expect(res.status).toBe(200);
      expect(slugs).toEqual([SLUG_BETA]);
      expect(res.body.pagination.totalCount).toBe(1);
    });

    it('filters by tag slug', async () => {
      const res = await request(app).get(`/api/blog/articles?tag=${TAG_SAFARI}`);
      const slugs = res.body.data.articles.map((a) => a.slug);

      expect(slugs).toEqual([SLUG_BETA]);
    });

    it('filters by locale', async () => {
      const res = await request(app).get('/api/blog/articles?locale=fr&limit=50');
      const slugs = res.body.data.articles.map((a) => a.slug);

      expect(res.status).toBe(200);
      expect(slugs).toContain(SLUG_BETA);
      expect(slugs).toContain(SLUG_LOCALE_FR);
      expect(slugs).not.toContain(SLUG_ALPHA);
      expect(res.body.data.articles.every((a) => a.locale === 'fr')).toBe(true);
    });

    it('searches title and excerpt', async () => {
      const res = await request(app).get('/api/blog/articles?search=zebra');
      const slugs = res.body.data.articles.map((a) => a.slug);

      expect(slugs).toContain(SLUG_ALPHA);
      expect(slugs).not.toContain(SLUG_BETA);
    });

    it('search is case-insensitive', async () => {
      const res = await request(app).get('/api/blog/articles?search=PACKING');

      expect(res.body.data.articles.map((a) => a.slug)).toContain(SLUG_BETA);
    });

    it('sorts by popularity', async () => {
      const res = await request(app).get('/api/blog/articles?sortBy=popular&limit=50');

      expect(res.body.data.articles[0].slug).toBe(SLUG_ALPHA);
      const counts = res.body.data.articles.map((a) => a.viewCount);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    });

    it('defaults to newest first', async () => {
      const res = await request(app).get('/api/blog/articles?limit=50');
      const dates = res.body.data.articles.map((a) => new Date(a.publishedAt).getTime());

      expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    });

    it('returns 400 for invalid sortBy', async () => {
      const res = await request(app).get('/api/blog/articles?sortBy=invalid');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('fail');
    });
  });

  describe('GET /api/blog/articles/sitemap', () => {
    it('returns 200 with sitemap entries', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data.urls)).toBe(true);
    });

    it('only includes published articles', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap');
      const slugs = res.body.data.urls.map((u) => u.slug);

      expect(slugs).toContain(SLUG_ALPHA);
      expect(slugs).not.toContain(SLUG_DRAFT);
      expect(slugs).not.toContain(SLUG_ARCHIVED);
    });

    it('orders by publishedAt desc', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap');
      const slugs = res.body.data.urls.map((u) => u.slug);

      expect(slugs.indexOf(SLUG_ALPHA)).toBeLessThan(slugs.indexOf(SLUG_BETA));
    });

    it('returns each entry with slug, updatedAt, and locale', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap');
      const entry = res.body.data.urls.find((u) => u.slug === SLUG_ALPHA);

      expect(entry).toMatchObject({ slug: SLUG_ALPHA, locale: 'en' });
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

    it('XML sitemap contains the real article URLs', async () => {
      const res = await request(app).get('/api/blog/articles/sitemap?format=xml');

      expect(res.text).toContain(`<loc>${process.env.FRONTEND_URL || 'https://travioafrica.com'}/blog/${SLUG_ALPHA}</loc>`);
      expect(res.text).toContain('<lastmod>');
      expect(res.text).toContain('<changefreq>weekly</changefreq>');
      expect(res.text).toContain('<priority>0.8</priority>');
      expect(res.text).not.toContain(SLUG_DRAFT);
    });
  });

  describe('GET /api/blog/articles/:slug', () => {
    it('returns 200 with the article detail', async () => {
      const res = await request(app).get(`/api/blog/articles/${SLUG_ALPHA}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.article).toMatchObject({
        id: articleAlphaId,
        slug: SLUG_ALPHA,
        title: `Blogtst ${SLUG_ALPHA}`,
        locale: 'en',
        author: { name: 'Blogtst Admin' },
      });
      // The detail projection is the only one that carries the body.
      expect(res.body.data.article.body).toEqual(PORTABLE_TEXT);
    });

    it('returns 404 for a non-existent slug', async () => {
      const res = await request(app).get(`/api/blog/articles/${PREFIX}no-such-article`);

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('fail');
    });

    it('returns 404 for a slug that exists but is not published', async () => {
      // The row is really there — only the status filter keeps it out.
      expect(await prisma.article.findUnique({ where: { slug: SLUG_DRAFT } })).not.toBeNull();
      const res = await request(app).get(`/api/blog/articles/${SLUG_DRAFT}`);

      expect(res.status).toBe(404);
    });

    it('includes JSON-LD structured data built from the real row', async () => {
      const res = await request(app).get(`/api/blog/articles/${SLUG_ALPHA}`);
      const { jsonLd } = res.body.data.article;

      expect(jsonLd).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: `Blogtst ${SLUG_ALPHA}`,
        description: 'The zebra migration corridor, walked end to end.',
        author: { '@type': 'Person', name: 'Blogtst Admin' },
      });
      expect(jsonLd.mainEntityOfPage['@id']).toContain(`/blog/${SLUG_ALPHA}`);
    });

    it('lists the other locale editions of the same article', async () => {
      const en = await request(app).get(`/api/blog/articles/${SLUG_LOCALE}`);
      const fr = await request(app).get(`/api/blog/articles/${SLUG_LOCALE_FR}`);

      expect(en.body.data.article.alternateLocales).toEqual([
        { locale: 'fr', slug: SLUG_LOCALE_FR },
      ]);
      expect(fr.body.data.article.alternateLocales).toEqual([
        { locale: 'en', slug: SLUG_LOCALE },
      ]);
    });

    it('increments viewCount for an anonymous reader, once per 30 minutes', async () => {
      // Dedupe is per *viewer* across every article, not per article, and the
      // fingerprint is (ip, user-agent). Every other request in this file
      // shares one, so this reader needs its own or it would already have
      // been deduped by an earlier test.
      const viewer = request(app)
        .get(`/api/blog/articles/${SLUG_VIEWS}`)
        .set('User-Agent', 'blogtst-viewer-a');

      const before = await viewCountOf(SLUG_VIEWS);
      expect(before).toBe(0);

      await viewer.expect(200);

      // The increment is deliberately fire-and-forget in the handler, so the
      // row has to be polled for rather than assumed to be written already.
      // `> before` rather than `>= 1`, so a fixture that ever starts above
      // zero still waits instead of passing on an already-satisfied check.
      const counted = await eventually(async () => {
        const now = await viewCountOf(SLUG_VIEWS);
        return now > before ? now : null;
      });
      expect(counted).toBe(before + 1);

      // A second read from the same viewer, of a *different* article, must not
      // add a view either — the window is 30 minutes per reader.
      await request(app)
        .get(`/api/blog/articles/${SLUG_LOCALE}`)
        .set('User-Agent', 'blogtst-viewer-a')
        .expect(200);
      await sleep(200);

      expect(await viewCountOf(SLUG_VIEWS)).toBe(1);
      expect(await viewCountOf(SLUG_LOCALE)).toBe(0);
    });

    it('counts every public read regardless of who is signed in', async () => {
      // `shouldCountView` has a branch that skips admin sessions, but this
      // route has no `protect` middleware — it is public — so `req.user` is
      // never populated and the branch is unreachable here. The token below is
      // deliberately presented without being required, to pin that reality
      // rather than the intent.
      const before = await viewCountOf(SLUG_ADMIN_VIEWS);
      expect(before).toBe(5);

      const res = await request(app)
        .get(`/api/blog/articles/${SLUG_ADMIN_VIEWS}`)
        .set(auth())
        .set('User-Agent', 'blogtst-viewer-admin')
        .expect(200);

      expect(res.body.data.article.slug).toBe(SLUG_ADMIN_VIEWS);

      // The increment is fire-and-forget, so the row has to be polled for.
      // The condition must be `> before`, not `>= 1`: the fixture already
      // starts at 5, and a `>= 1` poll returns on its first check without
      // waiting at all — which reads the row before the write lands.
      const counted = await eventually(async () => {
        const now = await viewCountOf(SLUG_ADMIN_VIEWS);
        return now > before ? now : null;
      });
      expect(counted).toBe(before + 1);
    });

    it('falls through to the list endpoint when no slug is given', async () => {
      const res = await request(app).get('/api/blog/articles/');

      expect(res.status).toBe(200);
      expect(res.body.data.articles).toBeDefined();
    });
  });

  describe('GET /api/blog/articles/category/:slug', () => {
    it('returns only that category’s published articles', async () => {
      const res = await request(app).get(`/api/blog/articles/category/${CAT_TIPS}`);

      expect(res.status).toBe(200);
      expect(res.body.data.articles.map((a) => a.slug)).toEqual([SLUG_BETA]);
      expect(res.body.pagination.totalCount).toBe(1);
    });

    it('returns 404 for a category that does not exist', async () => {
      const res = await request(app).get(`/api/blog/articles/category/${PREFIX}no-such-category`);

      expect(res.status).toBe(404);
    });

    it('returns 200 with an empty page for a category that exists but is unused', async () => {
      // Not a 404: the category is real, it simply has no articles.
      const res = await request(app).get(`/api/blog/articles/category/${CAT_EMPTY}`);

      expect(res.status).toBe(200);
      expect(res.body.data.articles).toEqual([]);
      expect(res.body.pagination.totalCount).toBe(0);
    });
  });

  describe('GET /api/blog/articles/tag/:slug', () => {
    it('returns only that tag’s published articles', async () => {
      const res = await request(app).get(`/api/blog/articles/tag/${TAG_SAFARI}`);

      expect(res.body.data.articles.map((a) => a.slug)).toEqual([SLUG_BETA]);
    });

    it('returns 404 for a tag that does not exist', async () => {
      const res = await request(app).get(`/api/blog/articles/tag/${PREFIX}no-such-tag`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/blog/articles/:id/related', () => {
    it('returns 404 for an unknown article id', async () => {
      const res = await request(app).get(`/api/blog/articles/${PREFIX}no-such-id/related`);

      expect(res.status).toBe(404);
    });

    it('returns 200 with the other published articles it shares a category with', async () => {
      const res = await request(app).get(`/api/blog/articles/${articleAlphaId}/related?limit=10`);

      expect(res.status).toBe(200);
      const slugs = res.body.data.articles.map((a) => a.slug);

      // Everything else in "destinations" is related; the tips article, the
      // draft and the archived one are not.
      expect(slugs).toContain(SLUG_VIEWS);
      expect(slugs).not.toContain(SLUG_BETA);
      expect(slugs).not.toContain(SLUG_DRAFT);
      expect(slugs).not.toContain(SLUG_ARCHIVED);
      expect(slugs).not.toContain(SLUG_ALPHA);
    });
  });

  describe('GET /api/blog/categories', () => {
    it('returns the root categories with their published article counts', async () => {
      const res = await request(app).get('/api/blog/categories');

      expect(res.status).toBe(200);
      const categories = res.body.data.categories;
      expect(Array.isArray(categories)).toBe(true);

      const tips = categories.find((c) => c.slug === CAT_TIPS);
      // Exact: the public storefront is exercised before the admin tests below
      // create anything else in these categories.
      expect(tips).toMatchObject({ name: 'Blogtst Travel Tips', articleCount: 1, children: [] });

      const destinations = categories.find((c) => c.slug === CAT_DESTINATIONS);
      expect(destinations.articleCount).toBeGreaterThanOrEqual(4);
      // Drafts are not counted — `_count.articles` is filtered to PUBLISHED.
      expect(categories.find((c) => c.slug === CAT_EMPTY).articleCount).toBe(0);
    });
  });

  describe('GET /api/blog/tags', () => {
    it('returns tags, counting every article that uses them', async () => {
      const res = await request(app).get('/api/blog/tags');

      expect(res.status).toBe(200);
      const tags = res.body.data.tags;
      const africa = tags.find((t) => t.slug === TAG_AFRICA);

      // Deliberate asymmetry with the tag *listing* endpoint: `_count.articles`
      // here is unfiltered, so the DRAFT article counts, while
      // `/articles/tag/<slug>` only serves PUBLISHED. The admin UI shows both
      // numbers and they are not supposed to match.
      expect(africa.articleCount).toBe(2);
      expect(tags.find((t) => t.slug === TAG_SAFARI).articleCount).toBe(1);
    });
  });

  // ==========================================================================
  // SANITY WEBHOOK
  // ==========================================================================

  describe('POST /api/blog/webhook/sanity', () => {
    const originalSecret = process.env.SANITY_WEBHOOK_SECRET;
    const sign = (payload) => crypto
      .createHmac('sha256', originalSecret || 'test-secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    beforeAll(() => {
      process.env.SANITY_WEBHOOK_SECRET = 'test-secret';
    });

    afterAll(() => {
      if (originalSecret === undefined) delete process.env.SANITY_WEBHOOK_SECRET;
      else process.env.SANITY_WEBHOOK_SECRET = originalSecret;
    });

    const publishPayload = (slug, overrides = {}) => ({
      _type: 'article',
      _id: `sanity-${slug}`,
      slug: { current: slug },
      action: 'publish',
      ...overrides,
    });

    it('rejects a payload with no signature', async () => {
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .send(publishPayload(`${PREFIX}sanity-nosig`));

      expect(res.status).toBe(401);
    });

    it('rejects a payload signed with the wrong secret', async () => {
      const payload = publishPayload(`${PREFIX}sanity-badsig`);
      const badSignature = crypto
        .createHmac('sha256', 'not-the-secret')
        .update(JSON.stringify(payload))
        .digest('hex');

      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', badSignature)
        .send(payload);

      expect(res.status).toBe(401);
    });

    it('rejects a signature of the wrong length', async () => {
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', 'deadbeef')
        .send(publishPayload(`${PREFIX}sanity-shortsig`));

      expect(res.status).toBe(401);
    });

    it('validates the payload shape', async () => {
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', sign({}))
        .send({});

      expect(res.status).toBe(400);
    });

    it('ignores non-article webhooks', async () => {
      const payload = { _type: 'page', _id: 'page-1', action: 'publish' };
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Ignored');
    });

    it('publishes a signed article and writes it to the database', async () => {
      const slug = `${PREFIX}sanity-published`;
      const fetch = jest.fn().mockResolvedValue({
        title: 'From Sanity',
        slug,
        excerpt: 'Synced from the CMS.',
        body: PORTABLE_TEXT,
        author: { name: 'Blogtst Admin', email: ADMIN_EMAIL },
        categories: [{ name: 'Synced Category', slug: `${PREFIX}synced-category` }],
        tags: [{ name: 'Synced Tag', slug: `${PREFIX}synced-tag` }],
        locale: 'en',
        seo: { metaTitle: 'From Sanity — SEO' },
      });
      sanityClient.mockReturnValue({ fetch });

      const payload = publishPayload(slug);
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);

      // The whole point: the upsert is real, so the article, its category and
      // its tag all have to have landed in Postgres.
      const article = await prisma.article.findUnique({
        where: { slug },
        include: { category: true, tags: { include: { tag: true } }, author: true },
      });
      expect(article).toMatchObject({
        title: 'From Sanity',
        status: 'PUBLISHED',
        locale: 'en',
        metaTitle: 'From Sanity — SEO',
        authorId: adminId,
      });
      expect(article.publishedAt).toBeInstanceOf(Date);
      expect(article.category.slug).toBe(`${PREFIX}synced-category`);
      expect(article.tags.map((t) => t.tag.slug)).toEqual([`${PREFIX}synced-tag`]);

      // …and it is served publicly without a further write.
      const publicRes = await request(app).get(`/api/blog/articles/${slug}`);
      expect(publicRes.status).toBe(200);
      expect(publicRes.body.data.article.title).toBe('From Sanity');
    });

    it('falls back to the first category in the database when Sanity sends none', async () => {
      const slug = `${PREFIX}sanity-nocategory`;
      sanityClient.mockReturnValue({
        fetch: jest.fn().mockResolvedValue({
          title: 'No Category',
          slug,
          excerpt: '',
          body: [],
          author: { name: 'Nobody', email: 'nobody@nowhere.test' },
          categories: [],
          tags: [],
        }),
      });

      const payload = publishPayload(slug);
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);

      const article = await prisma.article.findUnique({ where: { slug }, include: { category: true } });
      // The author email is unknown, so it falls back to whichever admin user
      // the database returns first — any admin, not necessarily this suite's.
      const author = await prisma.user.findUnique({ where: { id: article.authorId } });
      expect(author.roles).toContain('admin');
      expect(article.category).not.toBeNull();
    });

    it('archives an article on unpublish', async () => {
      const slug = `${PREFIX}sanity-unpublish`;
      await createArticle({ slug, viewCount: 0 });

      const payload = publishPayload(slug, { action: 'unpublish' });
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      expect((await prisma.article.findUnique({ where: { slug } })).status).toBe('ARCHIVED');

      // …and it drops out of the public surface as a result.
      const publicRes = await request(app).get(`/api/blog/articles/${slug}`);
      expect(publicRes.status).toBe(404);
    });

    it('archives an article on delete', async () => {
      const slug = `${PREFIX}sanity-delete`;
      await createArticle({ slug, viewCount: 0 });

      const payload = publishPayload(slug, { action: 'delete' });
      await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', sign(payload))
        .send(payload)
        .expect(200);

      expect((await prisma.article.findUnique({ where: { slug } })).status).toBe('ARCHIVED');
    });

    it('accepts a signed publish with no slug and does nothing', async () => {
      const payload = { _type: 'article', _id: 'sanity-noslug', action: 'publish' };
      const res = await request(app)
        .post('/api/blog/webhook/sanity')
        .set('sanity-webhook-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('No slug');
    });
  });

  // ==========================================================================
  // ADMIN — ARTICLES
  // ==========================================================================

  describe('GET /api/blog/admin/articles', () => {
    it('returns 200 with drafts and archived articles included', async () => {
      const res = await request(app).get('/api/blog/admin/articles?limit=100').set(auth());

      expect(res.status).toBe(200);
      const slugs = res.body.data.articles.map((a) => a.slug);
      expect(slugs).toContain(SLUG_ALPHA);
      expect(slugs).toContain(SLUG_DRAFT);
      expect(slugs).toContain(SLUG_ARCHIVED);
    });

    it('filters by status', async () => {
      const res = await request(app).get('/api/blog/admin/articles?status=DRAFT&limit=100').set(auth());
      const slugs = res.body.data.articles.map((a) => a.slug);

      expect(res.status).toBe(200);
      expect(slugs).toContain(SLUG_DRAFT);
      expect(slugs).not.toContain(SLUG_ALPHA);
      expect(res.body.data.articles.every((a) => a.status === 'DRAFT')).toBe(true);
    });

    it('filters by category slug', async () => {
      const res = await request(app).get(`/api/blog/admin/articles?category=${CAT_TIPS}&limit=100`).set(auth());

      expect(res.body.data.articles.map((a) => a.slug)).toEqual([SLUG_BETA]);
    });

    it('orders by createdAt desc and paginates', async () => {
      const res = await request(app).get('/api/blog/admin/articles?limit=2').set(auth());

      expect(res.body.data.articles).toHaveLength(2);
      expect(res.body.pagination.limit).toBe(2);
      expect(res.body.pagination.currentPage).toBe(1);
      const created = res.body.data.articles.map((a) => new Date(a.createdAt).getTime());
      expect([...created].sort((a, b) => b - a)).toEqual(created);
    });
  });

  describe('GET /api/blog/admin/articles/:id', () => {
    it('returns 200 with a single article by id', async () => {
      const res = await request(app).get(`/api/blog/admin/articles/${articleAlphaId}`).set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.article).toMatchObject({ id: articleAlphaId, slug: SLUG_ALPHA });
      expect(res.body.data.article.body).toEqual(PORTABLE_TEXT);
    });

    it('returns a draft to an admin, and says so', async () => {
      const draft = await prisma.article.findUnique({ where: { slug: SLUG_DRAFT } });
      const res = await request(app).get(`/api/blog/admin/articles/${draft.id}`).set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data.article.slug).toBe(SLUG_DRAFT);
      // The detail projection has to report the status, otherwise an editor
      // opening a draft cannot be told it is one from the response they
      // just asked for.
      expect(res.body.data.article.status).toBe('DRAFT');
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request(app).get(`/api/blog/admin/articles/${PREFIX}not-a-real-id`).set(auth());

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/blog/admin/articles', () => {
    const slug = `${PREFIX}created`;

    afterAll(async () => {
      await prisma.article.deleteMany({ where: { slug: { startsWith: slug } } });
    });

    it('creates the article and stamps publishedAt when PUBLISHED', async () => {
      const res = await request(app)
        .post('/api/blog/admin/articles')
        .set(auth())
        .send({
          title: 'Created in a test',
          slug,
          excerpt: 'Made through the admin API.',
          body: PORTABLE_TEXT,
          authorId: adminId,
          categoryId: categoryDestinationsId,
          tagIds: [tagAfricaId],
          status: 'PUBLISHED',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.article).toMatchObject({
        slug,
        status: 'PUBLISHED',
        author: { id: adminId },
        category: { id: categoryDestinationsId },
      });
      expect(new Date(res.body.data.article.publishedAt).getTime()).toBeGreaterThan(0);
      expect(res.body.data.article.tags.map((t) => t.id)).toEqual([tagAfricaId]);

      // The write is real: the row is there, with its join rows.
      const row = await prisma.article.findUnique({
        where: { slug },
        include: { tags: { select: { tagId: true } } },
      });
      expect(row).not.toBeNull();
      expect(row.status).toBe('PUBLISHED');
      expect(row.tags.map((t) => t.tagId)).toEqual([tagAfricaId]);
    });

    it('leaves publishedAt empty for a draft', async () => {
      const draftSlug = `${PREFIX}created-draft`;
      const res = await request(app)
        .post('/api/blog/admin/articles')
        .set(auth())
        .send({
          title: 'Draft in a test',
          slug: draftSlug,
          excerpt: 'Not yet published.',
          body: PORTABLE_TEXT,
          authorId: adminId,
          status: 'DRAFT',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.article.publishedAt).toBeNull();
      expect(res.body.data.article.category).toBeNull();
      expect((await prisma.article.findUnique({ where: { slug: draftSlug } })).status).toBe('DRAFT');
    });

    it('returns 409 on a duplicate slug', async () => {
      const res = await request(app)
        .post('/api/blog/admin/articles')
        .set(auth())
        .send({
          title: 'Duplicate',
          slug,
          excerpt: 'Trying to reuse a slug.',
          body: PORTABLE_TEXT,
          authorId: adminId,
        });

      expect(res.status).toBe(409);
      // Nothing was written over the original.
      expect((await prisma.article.findUnique({ where: { slug } })).title).toBe('Created in a test');
    });

    it('returns 400 when the payload fails validation', async () => {
      const res = await request(app)
        .post('/api/blog/admin/articles')
        .set(auth())
        .send({ title: 'No slug', excerpt: 'Missing the required slug.', body: {}, authorId: adminId });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/blog/admin/articles/:id', () => {
    let targetId;
    const targetSlug = `${PREFIX}updated`;

    beforeAll(async () => {
      const created = await prisma.article.create({
        data: {
          title: 'To be updated',
          slug: targetSlug,
          excerpt: 'Original excerpt.',
          body: PORTABLE_TEXT,
          status: 'DRAFT',
          authorId: adminId,
          categoryId: categoryDestinationsId,
        },
      });
      targetId = created.id;
    });

    it('returns 200 and persists the new values', async () => {
      const res = await request(app)
        .patch(`/api/blog/admin/articles/${targetId}`)
        .set(auth())
        .send({ title: 'Updated Title', readTime: 12 });

      expect(res.status).toBe(200);
      expect(res.body.data.article).toMatchObject({ id: targetId, title: 'Updated Title', readTime: 12 });

      const row = await prisma.article.findUnique({ where: { id: targetId } });
      expect(row.title).toBe('Updated Title');
      expect(row.readTime).toBe(12);
      expect(row.excerpt).toBe('Original excerpt.');
    });

    it('stamps publishedAt when a draft is published', async () => {
      const res = await request(app)
        .patch(`/api/blog/admin/articles/${targetId}`)
        .set(auth())
        .send({ status: 'PUBLISHED' });

      expect(res.status).toBe(200);
      expect(res.body.data.article.publishedAt).not.toBeNull();
      expect((await prisma.article.findUnique({ where: { id: targetId } })).publishedAt).toBeInstanceOf(Date);
    });

    it('replaces the tag links rather than appending to them', async () => {
      const first = await request(app)
        .patch(`/api/blog/admin/articles/${targetId}`)
        .set(auth())
        .send({ tagIds: [tagAfricaId] });
      expect(first.body.data.article.tags.map((t) => t.id)).toEqual([tagAfricaId]);

      const second = await request(app)
        .patch(`/api/blog/admin/articles/${targetId}`)
        .set(auth())
        .send({ tagIds: [tagSafariId] });

      const row = await prisma.article.findUnique({
        where: { id: targetId },
        include: { tags: { select: { tagId: true } } },
      });
      expect(row.tags.map((t) => t.tagId)).toEqual([tagSafariId]);
      expect(second.body.data.article.tags.map((t) => t.id)).toEqual([tagSafariId]);
    });

    it('returns 409 when moving onto another article’s slug', async () => {
      const res = await request(app)
        .patch(`/api/blog/admin/articles/${targetId}`)
        .set(auth())
        .send({ slug: SLUG_ALPHA });

      expect(res.status).toBe(409);
      expect((await prisma.article.findUnique({ where: { id: targetId } })).slug).toBe(targetSlug);
    });

    it('returns 404 for a non-existent article', async () => {
      const res = await request(app)
        .patch(`/api/blog/admin/articles/${PREFIX}not-a-real-id`)
        .set(auth())
        .send({ title: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/blog/admin/articles/:id', () => {
    it('archives rather than deleting the row', async () => {
      const slug = `${PREFIX}to-archive`;
      const created = await createArticle({ slug, viewCount: 0 });

      const res = await request(app).delete(`/api/blog/admin/articles/${created.id}`).set(auth());

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('archived');

      const row = await prisma.article.findUnique({ where: { id: created.id } });
      expect(row).not.toBeNull();
      expect(row.status).toBe('ARCHIVED');

      // …and it is gone from the public surface immediately.
      await request(app).get(`/api/blog/articles/${slug}`).expect(404);
    });

    it('returns 404 for a non-existent article', async () => {
      const res = await request(app).delete(`/api/blog/admin/articles/${PREFIX}not-a-real-id`).set(auth());

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/blog/admin/refresh/:articleId?', () => {
    it('clears all blog caches', async () => {
      const res = await request(app).post('/api/blog/admin/refresh/all').set(auth());

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('cleared');
      expect(cache.invalidateKeys).toHaveBeenCalled();
    });

    it('clears a single article’s cache', async () => {
      const res = await request(app).post(`/api/blog/admin/refresh/${articleAlphaId}`).set(auth());

      expect(res.status).toBe(200);
      expect(res.body.message).toContain(articleAlphaId);
    });

    it('returns 404 for an unknown article id', async () => {
      const res = await request(app).post(`/api/blog/admin/refresh/${PREFIX}not-a-real-id`).set(auth());

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/blog/admin/upload', () => {
    it('returns 200 with the uploaded image data', async () => {
      const res = await request(app).post('/api/blog/admin/upload').set(auth());

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        url: 'https://res.cloudinary.com/test/image/upload/v1/blog/test.jpg',
        publicId: 'test-public-id',
        width: 1200,
        height: 800,
        format: 'jpg',
      });
    });
  });

  describe('GET /api/blog/admin/analytics', () => {
    it('returns totals computed from the real table', async () => {
      const res = await request(app).get('/api/blog/admin/analytics').set(auth());

      expect(res.status).toBe(200);
      const { totals } = res.body.data;

      expect(totals.totalArticles).toBe(await prisma.article.count());
      expect(totals.publishedCount).toBe(await prisma.article.count({ where: { status: 'PUBLISHED' } }));
      expect(totals.draftCount).toBe(await prisma.article.count({ where: { status: 'DRAFT' } }));
      expect(totals.archivedCount).toBe(await prisma.article.count({ where: { status: 'ARCHIVED' } }));

      const summed = await prisma.article.aggregate({ _sum: { viewCount: true, shareCount: true } });
      expect(totals.totalViews).toBe(summed._sum.viewCount || 0);
      expect(totals.totalShares).toBe(summed._sum.shareCount || 0);
    });

    it('ranks the top viewed articles by real view counts', async () => {
      const res = await request(app).get('/api/blog/admin/analytics').set(auth());
      const { topViewed } = res.body.data;

      // `alpha` was seeded with a viewCount far above anything else, so it has
      // to lead — and nothing archived or drafted may appear at all. The count
      // itself is only a floor: earlier tests in this file read `alpha`
      // anonymously, which adds to it.
      expect(topViewed[0]).toMatchObject({
        slug: SLUG_ALPHA,
        title: `Blogtst ${SLUG_ALPHA}`,
        category: 'Blogtst Destinations',
      });
      expect(topViewed[0].viewCount).toBeGreaterThanOrEqual(999999);
      expect(topViewed.every((a) => a.slug !== SLUG_DRAFT)).toBe(true);

      const counts = topViewed.map((a) => a.viewCount);
      expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    });

    it('reports the category distribution for published articles only', async () => {
      const res = await request(app).get('/api/blog/admin/analytics').set(auth());
      const tips = res.body.data.categoryDistribution.find((c) => c.categoryId === categoryTipsId);

      expect(tips).toMatchObject({ categoryName: 'Blogtst Travel Tips', articleCount: 1 });
      expect(res.body.data.categoryDistribution.some((c) => c.categoryName === 'Unknown')).toBe(false);
    });
  });

  // ==========================================================================
  // ADMIN — CATEGORIES
  // ==========================================================================

  describe('POST /api/blog/admin/categories', () => {
    it('creates the category and returns it', async () => {
      const slug = `${PREFIX}created-cat`;
      const res = await request(app)
        .post('/api/blog/admin/categories')
        .set(auth())
        .send({ name: 'Created Category', slug, description: 'Made in a test.' });

      expect(res.status).toBe(201);
      expect(res.body.data.category).toMatchObject({ name: 'Created Category', slug });
      expect(await prisma.articleCategory.findUnique({ where: { slug } })).not.toBeNull();
    });

    it('returns 409 on a duplicate slug', async () => {
      const res = await request(app)
        .post('/api/blog/admin/categories')
        .set(auth())
        .send({ name: 'Duplicate Category', slug: CAT_TIPS });

      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /api/blog/admin/categories/:id', () => {
    it('returns 200 and persists the change', async () => {
      const existing = await prisma.articleCategory.findUnique({ where: { slug: CAT_EMPTY } });
      const res = await request(app)
        .patch(`/api/blog/admin/categories/${existing.id}`)
        .set(auth())
        .send({ name: 'Blogtst Still Empty', description: 'Renamed in a test.' });

      expect(res.status).toBe(200);
      const row = await prisma.articleCategory.findUnique({ where: { id: existing.id } });
      expect(row).toMatchObject({ name: 'Blogtst Still Empty', description: 'Renamed in a test.' });
    });

    it('returns 409 when moving onto another category’s slug', async () => {
      const existing = await prisma.articleCategory.findUnique({ where: { slug: CAT_EMPTY } });
      const res = await request(app)
        .patch(`/api/blog/admin/categories/${existing.id}`)
        .set(auth())
        .send({ slug: CAT_TIPS });

      expect(res.status).toBe(409);
      expect((await prisma.articleCategory.findUnique({ where: { id: existing.id } })).slug).toBe(CAT_EMPTY);
    });

    it('returns 404 for a non-existent category', async () => {
      const res = await request(app)
        .patch(`/api/blog/admin/categories/${PREFIX}not-a-real-id`)
        .set(auth())
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/blog/admin/categories/:id', () => {
    it('keeps the articles and detaches them from the category', async () => {
      const category = await prisma.articleCategory.findUnique({ where: { slug: CAT_DOOMED } });
      const article = await prisma.article.findUnique({ where: { slug: SLUG_DOOMED_ARTICLE } });
      expect(article.categoryId).toBe(category.id);

      const res = await request(app).delete(`/api/blog/admin/categories/${category.id}`).set(auth());

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('deleted');

      // `Article.categoryId` is optional, so Postgres applies SetNull: the
      // piece survives, without its category. A hard delete of the articles
      // would have been a much worse answer, and no mock could have told the
      // two apart.
      const row = await prisma.article.findUnique({ where: { id: article.id } });
      expect(row).not.toBeNull();
      expect(row.categoryId).toBeNull();
      expect(await prisma.articleCategory.findUnique({ where: { id: category.id } })).toBeNull();
    });

    it('returns 404 for a non-existent category', async () => {
      const res = await request(app).delete(`/api/blog/admin/categories/${PREFIX}not-a-real-id`).set(auth());

      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // ADMIN — TAGS
  // ==========================================================================

  describe('POST /api/blog/admin/tags', () => {
    it('creates the tag and returns it', async () => {
      const slug = `${PREFIX}created-tag`;
      const res = await request(app)
        .post('/api/blog/admin/tags')
        .set(auth())
        .send({ name: 'Created Tag', slug });

      expect(res.status).toBe(201);
      expect(res.body.data.tag).toMatchObject({ name: 'Created Tag', slug });
      expect(await prisma.articleTag.findUnique({ where: { slug } })).not.toBeNull();
    });

    it('returns 409 on a duplicate slug', async () => {
      const res = await request(app)
        .post('/api/blog/admin/tags')
        .set(auth())
        .send({ name: 'Duplicate Tag', slug: TAG_AFRICA });

      expect(res.status).toBe(409);
    });
  });

  describe('PATCH /api/blog/admin/tags/:id', () => {
    it('returns 200 and persists the change', async () => {
      const existing = await prisma.articleTag.findUnique({ where: { slug: TAG_DOOMED } });
      const res = await request(app)
        .patch(`/api/blog/admin/tags/${existing.id}`)
        .set(auth())
        .send({ name: 'Blogtst Renamed Tag' });

      expect(res.status).toBe(200);
      expect((await prisma.articleTag.findUnique({ where: { id: existing.id } })).name).toBe('Blogtst Renamed Tag');
    });

    it('returns 409 when moving onto another tag’s slug', async () => {
      const existing = await prisma.articleTag.findUnique({ where: { slug: TAG_DOOMED } });
      const res = await request(app)
        .patch(`/api/blog/admin/tags/${existing.id}`)
        .set(auth())
        .send({ slug: TAG_SAFARI });

      expect(res.status).toBe(409);
    });

    it('returns 404 for a non-existent tag', async () => {
      const res = await request(app)
        .patch(`/api/blog/admin/tags/${PREFIX}not-a-real-id`)
        .set(auth())
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/blog/admin/tags/:id', () => {
    it('keeps the article and drops only the tag link', async () => {
      const tag = await prisma.articleTag.findUnique({ where: { slug: TAG_DOOMED } });
      const article = await prisma.article.findUnique({ where: { slug: SLUG_DOOMED_ARTICLE } });

      const res = await request(app).delete(`/api/blog/admin/tags/${tag.id}`).set(auth());

      expect(res.status).toBe(200);

      // `ArticleTagOnArticle.tagId` is required, so the join row cascades while
      // the article itself stays put.
      const row = await prisma.article.findUnique({ where: { id: article.id }, include: { tags: true } });
      expect(row).not.toBeNull();
      expect(row.tags).toEqual([]);
      expect(await prisma.articleTag.findUnique({ where: { id: tag.id } })).toBeNull();
    });

    it('returns 404 for a non-existent tag', async () => {
      const res = await request(app).delete(`/api/blog/admin/tags/${PREFIX}not-a-real-id`).set(auth());

      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // AUTH ENFORCEMENT
  // ==========================================================================

  describe('admin routes reject unauthenticated and unauthorised callers', () => {
    // Every admin verb, so a route added without its guard fails here rather
    // than in production. The old suite only ever checked 401s, because a
    // mocked `verifyAccessToken` could not produce a caller who was logged in
    // but not an admin.
    const guarded = [
      ['get', '/api/blog/admin/articles'],
      ['get', `/api/blog/admin/articles/${SLUG_ALPHA}`],
      ['get', '/api/blog/admin/analytics'],
      ['post', '/api/blog/admin/refresh/all'],
      ['post', '/api/blog/admin/upload'],
      ['post', '/api/blog/admin/articles'],
      ['patch', `/api/blog/admin/articles/${SLUG_ALPHA}`],
      ['delete', `/api/blog/admin/articles/${SLUG_ALPHA}`],
      ['post', '/api/blog/admin/categories'],
      ['patch', `/api/blog/admin/categories/${SLUG_ALPHA}`],
      ['delete', `/api/blog/admin/categories/${SLUG_ALPHA}`],
      ['post', '/api/blog/admin/tags'],
      ['patch', `/api/blog/admin/tags/${SLUG_ALPHA}`],
      ['delete', `/api/blog/admin/tags/${SLUG_ALPHA}`],
    ];

    it.each(guarded)('%s %s returns 401 without a token', async (method, path) => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });

    it.each(guarded)('%s %s returns 403 for a customer', async (method, path) => {
      const res = await request(app)[method](path).set(customerAuth());
      expect(res.status).toBe(403);
    });

    it('returns 401 for a malformed token', async () => {
      const res = await request(app)
        .get('/api/blog/admin/articles')
        .set('Authorization', 'Bearer not-a-real-token');

      expect(res.status).toBe(401);
    });

    it('does not let a customer read a draft article', async () => {
      const draft = await prisma.article.findUnique({ where: { slug: SLUG_DRAFT } });

      const res = await request(app).get(`/api/blog/admin/articles/${draft.id}`).set(customerAuth());

      expect(res.status).toBe(403);
      // The guard runs before the handler, so the draft is never even looked up.
      expect(res.body.data).toBeUndefined();
    });
  });
});

// =============================================================================
// JSON-LD structured data — pure functions, no database required.
// =============================================================================
describe('JSON-LD structured data', () => {
  const { buildArticleSchema, buildArticleListSchema } = require('../../src/core/services/blogSEO');

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
    it('returns a valid schema.org BlogPosting structure', () => {
      expect(buildArticleSchema(article)).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
      });
    });

    it('includes headline and description', () => {
      const schema = buildArticleSchema(article);
      expect(schema.headline).toBe('Test Article');
      expect(schema.description).toBe('Test excerpt');
    });

    it('includes the image when featuredImage is present', () => {
      expect(buildArticleSchema(article).image).toBe('https://example.com/img.jpg');
    });

    it('omits the image when featuredImage is null', () => {
      expect(buildArticleSchema(articleNoImage).image).toBeUndefined();
    });

    it('includes datePublished when publishedAt is present', () => {
      expect(buildArticleSchema(article).datePublished).toBe('2026-07-01T00:00:00.000Z');
    });

    it('omits datePublished when publishedAt is null', () => {
      expect(buildArticleSchema(articleNoDates).datePublished).toBeUndefined();
    });

    it('includes dateModified when updatedAt is present', () => {
      expect(buildArticleSchema(article).dateModified).toBe('2026-07-02T00:00:00.000Z');
    });

    it('omits dateModified when updatedAt is null', () => {
      expect(buildArticleSchema(articleNoDates).dateModified).toBeUndefined();
    });

    it('builds a valid author object', () => {
      expect(buildArticleSchema(article).author).toMatchObject({
        '@type': 'Person',
        name: 'Admin User',
        image: '/photos/admin.jpg',
      });
    });

    it('omits the author when the article has none', () => {
      expect(buildArticleSchema(articleNoAuthor).author).toBeUndefined();
    });

    it('includes a publisher with the brand name', () => {
      expect(buildArticleSchema(article).publisher).toMatchObject({
        '@type': 'Organization',
        name: expect.any(String),
      });
    });

    it('includes mainEntityOfPage with the article URL', () => {
      expect(buildArticleSchema(article).mainEntityOfPage).toMatchObject({
        '@type': 'WebPage',
        '@id': expect.stringContaining('/blog/test-article'),
      });
    });
  });

  describe('buildArticleListSchema', () => {
    it('returns a valid CollectionPage structure', () => {
      expect(buildArticleListSchema([article, articleNoImage], 2)).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
      });
    });

    it('builds an ItemList with the correct item count', () => {
      expect(buildArticleListSchema([article, articleNoImage], 2).mainEntity).toMatchObject({
        '@type': 'ItemList',
        numberOfItems: 2,
      });
    });

    it('assigns the correct positions and URLs', () => {
      const { mainEntity } = buildArticleListSchema([article, articleNoImage], 2);
      expect(mainEntity.itemListElement).toHaveLength(2);
      expect(mainEntity.itemListElement[0]).toMatchObject({ '@type': 'ListItem', position: 1 });
      expect(mainEntity.itemListElement[0].url).toContain('/blog/test-article');
      expect(mainEntity.itemListElement[1].position).toBe(2);
    });

    it('handles an empty article list', () => {
      const { mainEntity } = buildArticleListSchema([], 0);
      expect(mainEntity.itemListElement).toHaveLength(0);
      expect(mainEntity.numberOfItems).toBe(0);
    });
  });
});
