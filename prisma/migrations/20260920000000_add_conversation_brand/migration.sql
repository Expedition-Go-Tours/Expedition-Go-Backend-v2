-- Per-platform chat isolation: tag every Conversation with the brand whose
-- admin inbox should see it. Values are the brand registry KEYS
-- ('ghana' | 'africa'), not the UserRole names ('ghana' | 'travioafrica').
--
-- Expedition conversations belong to Ghana (Expedition is Ghana's sub-store),
-- so they are stamped 'ghana' too. The column is nullable so the migration is
-- safe on a live database; the backfill below fills every existing row.

ALTER TABLE "Conversation" ADD COLUMN "brand" TEXT;

CREATE INDEX "Conversation_brand_idx" ON "Conversation"("brand");

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill (each statement only touches rows the previous ones left NULL)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Expedition conversations are always Ghana's.
UPDATE "Conversation" SET "brand" = 'ghana'
WHERE "brand" IS NULL AND "type" = 'EXPEDITION_CUSTOMER';

-- 2. Supplier conversations: brand from the supplier participant's brand role.
UPDATE "Conversation" c SET "brand" = 'ghana'
WHERE c."brand" IS NULL
  AND c."type" IN ('SUPPLIER_ADMIN', 'SUPPLIER_CUSTOMER')
  AND EXISTS (
    SELECT 1 FROM "ConversationParticipant" cp
    JOIN "User" u ON u."id" = cp."userId"
    WHERE cp."conversationId" = c."id" AND 'ghana'::"UserRole" = ANY(u."roles")
  );

UPDATE "Conversation" c SET "brand" = 'africa'
WHERE c."brand" IS NULL
  AND c."type" IN ('SUPPLIER_ADMIN', 'SUPPLIER_CUSTOMER')
  AND EXISTS (
    SELECT 1 FROM "ConversationParticipant" cp
    JOIN "User" u ON u."id" = cp."userId"
    WHERE cp."conversationId" = c."id" AND 'travioafrica'::"UserRole" = ANY(u."roles")
  );

-- 3. Any conversation with a brand-role participant (covers USER_SUPPORT where
--    the customer also runs a supplier profile on one platform).
UPDATE "Conversation" c SET "brand" = 'ghana'
WHERE c."brand" IS NULL
  AND EXISTS (
    SELECT 1 FROM "ConversationParticipant" cp
    JOIN "User" u ON u."id" = cp."userId"
    WHERE cp."conversationId" = c."id" AND 'ghana'::"UserRole" = ANY(u."roles")
  );

UPDATE "Conversation" c SET "brand" = 'africa'
WHERE c."brand" IS NULL
  AND EXISTS (
    SELECT 1 FROM "ConversationParticipant" cp
    JOIN "User" u ON u."id" = cp."userId"
    WHERE cp."conversationId" = c."id" AND 'travioafrica'::"UserRole" = ANY(u."roles")
  );

-- 4. User-support conversations: brand from the customer's bookings' supplier.
UPDATE "Conversation" c SET "brand" = 'ghana'
WHERE c."brand" IS NULL
  AND c."type" = 'USER_SUPPORT'
  AND EXISTS (
    SELECT 1 FROM "ConversationParticipant" cp
    JOIN "Booking" b ON b."customerId" = cp."userId"
    JOIN "Tour" t ON t."id" = b."tourId"
    JOIN "User" s ON s."id" = t."supplierId"
    WHERE cp."conversationId" = c."id" AND 'ghana'::"UserRole" = ANY(s."roles")
  );

UPDATE "Conversation" c SET "brand" = 'africa'
WHERE c."brand" IS NULL
  AND c."type" = 'USER_SUPPORT'
  AND EXISTS (
    SELECT 1 FROM "ConversationParticipant" cp
    JOIN "Booking" b ON b."customerId" = cp."userId"
    JOIN "Tour" t ON t."id" = b."tourId"
    JOIN "User" s ON s."id" = t."supplierId"
    WHERE cp."conversationId" = c."id" AND 'travioafrica'::"UserRole" = ANY(s."roles")
  );

-- 5. Safety net: any remaining legacy row is assigned to Ghana (the platform
--    home and owner of the Expedition sub-store) so no conversation is
--    orphaned. Review these rows after deploy if the count is non-zero.
UPDATE "Conversation" SET "brand" = 'ghana' WHERE "brand" IS NULL;
