-- The 30-day documentation window: once a supplier's required documents are
-- uploaded (government ID + business certificate for businesses) the account is
-- ACTIVE and they have 30 days to provide the rest. Set when the window starts.
ALTER TABLE "SupplierProfile" ADD COLUMN "documentationDeadline" TIMESTAMP(3);