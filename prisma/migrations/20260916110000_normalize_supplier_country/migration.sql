-- Normalise legacy supplier country values to ISO 3166-1 alpha-2.
--
-- businessInfo.country is meant to hold a two-letter code — supplierHelpers
-- rejects anything else on write — but records created before that validation
-- exist with full country names instead.
--
-- Those values broke the Ghana / non-Ghana routing in autoPublishGhana and
-- autoPublishTravioAfrica, which compared against a literal: a row storing
-- "Ghana" failed a `=== 'GH'` test, and a row storing "GH" failed a
-- `=== 'Ghana'` test. Either way the supplier was routed to the wrong
-- storefront, or to none at all.
--
-- The comparison now goes through utils/supplierCountry, which accepts both
-- forms, so this backfill is about making the stored data match what the
-- validation expects rather than about fixing behaviour. It only rewrites
-- values it recognises — anything else is left untouched rather than guessed at.
UPDATE "SupplierProfile"
SET "businessInfo" = jsonb_set("businessInfo", '{country}', to_jsonb('GH'::text))
WHERE lower("businessInfo"->>'country') IN ('ghana', 'gha');

UPDATE "SupplierProfile"
SET "businessInfo" = jsonb_set("businessInfo", '{country}', to_jsonb('NG'::text))
WHERE lower("businessInfo"->>'country') = 'nigeria';
