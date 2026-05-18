-- Add normalized location columns for indexed filtering
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "city"              TEXT;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "country"           TEXT;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "region"            TEXT;

-- Add normalized categorization columns for indexed filtering
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "category"          TEXT;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "subcategory"       TEXT;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "activityType"      TEXT;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "difficulty"        TEXT;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "durationMinutes"   INTEGER;

-- Add normalized theme column
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "primaryTheme"      TEXT;

-- Indexes (IF NOT EXISTS for idempotency)
CREATE INDEX IF NOT EXISTS "Tour_city_idx"              ON "Tour" ("city");
CREATE INDEX IF NOT EXISTS "Tour_country_idx"           ON "Tour" ("country");
CREATE INDEX IF NOT EXISTS "Tour_region_idx"            ON "Tour" ("region");
CREATE INDEX IF NOT EXISTS "Tour_country_city_idx"      ON "Tour" ("country", "city");
CREATE INDEX IF NOT EXISTS "Tour_category_idx"          ON "Tour" ("category");
CREATE INDEX IF NOT EXISTS "Tour_subcategory_idx"       ON "Tour" ("subcategory");
CREATE INDEX IF NOT EXISTS "Tour_activityType_idx"      ON "Tour" ("activityType");
CREATE INDEX IF NOT EXISTS "Tour_difficulty_idx"        ON "Tour" ("difficulty");
CREATE INDEX IF NOT EXISTS "Tour_primaryTheme_idx"      ON "Tour" ("primaryTheme");
CREATE INDEX IF NOT EXISTS "Tour_durationMinutes_idx"   ON "Tour" ("durationMinutes");
