/**
 * Admin blog list search.
 *
 * The dashboard's search box sent `?search=` from the start, but the admin
 * endpoint never read it — typing filtered nothing and looked broken. Search
 * has to run server-side because the grid paginates.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  article: { findMany: jest.fn(), count: jest.fn() },
}));
jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/blogCache', () => ({
  invalidateBlogCaches: jest.fn(() => Promise.resolve()),
  LIST_CACHE_KEY: 'blog:list',
  DETAIL_CACHE_KEY: 'blog:detail',
  SITEMAP_CACHE_KEY: 'blog:sitemap',
  CATEGORIES_CACHE_KEY: 'blog:categories',
  TAGS_CACHE_KEY: 'blog:tags',
}));
jest.mock('../../src/core/services/blogSEO', () => ({ buildArticleSchema: jest.fn(() => ({})) }));
jest.mock('../../src/core/services/tourHelpers', () => ({ cheapestRetailPrice: jest.fn(() => null) }));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/core/domain/blogController');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.article.findMany.mockResolvedValue([]);
  prisma.article.count.mockResolvedValue(0);
});

describe('getAdminArticles search', () => {
  it('matches title, slug, excerpt, category, author and tag', async () => {
    const res = mockRes();

    await controller.getAdminArticles({ query: { search: 'kakum' } }, res, () => {});

    const where = prisma.article.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      { title: { contains: 'kakum', mode: 'insensitive' } },
      { slug: { contains: 'kakum', mode: 'insensitive' } },
      { excerpt: { contains: 'kakum', mode: 'insensitive' } },
      { category: { name: { contains: 'kakum', mode: 'insensitive' } } },
      { author: { name: { contains: 'kakum', mode: 'insensitive' } } },
      { tags: { some: { tag: { name: { contains: 'kakum', mode: 'insensitive' } } } } },
    ]));
    // The total must use the same filter as the page.
    expect(prisma.article.count).toHaveBeenCalledWith({ where });
  });

  it('leaves the list unfiltered when the term is blank', async () => {
    const res = mockRes();

    await controller.getAdminArticles({ query: { search: '   ' } }, res, () => {});

    const where = prisma.article.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
  });
});
