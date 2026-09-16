-- Reconcile schema.prisma with migration history.
--
-- Many schema changes were made without corresponding migrations. This single
-- reconciliation migration closes every gap that `prisma migrate diff
-- --from-migrations --to-schema-datamodel` flags. It is safe to run on an
-- existing database (all ALTER TYPE … ADD VALUE uses IF NOT EXISTS; FK/index
-- drops use IF EXISTS).

-- ============================================================================
-- 1. ENUM ADDITIONS
-- ============================================================================

ALTER TYPE "BookingSource" ADD VALUE IF NOT EXISTS 'TRAVIO_AFRICA';

ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS 'SUPPLIER_CUSTOMER';
ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS 'EXPEDITION_CUSTOMER';

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'expedition';

-- ============================================================================
-- 2. NEW TABLE: TravioAfricaTour
-- ============================================================================

CREATE TABLE IF NOT EXISTS "TravioAfricaTour" (
    "id"                TEXT NOT NULL,
    "tourId"            TEXT NOT NULL,
    "isActive"          BOOLEAN NOT NULL DEFAULT false,
    "bookingFlow"       "BookingFlow" NOT NULL DEFAULT 'DIRECT',
    "externalUrl"       TEXT,
    "displayOrder"      INTEGER NOT NULL DEFAULT 0,
    "isFeatured"        BOOLEAN NOT NULL DEFAULT false,
    "publishedById"     TEXT,
    "publishedAt"       TIMESTAMP(3),
    "unpublishedById"   TEXT,
    "unpublishedAt"     TIMESTAMP(3),
    "unpublishReason"   TEXT,
    "syncStatus"        TEXT,
    "lastSyncAt"        TIMESTAMP(3),
    "syncError"         TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TravioAfricaTour_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TravioAfricaTour_tourId_key"
    ON "TravioAfricaTour"("tourId");

CREATE INDEX IF NOT EXISTS "TravioAfricaTour_isActive_displayOrder_idx"
    ON "TravioAfricaTour"("isActive", "displayOrder");

CREATE INDEX IF NOT EXISTS "TravioAfricaTour_isActive_isFeatured_displayOrder_idx"
    ON "TravioAfricaTour"("isActive", "isFeatured", "displayOrder");

ALTER TABLE "TravioAfricaTour"
    ADD CONSTRAINT "TravioAfricaTour_tourId_fkey"
    FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TravioAfricaTour"
    ADD CONSTRAINT "TravioAfricaTour_publishedById_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TravioAfricaTour"
    ADD CONSTRAINT "TravioAfricaTour_unpublishedById_fkey"
    FOREIGN KEY ("unpublishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 3. AdminNotification — id default + TIMESTAMPTZ → TIMESTAMP(3) + index renames
-- ============================================================================

-- Remove the gen_random_uuid() default from id (schema uses @default(cuid()) which is client-side)
ALTER TABLE "AdminNotification" ALTER COLUMN "id" DROP DEFAULT;

-- Convert TIMESTAMPTZ columns to TIMESTAMP(3) to match Prisma's DateTime
ALTER TABLE "AdminNotification" ALTER COLUMN "acknowledgedAt" TYPE TIMESTAMP(3);
ALTER TABLE "AdminNotification" ALTER COLUMN "createdAt" TYPE TIMESTAMP(3);

-- Drop the old manually-named indexes and create Prisma-convention ones
DROP INDEX IF EXISTS "idx_admin_notification_type";
DROP INDEX IF EXISTS "idx_admin_notification_acknowledged";
DROP INDEX IF EXISTS "idx_admin_notification_created_at";

CREATE INDEX IF NOT EXISTS "AdminNotification_type_idx" ON "AdminNotification"("type");
CREATE INDEX IF NOT EXISTS "AdminNotification_acknowledged_idx" ON "AdminNotification"("acknowledged");
CREATE INDEX IF NOT EXISTS "AdminNotification_createdAt_idx" ON "AdminNotification"("createdAt");

-- ============================================================================
-- 4. Article — categoryId nullable, unique+indexes, FKs
-- ============================================================================

ALTER TABLE "Article" ALTER COLUMN "categoryId" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Article_slug_key" ON "Article"("slug");
CREATE INDEX IF NOT EXISTS "Article_slug_idx" ON "Article"("slug");
CREATE INDEX IF NOT EXISTS "Article_status_idx" ON "Article"("status");
CREATE INDEX IF NOT EXISTS "Article_publishedAt_idx" ON "Article"("publishedAt");
CREATE INDEX IF NOT EXISTS "Article_locale_idx" ON "Article"("locale");
CREATE INDEX IF NOT EXISTS "Article_authorId_idx" ON "Article"("authorId");
CREATE INDEX IF NOT EXISTS "Article_categoryId_idx" ON "Article"("categoryId");
CREATE INDEX IF NOT EXISTS "Article_status_publishedAt_idx" ON "Article"("status", "publishedAt");
CREATE INDEX IF NOT EXISTS "Article_locale_status_publishedAt_idx" ON "Article"("locale", "status", "publishedAt");

ALTER TABLE "Article"
    ADD CONSTRAINT "Article_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Article"
    ADD CONSTRAINT "Article_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "ArticleCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 5. ArticleCategory — unique+indexes, FK on parentId
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "ArticleCategory_slug_key" ON "ArticleCategory"("slug");
CREATE INDEX IF NOT EXISTS "ArticleCategory_slug_idx" ON "ArticleCategory"("slug");
CREATE INDEX IF NOT EXISTS "ArticleCategory_parentId_idx" ON "ArticleCategory"("parentId");

ALTER TABLE "ArticleCategory"
    ADD CONSTRAINT "ArticleCategory_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "ArticleCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 6. ArticleTag — unique+index
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "ArticleTag_slug_key" ON "ArticleTag"("slug");
CREATE INDEX IF NOT EXISTS "ArticleTag_slug_idx" ON "ArticleTag"("slug");

-- ============================================================================
-- 7. ArticleTagOnArticle — indexes + FKs
-- ============================================================================

CREATE INDEX IF NOT EXISTS "ArticleTagOnArticle_articleId_idx" ON "ArticleTagOnArticle"("articleId");
CREATE INDEX IF NOT EXISTS "ArticleTagOnArticle_tagId_idx" ON "ArticleTagOnArticle"("tagId");

ALTER TABLE "ArticleTagOnArticle"
    ADD CONSTRAINT "ArticleTagOnArticle_articleId_fkey"
    FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArticleTagOnArticle"
    ADD CONSTRAINT "ArticleTagOnArticle_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "ArticleTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 8. ArticleTour — indexes + FKs
-- ============================================================================

CREATE INDEX IF NOT EXISTS "ArticleTour_articleId_idx" ON "ArticleTour"("articleId");
CREATE INDEX IF NOT EXISTS "ArticleTour_tourId_idx" ON "ArticleTour"("tourId");

ALTER TABLE "ArticleTour"
    ADD CONSTRAINT "ArticleTour_articleId_fkey"
    FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArticleTour"
    ADD CONSTRAINT "ArticleTour_tourId_fkey"
    FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 9. Attraction — TIMESTAMPTZ → TIMESTAMP(3)
-- ============================================================================

ALTER TABLE "Attraction" ALTER COLUMN "lastComputedAt" TYPE TIMESTAMP(3);
ALTER TABLE "Attraction" ALTER COLUMN "createdAt" TYPE TIMESTAMP(3);
ALTER TABLE "Attraction" ALTER COLUMN "updatedAt" TYPE TIMESTAMP(3);

-- ============================================================================
-- 10. Booking — drop stale indexes, add appliedOfferId FK
-- ============================================================================

DROP INDEX IF EXISTS "Booking_customerId_createdAt_idx";
DROP INDEX IF EXISTS "idx_booking_tour_status_created";

ALTER TABLE "Booking"
    ADD CONSTRAINT "Booking_appliedOfferId_fkey"
    FOREIGN KEY ("appliedOfferId") REFERENCES "SpecialOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 11. CheckoutDraft — DATE → TIMESTAMP(3)
-- ============================================================================

ALTER TABLE "CheckoutDraft" ALTER COLUMN "selectedDate" TYPE TIMESTAMP(3);

-- ============================================================================
-- 12. Event — drop stale composite index
-- ============================================================================

DROP INDEX IF EXISTS "idx_event_name_resource_created";

-- ============================================================================
-- 13. ExpeditionTour — drop/re-add FKs with Prisma names, TIMESTAMPTZ → TIMESTAMP(3)
-- ============================================================================

-- Drop the old inline FKs (created without explicit constraint names)
ALTER TABLE "ExpeditionTour" DROP CONSTRAINT IF EXISTS "ExpeditionTour_publishedById_fkey";
ALTER TABLE "ExpeditionTour" DROP CONSTRAINT IF EXISTS "ExpeditionTour_unpublishedById_fkey";

-- Drop the old manually-named indexes
DROP INDEX IF EXISTS "ExpeditionTour_publishedById_idx";
DROP INDEX IF EXISTS "ExpeditionTour_unpublishedById_idx";

-- Convert TIMESTAMPTZ columns
ALTER TABLE "ExpeditionTour" ALTER COLUMN "publishedAt" TYPE TIMESTAMP(3);
ALTER TABLE "ExpeditionTour" ALTER COLUMN "unpublishedAt" TYPE TIMESTAMP(3);
ALTER TABLE "ExpeditionTour" ALTER COLUMN "lastSyncAt" TYPE TIMESTAMP(3);

-- Re-add FKs (matching Prisma's naming convention)
ALTER TABLE "ExpeditionTour"
    ADD CONSTRAINT "ExpeditionTour_publishedById_fkey"
    FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExpeditionTour"
    ADD CONSTRAINT "ExpeditionTour_unpublishedById_fkey"
    FOREIGN KEY ("unpublishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 14. HomepageSectionCache — TIMESTAMPTZ → TIMESTAMP(3) + index
-- ============================================================================

ALTER TABLE "HomepageSectionCache" ALTER COLUMN "computedAt" TYPE TIMESTAMP(3);
ALTER TABLE "HomepageSectionCache" ALTER COLUMN "expiresAt" TYPE TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "HomepageSectionCache_sectionKey_region_idx"
    ON "HomepageSectionCache"("sectionKey", "region");

-- ============================================================================
-- 15. Message — drop/re-add FK on senderId
-- ============================================================================

ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_senderId_fkey";

ALTER TABLE "Message"
    ADD CONSTRAINT "Message_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 16. Payout — drop/re-add FKs, add indexes
-- ============================================================================

ALTER TABLE "Payout" DROP CONSTRAINT IF EXISTS "Payout_supplierId_fkey";
ALTER TABLE "Payout" DROP CONSTRAINT IF EXISTS "Payout_bookingId_fkey";
ALTER TABLE "Payout" DROP CONSTRAINT IF EXISTS "Payout_payoutMethodId_fkey";

CREATE INDEX IF NOT EXISTS "Payout_supplierId_status_idx" ON "Payout"("supplierId", "status");
CREATE INDEX IF NOT EXISTS "Payout_supplierId_createdAt_idx" ON "Payout"("supplierId", "createdAt");

ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_payoutMethodId_fkey"
    FOREIGN KEY ("payoutMethodId") REFERENCES "PayoutMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 17. Review — drop/re-add FK (bookingId now nullable), add companions, drop stale index
-- ============================================================================

-- Drop/re-add FK (bookingId now nullable)
ALTER TABLE "Review" DROP CONSTRAINT IF EXISTS "Review_bookingId_fkey";

-- Drop the old composite index
DROP INDEX IF EXISTS "idx_review_tour_status_created";

-- Set companions default (column exists from prior partial migration but has no default)
ALTER TABLE "Review" ALTER COLUMN "companions" SET DEFAULT ARRAY[]::TEXT[];

-- Make bookingId nullable
ALTER TABLE "Review" ALTER COLUMN "bookingId" DROP NOT NULL;

-- Re-add FK (nullable)
ALTER TABLE "Review"
    ADD CONSTRAINT "Review_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 18. SpecialOffer — default + nullable changes
-- ============================================================================

ALTER TABLE "SpecialOffer" ALTER COLUMN "discountPercentage" SET DEFAULT 10;
ALTER TABLE "SpecialOffer" ALTER COLUMN "startDate" DROP NOT NULL;
ALTER TABLE "SpecialOffer" ALTER COLUMN "endDate" DROP NOT NULL;

-- ============================================================================
-- 19. Tour — drop stale indexes, TIMESTAMPTZ → TIMESTAMP(3)
-- ============================================================================

DROP INDEX IF EXISTS "Tour_attractions_idx";
DROP INDEX IF EXISTS "Tour_list_covering_idx";
DROP INDEX IF EXISTS "Tour_supplierId_status_createdAt_idx";
DROP INDEX IF EXISTS "tour_location_geom_idx";

ALTER TABLE "Tour" ALTER COLUMN "aiScoredAt" TYPE TIMESTAMP(3);

-- ============================================================================
-- 20. TourImageAnalysis — TIMESTAMPTZ → TIMESTAMP(3)
-- ============================================================================

ALTER TABLE "TourImageAnalysis" ALTER COLUMN "aiProcessedAt" TYPE TIMESTAMP(3);
ALTER TABLE "TourImageAnalysis" ALTER COLUMN "createdAt" TYPE TIMESTAMP(3);
ALTER TABLE "TourImageAnalysis" ALTER COLUMN "updatedAt" TYPE TIMESTAMP(3);

-- ============================================================================
-- 21. VerificationEvent — remove default on entityType
-- ============================================================================

ALTER TABLE "VerificationEvent" ALTER COLUMN "entityType" DROP DEFAULT;

-- ============================================================================
-- 22. WishlistItem — drop stale composite index
-- ============================================================================

-- The schema has @@index([userId, addedAt]) and @@index([tourId]) which already
-- exist. The old migration created a (tourId, addedAt) index that is no longer
-- in the schema.
DROP INDEX IF EXISTS "idx_wishlist_tour_added";
