-- Add latitude/longitude columns to Tour
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;

-- Enable PostGIS (requires superuser — run manually if this fails)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add geography column for spatial queries
ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS location_geom geography(Point, 4326);

-- Auto-maintain geography point from lat/lng
CREATE OR REPLACE FUNCTION update_tour_location() RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location_geom = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  ELSE
    NEW.location_geom = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tour_location ON "Tour";
CREATE TRIGGER trg_tour_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON "Tour"
  FOR EACH ROW EXECUTE FUNCTION update_tour_location();

-- Spatial index for fast ST_DWithin queries
CREATE INDEX IF NOT EXISTS tour_location_geom_idx ON "Tour" USING GIST (location_geom);
