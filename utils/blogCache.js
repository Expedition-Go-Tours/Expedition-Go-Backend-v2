const cache = require('./cacheHelper');

const CACHE_PREFIX = 'blog:';
const LIST_CACHE_KEY = `${CACHE_PREFIX}articles:list`;
const FEATURED_CACHE_KEY = `${CACHE_PREFIX}articles:featured`;
const DETAIL_CACHE_KEY = (slug) => `${CACHE_PREFIX}article:${slug}`;
const SITEMAP_CACHE_KEY = `${CACHE_PREFIX}sitemap`;
const CATEGORIES_CACHE_KEY = `${CACHE_PREFIX}categories`;
const TAGS_CACHE_KEY = `${CACHE_PREFIX}tags`;

async function invalidateBlogCaches(slug) {
  const keys = [LIST_CACHE_KEY, FEATURED_CACHE_KEY, SITEMAP_CACHE_KEY, CATEGORIES_CACHE_KEY, TAGS_CACHE_KEY];
  if (slug) {
    keys.push(DETAIL_CACHE_KEY(slug));
  }
  await cache.invalidateKeys(keys);
}

module.exports = {
  CACHE_PREFIX: 'blog:',
  LIST_CACHE_KEY,
  FEATURED_CACHE_KEY,
  DETAIL_CACHE_KEY,
  SITEMAP_CACHE_KEY,
  CATEGORIES_CACHE_KEY,
  TAGS_CACHE_KEY,
  invalidateBlogCaches,
};