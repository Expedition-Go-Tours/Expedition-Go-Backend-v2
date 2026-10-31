-- GA4 refund delivery ledger.
--
-- `ga4ReportedAt` answers "did the revenue event reach GA?"; this answers the
-- reverse: "did the money coming back?". Without it, a dropped refund event is
-- invisible — the purchase is confirmed, the booking looks reported, and GA
-- keeps counting revenue that was returned to the customer.
--
-- `ga4RefundReportedAmount` accumulates across partial refunds so the check is
-- `refundAmount > ga4RefundReportedAmount`, not just "a timestamp exists".
ALTER TABLE "Booking" ADD COLUMN "ga4RefundReportedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "ga4RefundReportedAmount" DECIMAL(10,2);
