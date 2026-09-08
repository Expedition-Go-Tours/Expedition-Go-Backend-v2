-- Multi-option tours: bookings and seat-holds record which sellable option
-- they belong to. NULL = the tour's default/first option, keeping every legacy
-- booking option-agnostic (capacity for the default option includes NULL rows).

ALTER TABLE "Booking"
  ADD COLUMN IF NOT EXISTS "optionId" TEXT,
  ADD COLUMN IF NOT EXISTS "optionTitle" TEXT;

ALTER TABLE "CheckoutDraft"
  ADD COLUMN IF NOT EXISTS "optionId" TEXT;

CREATE INDEX IF NOT EXISTS "Booking_optionId_idx" ON "Booking"("optionId");
CREATE INDEX IF NOT EXISTS "CheckoutDraft_optionId_idx" ON "CheckoutDraft"("optionId");
