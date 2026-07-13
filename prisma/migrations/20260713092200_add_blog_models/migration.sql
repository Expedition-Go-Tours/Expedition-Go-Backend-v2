-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable: ArticleCategory
CREATE TABLE "ArticleCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ArticleTag
CREATE TABLE "ArticleTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "ArticleTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Article
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "featuredImage" TEXT,
    "images" JSONB,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "canonicalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "status" "ArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "readTime" INTEGER,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "shareCount" INTEGER NOT NULL DEFAULT 0,
    "authorId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ArticleTagOnArticle
CREATE TABLE "ArticleTagOnArticle" (
    "articleId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "ArticleTagOnArticle_pkey" PRIMARY KEY ("articleId", "tagId")
);

-- CreateTable: ArticleTour
CREATE TABLE "ArticleTour" (
    "articleId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,

    CONSTRAINT "ArticleTour_pkey" PRIMARY KEY ("articleId", "tourId")
);
