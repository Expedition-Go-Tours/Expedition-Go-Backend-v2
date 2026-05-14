-- Add GIN index for full-text search on Tour title and description
-- Supports fast ts_rank() queries with plainto_tsquery
CREATE INDEX IF NOT EXISTS idx_tour_fts ON "Tour" USING GIN (
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
);
