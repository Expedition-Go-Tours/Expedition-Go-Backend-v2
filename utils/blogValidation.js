const { z } = require('zod');

const getArticlesSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12).optional(),
    category: z.string().max(100).optional(),
    tag: z.string().max(100).optional(),
    locale: z.string().max(10).optional(),
    search: z.string().max(200).optional(),
    sortBy: z.enum(['newest', 'oldest', 'popular']).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const getArticleSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    locale: z.string().max(10).optional(),
  }).passthrough().optional(),
  params: z.object({
    slug: z.string().min(1).max(200),
  }),
});

const getArticlesByCategorySchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12).optional(),
    locale: z.string().max(10).optional(),
  }).passthrough().optional(),
  params: z.object({
    slug: z.string().min(1).max(200),
  }),
});

const getArticlesByTagSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12).optional(),
    locale: z.string().max(10).optional(),
  }).passthrough().optional(),
  params: z.object({
    slug: z.string().min(1).max(200),
  }),
});

const createArticleSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(500),
    slug: z.string().min(1).max(200),
    excerpt: z.string().min(1).max(5000),
    body: z.any(),
    featuredImage: z.string().max(1000).optional(),
    images: z.any().optional(),
    metaTitle: z.string().max(200).optional(),
    metaDescription: z.string().max(500).optional(),
    canonicalUrl: z.string().max(1000).optional(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
    readTime: z.number().int().min(0).optional(),
    locale: z.string().max(10).optional(),
    authorId: z.string().min(1).max(100),
    categoryId: z.string().min(1).max(100).optional(),
    tagIds: z.array(z.string().max(100)).optional(),
    relatedTourIds: z.array(z.string().max(100)).optional(),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const updateArticleSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(500).optional(),
    slug: z.string().min(1).max(200).optional(),
    excerpt: z.string().min(1).max(5000).optional(),
    body: z.any().optional(),
    featuredImage: z.string().max(1000).optional().nullable(),
    images: z.any().optional(),
    metaTitle: z.string().max(200).optional().nullable(),
    metaDescription: z.string().max(500).optional().nullable(),
    canonicalUrl: z.string().max(1000).optional().nullable(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
    readTime: z.number().int().min(0).optional(),
    locale: z.string().max(10).optional(),
    categoryId: z.string().max(100).optional(),
    tagIds: z.array(z.string().max(100)).optional(),
    relatedTourIds: z.array(z.string().max(100)).optional(),
  }),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1).max(100),
  }),
});

const deleteArticleSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1).max(100),
  }),
});

const sanityWebhookSchema = z.object({
  body: z.object({
    _type: z.string(),
    _id: z.string(),
    slug: z.object({
      current: z.string(),
    }).optional(),
    action: z.string(),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const refreshCacheSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.object({
    articleId: z.string().optional(),
  }),
});

module.exports = {
  getArticlesSchema,
  getArticleSchema,
  getArticlesByCategorySchema,
  getArticlesByTagSchema,
  createArticleSchema,
  updateArticleSchema,
  deleteArticleSchema,
  sanityWebhookSchema,
  refreshCacheSchema,
};