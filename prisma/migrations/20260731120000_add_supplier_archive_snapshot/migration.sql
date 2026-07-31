-- Archive/Restore snapshot for the supplier soft-delete lifecycle.
-- Stores { archivedAt, tourIds } so restore can reactivate exactly the tours
-- that the archive action hid.
ALTER TABLE "SupplierProfile"
  ADD COLUMN "archiveSnapshot" JSONB;
