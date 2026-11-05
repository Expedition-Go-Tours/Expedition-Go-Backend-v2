-- Supplier refund request decisions.
--
-- The decision email already existed, but the supplier's in-app bell had no
-- row for it: an approval or a decline changed the booking and the ledger and
-- left the bell silent. Three values, one per outcome:
--
--   SUPPLIER_REFUND_APPROVED  refund executed, supplier charged
--   SUPPLIER_REFUND_REJECTED  admin declined, no money moved
--   SUPPLIER_REFUND_FAILED    provider refund failed asynchronously after
--                             approval; the charge was reversed
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPLIER_REFUND_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPLIER_REFUND_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPLIER_REFUND_FAILED';
