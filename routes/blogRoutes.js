const express = require('express');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const { protect } = require('../middleware/authMiddleware');
const { restrictTo } = require('../middleware/authMiddleware');
const blogController = require('../controllers/blogController');
const validate = require('../middleware/validate');
const {
  getArticlesSchema,
  getArticleSchema,
  getArticlesByCategorySchema,
  getArticlesByTagSchema,
  createArticleSchema,
  updateArticleSchema,
  deleteArticleSchema,
  sanityWebhookSchema,
  refreshCacheSchema,
} = require('../utils/blogValidation');
const { uploadBlogImage } = require('../middleware/uploadMiddleware');

const router = express.Router();

// ================================
// PUBLIC ROUTES
// ================================

/**
 * @swagger
 * /api/blog/articles:
 *   get:
 *     summary: List blog articles
 *     description: |
 *       Returns paginated, filtered list of published articles.
 *       Supports category, tag, locale, text search, and sorting.
 *       Cached in Redis for 300 seconds.
 *     tags: [Blog]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 12 }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Filter by category slug
 *       - in: query
 *         name: tag
 *         schema: { type: string }
 *         description: Filter by tag slug
 *       - in: query
 *         name: locale
 *         schema: { type: string }
 *         description: Filter by locale (e.g. en, fr, de)
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Full-text search across title and excerpt
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [newest, oldest, popular] }
 *     responses:
 *       200:
 *         description: Paginated list of articles
 */
router.get('/articles', validate(getArticlesSchema), blogController.getArticles);

/**
 * @swagger
 * /api/blog/articles/sitemap:
 *   get:
 *     summary: Get blog sitemap data
 *     description: |
 *       Returns an array of { slug, updatedAt, locale } for all published articles.
 *       Used by the frontend to generate sitemap.xml for SEO.
 *       Cached in Redis for 3600 seconds.
 *     tags: [Blog]
 *     responses:
 *       200:
 *         description: Sitemap entries
 */
router.get('/articles/sitemap', blogController.getSitemap);

/**
 * @swagger
 * /api/blog/articles/category/{slug}:
 *   get:
 *     summary: Get articles by category
 *     description: Returns paginated articles filtered by category slug.
 *     tags: [Blog]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 12 }
 *       - in: query
 *         name: locale
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated articles by category
 *       404:
 *         description: Category not found
 */
router.get('/articles/category/:slug', validate(getArticlesByCategorySchema), blogController.getArticlesByCategory);

/**
 * @swagger
 * /api/blog/articles/tag/{slug}:
 *   get:
 *     summary: Get articles by tag
 *     description: Returns paginated articles filtered by tag slug.
 *     tags: [Blog]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 12 }
 *       - in: query
 *         name: locale
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated articles by tag
 *       404:
 *         description: Tag not found
 */
router.get('/articles/tag/:slug', validate(getArticlesByTagSchema), blogController.getArticlesByTag);

/**
 * @swagger
 * /api/blog/articles/{slug}:
 *   get:
 *     summary: Get article by slug
 *     description: |
 *       Returns full article detail with JSON-LD structured data.
 *       Tracks the view with 30-min dedup cooldown.
 *       Cached in Redis for 300 seconds.
 *       Supports locale-specific articles.
 *     tags: [Blog]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: locale
 *         schema: { type: string }
 *         description: Locale for i18n support
 *     responses:
 *       200:
 *         description: Full article detail with JSON-LD
 *       404:
 *         description: Article not found
 */
router.get('/articles/:slug', validate(getArticleSchema), blogController.getArticleBySlug);

/**
 * @swagger
 * /api/blog/categories:
 *   get:
 *     summary: List all article categories
 *     description: Returns category tree with article counts. Cached for 600 seconds.
 *     tags: [Blog]
 *     responses:
 *       200:
 *         description: Category tree
 */
router.get('/categories', blogController.getCategories);

/**
 * @swagger
 * /api/blog/tags:
 *   get:
 *     summary: List all article tags
 *     description: Returns all tags with article counts. Cached for 600 seconds.
 *     tags: [Blog]
 *     responses:
 *       200:
 *         description: Tags list
 */
router.get('/tags', blogController.getTags);

// ================================
// SANITY WEBHOOK (no auth — validated via HMAC signature)
// ================================

/**
 * @swagger
 * /api/blog/webhook/sanity:
 *   post:
 *     summary: Sanity webhook for content sync
 *     description: |
 *       Receives webhooks from Sanity CMS on article publish/unpublish/delete.
 *       Validates HMAC-SHA256 signature. Upserts article in PostgreSQL.
 *       Invalidates caches on success.
 *     tags: [Blog]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               _type: { type: string }
 *               _id: { type: string }
 *               slug: { type: object }
 *               action: { type: string }
 *     responses:
 *       200:
 *         description: Webhook processed
 *       401:
 *         description: Invalid signature
 */
