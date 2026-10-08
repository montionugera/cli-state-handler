-- Migration 0003: Change log, bus hub election, and outbox distributed leases
-- Enables cross-process real-time event broadcasting and concurrent outbox replay protection.

CREATE TABLE IF NOT EXISTS ucsa_change_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  origin       TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('invalidate','mutation','stream','reset')),
  tags         TEXT,
  query_hashes TEXT,
  detail       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_change_log_created ON ucsa_change_log(created_at);

CREATE TABLE IF NOT EXISTS ucsa_bus_hub (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  epoch        INTEGER NOT NULL,
  pid          INTEGER NOT NULL,
  endpoint     TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  claimed_at   INTEGER NOT NULL
);

ALTER TABLE ucsa_mutation_outbox ADD COLUMN lease_owner TEXT;
ALTER TABLE ucsa_mutation_outbox ADD COLUMN lease_until INTEGER;
