-- GA4 Measurement Protocol delivery ledger.
--
-- One timestamp per booking, written only after Google accepted the purchase
-- event (HTTP 2xx). Null means "never confirmed delivered": the state that
-- produced a week of silently discarded revenue, because the Measurement
-- Protocol answers 204 to an unusable API secret and the only other evidence
-- lived in pm2 logs that rotate away.
ALTER TABLE "Booking" ADD COLUMN "ga4ReportedAt" TIMESTAMP(3);
