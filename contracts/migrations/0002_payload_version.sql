-- Migration 0002: Add payload_version to ucsa_query_cache
-- Enables on-read entity upcasting and lazy schema transitions.

ALTER TABLE ucsa_query_cache ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_ucsa_cache_payload_version ON ucsa_query_cache(payload_version);
