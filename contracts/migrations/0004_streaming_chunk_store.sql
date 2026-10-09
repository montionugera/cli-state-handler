-- Migration 0004: Streaming chunk store and resume tokens
-- Enables chunked append, sequence integrity, coalescing, and resumable LLM/media streams.

CREATE TABLE IF NOT EXISTS ucsa_streams (
  query_hash          TEXT PRIMARY KEY,
  query_key           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('open','complete','aborted','error')),
  encoding            TEXT NOT NULL CHECK (encoding IN ('utf8','bytes')),
  next_seq            INTEGER NOT NULL DEFAULT 0,
  byte_length         INTEGER NOT NULL DEFAULT 0,
  resume_kind         TEXT CHECK (resume_kind IN ('range','last-event-id','continuation','restart')),
  resume_token        TEXT,
  etag                TEXT,
  writer_id           TEXT,
  writer_lease_until  INTEGER,
  payload_version     INTEGER NOT NULL DEFAULT 1,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_streams_status ON ucsa_streams(status, expires_at);

CREATE TABLE IF NOT EXISTS ucsa_stream_chunks (
  query_hash          TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  byte_offset         INTEGER NOT NULL,
  data                BLOB    NOT NULL,
  PRIMARY KEY (query_hash, seq),
  FOREIGN KEY (query_hash) REFERENCES ucsa_streams(query_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucsa_stream_chunks_hash ON ucsa_stream_chunks(query_hash);

CREATE TABLE IF NOT EXISTS ucsa_stream_tags (
  tag                 TEXT NOT NULL,
  query_hash          TEXT NOT NULL,
  PRIMARY KEY (tag, query_hash),
  FOREIGN KEY (query_hash) REFERENCES ucsa_streams(query_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucsa_stream_tags_tag ON ucsa_stream_tags(tag);