router.post('/webhook/sanity', validate(sanityWebhookSchema), blogController.handleSanityWebhook);

// ================================
// ADMIN ROUTES (protected + rate-limited)
// ================================

const adminLimiter = createLimiter({
  name: 'admin-blog',
  defaultMax: 200,
  defaultWindowMs: 15 * 60 * 1000,
  message: { status: 'fail', message: 'Too many admin requests from this IP, please try again later.' },
});

router.use('/admin', protect, restrictTo('admin'), adminLimiter);

/**
 * @swagger
 * /api/blog/admin/articles:
 *   get:
 *     summary: List all articles (admin)
 *     description: |
 *       Returns all articles including drafts and archived.
 *       Supports filtering by status, locale, category.
 *       Admin-only.
 *     tags: [Blog Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [DRAFT, PUBLISHED, ARCHIVED] }
 *       - in: query
 *         name: locale
 *         schema: { type: string }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Category slug
 *     responses:
 *       200:
 *         description: Paginated list of all articles
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin role required
 *   post:
 *     summary: Create an article
 *     description: |
 *       Creates a new article. Can be used as fallback when Sanity is unavailable.
 *       Automatically sets publishedAt if status is PUBLISHED.
 *       Invalidates all blog caches on success.
 *       Admin-only.
 *     tags: [Blog Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, slug, excerpt, body, authorId, categoryId]
 *             properties:
 *               title: { type: string }
 *               slug: { type: string }
 *               excerpt: { type: string }
 *               body: { type: object }
 *               featuredImage: { type: string }
 *               status: { type: string, enum: [DRAFT, PUBLISHED, ARCHIVED] }
 *               locale: { type: string }
 *               authorId: { type: string }
 *               categoryId: { type: string }
 *               tagIds: { type: array, items: { type: string } }
 *               relatedTourIds: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Article created
 *       409:
 *         description: Slug conflict
 */
router.get('/admin/articles', blogController.getAdminArticles);
router.get('/admin/articles/:id', blogController.getAdminArticle);
router.post('/admin/articles', validate(createArticleSchema), blogController.createArticle);

/**
 * @swagger
 * /api/blog/admin/articles/{id}:
 *   patch:
 *     summary: Update an article
 *     description: |
 *       Updates article fields. Replaces tags and related tours entirely if provided.
 *       Automatically sets publishedAt if transitioning from DRAFT to PUBLISHED.
 *       Invalidates blog caches on success.
 *       Admin-only.
 *     tags: [Blog Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               slug: { type: string }
 *               excerpt: { type: string }
 *               body: { type: object }
 *               status: { type: string, enum: [DRAFT, PUBLISHED, ARCHIVED] }
 *               tagIds: { type: array, items: { type: string } }
 *               relatedTourIds: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Article updated
 *       404:
 *         description: Article not found
 *   delete:
 *     summary: Archive an article
 *     description: |
 *       Soft-deletes by setting status to ARCHIVED.
 *       Invalidates blog caches on success.
 *       Admin-only.
 *     tags: [Blog Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Article archived
 *       404:
 *         description: Article not found
 */
router.patch('/admin/articles/:id', validate(updateArticleSchema), blogController.updateArticle);
router.delete('/admin/articles/:id', validate(deleteArticleSchema), blogController.deleteArticle);

/**
 * @swagger
 * /api/blog/admin/refresh/{articleId}:
 *   post:
 *     summary: Refresh blog cache
 *     description: |
 *       Invalidates Redis caches for blog articles.
 *       If articleId is provided and is not 'all', only caches for that article are cleared.
 *       If articleId is omitted or 'all', all blog caches are cleared.
 *       Admin-only.
 *     tags: [Blog Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: articleId
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cache cleared
 */
router.post('/admin/refresh/:articleId?', validate(refreshCacheSchema), blogController.refreshCache);

/**
 * @swagger
 * /api/blog/admin/upload:
 *   post:
 *     summary: Upload an image for blog articles
 *     description: |
 *       Uploads an image to Cloudinary for use in blog articles.
 *       Returns the Cloudinary URL. Supports images up to 10MB.
 *       Admin-only.
 *     tags: [Blog Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *       400:
 *         description: No file provided
 */
router.post('/admin/upload', uploadBlogImage, blogController.uploadImage);

// Admin category CRUD
router.post('/admin/categories', blogController.createCategory);
router.patch('/admin/categories/:id', blogController.updateCategory);
router.delete('/admin/categories/:id', blogController.deleteCategory);

// Admin tag CRUD
router.post('/admin/tags', blogController.createTag);
router.patch('/admin/tags/:id', blogController.updateTag);
router.delete('/admin/tags/:id', blogController.deleteTag);

module.exports = router;