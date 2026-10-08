-- Migration 0001: Baseline Canonical Schema for UCSA
-- Reconciles TypeScript, Dart, and C# schemas into a single source of truth.

CREATE TABLE IF NOT EXISTS ucsa_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ucsa_query_cache (
  query_hash TEXT PRIMARY KEY,
  query_key TEXT NOT NULL,
  data_payload TEXT NOT NULL,
  etag TEXT,
  created_at INTEGER NOT NULL,
  stale_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_cache_expires ON ucsa_query_cache(expires_at);

CREATE TABLE IF NOT EXISTS ucsa_cache_tags (
  tag TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  PRIMARY KEY (tag, query_hash),
  FOREIGN KEY (query_hash) REFERENCES ucsa_query_cache(query_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucsa_tags_hash ON ucsa_cache_tags(query_hash);
CREATE INDEX IF NOT EXISTS idx_ucsa_tags_tag ON ucsa_cache_tags(tag);

CREATE TABLE IF NOT EXISTS ucsa_mutation_outbox (
  mutation_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  headers TEXT,
  payload TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  error TEXT,
  forced INTEGER DEFAULT 0,
  conflict_policy TEXT DEFAULT 'server-wins'
);
CREATE INDEX IF NOT EXISTS idx_ucsa_outbox_status ON ucsa_mutation_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS ucsa_cas_objects (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_cas_access ON ucsa_cas_objects(last_accessed_at);
