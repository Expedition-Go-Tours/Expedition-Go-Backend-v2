-- Sprint 1 storefront conversion work.
--
-- Everything here is additive except relaxing CheckoutDraft.customerId to
-- nullable, which is required for guest checkout. No column is dropped or
-- renamed, so a rollback only needs the new columns/tables removed.

-- ── Abandoned checkout recovery + guest checkout ───────────────────────────
ALTER TABLE "CheckoutDraft" ALTER COLUMN "customerId" DROP NOT NULL;
ALTER TABLE "CheckoutDraft" ADD COLUMN "guestName" TEXT;
ALTER TABLE "CheckoutDraft" ADD COLUMN "guestEmail" TEXT;
ALTER TABLE "CheckoutDraft" ADD COLUMN "guestPhone" TEXT;
ALTER TABLE "CheckoutDraft" ADD COLUMN "abandonedNotifiedAt" TIMESTAMP(3);

CREATE INDEX "CheckoutDraft_guestEmail_idx" ON "CheckoutDraft"("guestEmail");
CREATE INDEX "CheckoutDraft_abandonedNotifiedAt_idx" ON "CheckoutDraft"("abandonedNotifiedAt");

-- ── Wishlist price alerts ──────────────────────────────────────────────────
ALTER TABLE "WishlistItem" ADD COLUMN "priceAtSave" DECIMAL(10,2);
ALTER TABLE "WishlistItem" ADD COLUMN "currency" TEXT;
ALTER TABLE "WishlistItem" ADD COLUMN "lastPriceAlertAt" TIMESTAMP(3);

CREATE INDEX "WishlistItem_lastPriceAlertAt_idx" ON "WishlistItem"("lastPriceAlertAt");

-- ── Shareable wishlists ────────────────────────────────────────────────────
CREATE TABLE "WishlistShare" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "WishlistShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WishlistShare_token_key" ON "WishlistShare"("token");
CREATE INDEX "WishlistShare_userId_revokedAt_idx" ON "WishlistShare"("userId", "revokedAt");

ALTER TABLE "WishlistShare" ADD CONSTRAINT "WishlistShare_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Sold-out waitlist ──────────────────────────────────────────────────────
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "selectedDate" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaitlistEntry_tourId_selectedDate_email_key"
    ON "WaitlistEntry"("tourId", "selectedDate", "email");
CREATE INDEX "WaitlistEntry_tourId_selectedDate_notifiedAt_idx"
    ON "WaitlistEntry"("tourId", "selectedDate", "notifiedAt");
CREATE INDEX "WaitlistEntry_userId_idx" ON "WaitlistEntry"("userId");

ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_tourId_fkey"
    FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Notification types for the two new lifecycle emails ────────────────────
ALTER TYPE "NotificationType" ADD VALUE 'PRICE_DROP';
ALTER TYPE "NotificationType" ADD VALUE 'WAITLIST_OPEN';

-- ── Guest checkout access (bearer token → draft/booking) ───────────────────
CREATE TABLE "GuestAccess" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "draftId" TEXT,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestAccess_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuestAccess_tokenHash_key" ON "GuestAccess"("tokenHash");
CREATE INDEX "GuestAccess_draftId_idx" ON "GuestAccess"("draftId");
CREATE INDEX "GuestAccess_bookingId_idx" ON "GuestAccess"("bookingId");
CREATE INDEX "GuestAccess_expiresAt_idx" ON "GuestAccess"("expiresAt");
