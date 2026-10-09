import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MigrationRunner,
  MigrationError,
  CANONICAL_MIGRATIONS,
  TARGET_SCHEMA_VERSION,
  STREAMING_CHUNK_STORE_SQL,
} from '../../src/storage/migration-runner.js';

describe('Schema Migration v4 (ucsa_streams, ucsa_stream_chunks, ucsa_stream_tags)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-migration-v4-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fresh database migration to v4 creates all 3 stream tables and indices', () => {
    const dbPath = path.join(tmpDir, 'fresh_v4.db');
    const db = new Database(dbPath);

    expect(MigrationRunner.getUserVersion(db)).toBe(0);

    const result = MigrationRunner.migrate(db, 4);
    expect(result.currentVersion).toBe(4);
    expect(result.appliedCount).toBe(4);
    expect(MigrationRunner.getUserVersion(db)).toBe(4);

    // Verify ucsa_migrations ledger has all 4 migrations
    const migrations = MigrationRunner.getAppliedMigrations(db);
    expect(migrations.size).toBe(4);

    const m4 = migrations.get(4);
    expect(m4).toBeDefined();
    expect(m4?.name).toBe('streaming_chunk_store');
    expect(m4?.checksum).toBe(CANONICAL_MIGRATIONS[3].sha256);

    // Verify all stream tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain('ucsa_streams');
    expect(tables).toContain('ucsa_stream_chunks');
    expect(tables).toContain('ucsa_stream_tags');

    // Verify stream indices exist
    const indices = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: any) => r.name);

    expect(indices).toContain('idx_ucsa_streams_status');
    expect(indices).toContain('idx_ucsa_stream_chunks_hash');
    expect(indices).toContain('idx_ucsa_stream_tags_tag');

    // Verify ucsa_streams columns
    const streamsColumns = db
      .prepare('PRAGMA table_info(ucsa_streams)')
      .all()
      .map((c: any) => c.name);
    expect(streamsColumns).toEqual([
      'query_hash',
      'query_key',
      'status',
      'encoding',
      'next_seq',
      'byte_length',
      'resume_kind',
      'resume_token',
      'etag',
      'writer_id',
      'writer_lease_until',
      'payload_version',
      'error',
      'created_at',
      'updated_at',
      'expires_at',
    ]);

    // Verify ucsa_stream_chunks columns
    const chunksColumns = db
      .prepare('PRAGMA table_info(ucsa_stream_chunks)')
      .all()
      .map((c: any) => c.name);
    expect(chunksColumns).toEqual(['query_hash', 'seq', 'byte_offset', 'data']);

    // Verify ucsa_stream_tags columns
    const tagsColumns = db
      .prepare('PRAGMA table_info(ucsa_stream_tags)')
      .all()
      .map((c: any) => c.name);
    expect(tagsColumns).toEqual(['tag', 'query_hash']);

    db.close();
  });

  it('migration from v3 to v4 preserves existing data and adds new stream tables', () => {
    const dbPath = path.join(tmpDir, 'v3_to_v4.db');
    const db = new Database(dbPath);

    // Step 1: Migrate up to v3
    const v3Result = MigrationRunner.migrate(db, 3);
    expect(v3Result.currentVersion).toBe(3);
    expect(v3Result.appliedCount).toBe(3);
    expect(MigrationRunner.getUserVersion(db)).toBe(3);

    // Populate pre-existing data across v1-v3 tables
    db.prepare(`
      INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('cache-v3', '["test"]', JSON.stringify({ ok: true }), 'etag-v3', 1000, 2000, 3000, 1);

    db.prepare(`
      INSERT INTO ucsa_cache_tags (tag, query_hash) VALUES (?, ?)
    `).run('tag:v3', 'cache-v3');

    db.prepare(`
      INSERT INTO ucsa_mutation_outbox (mutation_id, endpoint, method, headers, payload, status, retry_count, created_at, lease_owner, lease_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mut-v3', '/api/test', 'POST', null, '{"action":"save"}', 'pending', 0, 1000, 'worker-1', 2000);

    db.prepare(`
      INSERT INTO ucsa_change_log (origin, kind, tags, query_hashes, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('origin-1', 'mutation', '["tag:v3"]', '["cache-v3"]', '{"id":"mut-v3"}', 1000);

    db.prepare(`
      INSERT INTO ucsa_bus_hub (id, epoch, pid, endpoint, token, claimed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, 1, 100, 'ipc:///tmp/hub.sock', 'token-1', 1000);

    // Step 2: Migrate to v4
    const v4Result = MigrationRunner.migrate(db, 4);
    expect(v4Result.currentVersion).toBe(4);
    expect(v4Result.appliedCount).toBe(1);
    expect(MigrationRunner.getUserVersion(db)).toBe(4);

    // Verify pre-existing data is preserved 100%
    const cacheRow = db
      .prepare('SELECT query_hash, data_payload, payload_version FROM ucsa_query_cache WHERE query_hash = ?')
      .get('cache-v3') as any;
    expect(cacheRow).toBeDefined();
    expect(JSON.parse(cacheRow.data_payload)).toEqual({ ok: true });
    expect(cacheRow.payload_version).toBe(1);

    const tagRow = db
      .prepare('SELECT tag, query_hash FROM ucsa_cache_tags WHERE query_hash = ?')
      .get('cache-v3') as any;
    expect(tagRow).toBeDefined();
    expect(tagRow.tag).toBe('tag:v3');

    const outboxRow = db
      .prepare('SELECT mutation_id, lease_owner, lease_until FROM ucsa_mutation_outbox WHERE mutation_id = ?')
      .get('mut-v3') as any;
    expect(outboxRow).toBeDefined();
    expect(outboxRow.lease_owner).toBe('worker-1');
    expect(outboxRow.lease_until).toBe(2000);

    const changeLogRow = db
      .prepare('SELECT kind, origin FROM ucsa_change_log WHERE origin = ?')
      .get('origin-1') as any;
    expect(changeLogRow).toBeDefined();
    expect(changeLogRow.kind).toBe('mutation');

    const busHubRow = db
      .prepare('SELECT endpoint, token FROM ucsa_bus_hub WHERE id = 1')
      .get() as any;
    expect(busHubRow).toBeDefined();
    expect(busHubRow.endpoint).toBe('ipc:///tmp/hub.sock');

    // Verify newly added stream tables can receive inserts
    db.prepare(`
      INSERT INTO ucsa_streams (query_hash, query_key, status, encoding, next_seq, byte_length, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('stream-1', '["stream",1]', 'open', 'utf8', 0, 0, 1000, 1000, 5000);

    const streamRow = db
      .prepare('SELECT query_hash, status, encoding FROM ucsa_streams WHERE query_hash = ?')
      .get('stream-1') as any;
    expect(streamRow).toBeDefined();
    expect(streamRow.status).toBe('open');
    expect(streamRow.encoding).toBe('utf8');

    db.close();
  });

  it('enforces CHECK constraints on status, encoding, and resume_kind', () => {
    const dbPath = path.join(tmpDir, 'stream_checks.db');
    const db = new Database(dbPath);

    MigrationRunner.migrate(db, 4);

    const insertStreamStmt = db.prepare(`
      INSERT INTO ucsa_streams (
        query_hash, query_key, status, encoding, next_seq, byte_length,
        resume_kind, resume_token, etag, writer_id, writer_lease_until,
        payload_version, error, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Valid statuses: 'open', 'complete', 'aborted', 'error'
    for (const validStatus of ['open', 'complete', 'aborted', 'error']) {
      expect(() => {
        insertStreamStmt.run(
          `hash-status-${validStatus}`,
          '["status-check"]',
          validStatus,
          'utf8',
          0,
          0,
          null,
          null,
          null,
          null,
          null,
          1,
          null,
          1000,
          1000,
          5000
        );
      }).not.toThrow();
    }

    // Invalid status values fail CHECK constraint
    for (const invalidStatus of ['closed', 'pending', 'active', 'failed', '']) {
      expect(() => {
        insertStreamStmt.run(
          `hash-invalid-${invalidStatus}`,
          '["status-check"]',
          invalidStatus,
          'utf8',
          0,
          0,
          null,
          null,
          null,
          null,
          null,
          1,
          null,
          1000,
          1000,
          5000
        );
      }).toThrow(/CHECK constraint failed/i);
    }

    // Valid encodings: 'utf8', 'bytes'
    for (const validEncoding of ['utf8', 'bytes']) {
      expect(() => {
        insertStreamStmt.run(
          `hash-enc-${validEncoding}`,
          '["enc-check"]',
          'open',
          validEncoding,
          0,
          0,
          null,
          null,
          null,
          null,
          null,
          1,
          null,
          1000,
          1000,
          5000
        );
      }).not.toThrow();
    }

    // Invalid encoding values fail CHECK constraint
    for (const invalidEncoding of ['ascii', 'binary', 'base64', 'hex', '']) {
      expect(() => {
        insertStreamStmt.run(
          `hash-enc-invalid-${invalidEncoding}`,
          '["enc-check"]',
          'open',
          invalidEncoding,
          0,
          0,
          null,
          null,
          null,
          null,
          null,
          1,
          null,
          1000,
          1000,
          5000
        );
      }).toThrow(/CHECK constraint failed/i);
    }

    // Valid resume_kinds: null, 'range', 'last-event-id', 'continuation', 'restart'
    for (const validResume of ['range', 'last-event-id', 'continuation', 'restart']) {
      expect(() => {
        insertStreamStmt.run(
          `hash-resume-${validResume}`,
          '["resume-check"]',
          'open',
          'utf8',
          0,
          0,
          validResume,
          'token-xyz',
          null,
          null,
          null,
          1,
          null,
          1000,
          1000,
          5000
        );
      }).not.toThrow();
    }

    // Invalid resume_kind values fail CHECK constraint
    for (const invalidResume of ['token', 'offset', 'cursor', 'seq', '']) {
      expect(() => {
        insertStreamStmt.run(
          `hash-resume-invalid-${invalidResume}`,
          '["resume-check"]',
          'open',
          'utf8',
          0,
          0,
          invalidResume,
          'token-xyz',
          null,
          null,
          null,
          1,
          null,
          1000,
          1000,
          5000
        );
      }).toThrow(/CHECK constraint failed/i);
    }

    db.close();
  });

  it('foreign key cascade: deleting a stream row purges its chunks and stream tags', () => {
    const dbPath = path.join(tmpDir, 'cascade.db');
    const db = new Database(dbPath);

    MigrationRunner.migrate(db, 4);

    // Foreign keys must be enabled in SQLite connection for cascade to trigger
    db.pragma('foreign_keys = ON');

    // Insert stream
    db.prepare(`
      INSERT INTO ucsa_streams (query_hash, query_key, status, encoding, next_seq, byte_length, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('stream-cascade-1', '["chat",1]', 'open', 'utf8', 2, 20, 1000, 1000, 5000);

    // Insert chunks
    const insertChunk = db.prepare(`
      INSERT INTO ucsa_stream_chunks (query_hash, seq, byte_offset, data)
      VALUES (?, ?, ?, ?)
    `);
    insertChunk.run('stream-cascade-1', 0, 0, Buffer.from('Hello '));
    insertChunk.run('stream-cascade-1', 1, 6, Buffer.from('World!'));

    // Insert tags
    const insertTag = db.prepare(`
      INSERT INTO ucsa_stream_tags (tag, query_hash)
      VALUES (?, ?)
    `);
    insertTag.run('tag:chat', 'stream-cascade-1');
    insertTag.run('tag:user-42', 'stream-cascade-1');

    // Confirm existence
    const initialChunks = db
      .prepare('SELECT seq FROM ucsa_stream_chunks WHERE query_hash = ?')
      .all('stream-cascade-1');
    expect(initialChunks).toHaveLength(2);

    const initialTags = db
      .prepare('SELECT tag FROM ucsa_stream_tags WHERE query_hash = ?')
      .all('stream-cascade-1');
    expect(initialTags).toHaveLength(2);

    // Delete stream row
    db.prepare('DELETE FROM ucsa_streams WHERE query_hash = ?').run('stream-cascade-1');

    // Assert chunks and tags were cascaded
    const remainingChunks = db
      .prepare('SELECT seq FROM ucsa_stream_chunks WHERE query_hash = ?')
      .all('stream-cascade-1');
    expect(remainingChunks).toHaveLength(0);

    const remainingTags = db
      .prepare('SELECT tag FROM ucsa_stream_tags WHERE query_hash = ?')
      .all('stream-cascade-1');
    expect(remainingTags).toHaveLength(0);

    db.close();
  });

  it('verifies transaction rollback on migration failure', () => {
    const dbPath = path.join(tmpDir, 'rollback_v4.db');
    const db = new Database(dbPath);

    // Apply migrations up to v3
    MigrationRunner.migrate(db, 3);
    expect(MigrationRunner.getUserVersion(db)).toBe(3);

    const failingMigrations = [
      CANONICAL_MIGRATIONS[0],
      CANONICAL_MIGRATIONS[1],
      CANONICAL_MIGRATIONS[2],
      {
        version: 4,
        name: 'failing_streaming_chunk_store',
        sql: `
          CREATE TABLE ucsa_streams (
            query_hash TEXT PRIMARY KEY
          );
          TRIGGER IMMEDIATE SYNTAX ERROR ON PURPOSE;
        `,
      },
    ];

    expect(() => {
      MigrationRunner.migrate(db, 4, failingMigrations);
    }).toThrow(MigrationError);

    // Assert user_version rolled back and remained 3
    expect(MigrationRunner.getUserVersion(db)).toBe(3);

    // Assert stream tables do NOT exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).not.toContain('ucsa_streams');
    expect(tables).not.toContain('ucsa_stream_chunks');
    expect(tables).not.toContain('ucsa_stream_tags');

    // Assert ucsa_migrations ledger does not record version 4
    const applied = MigrationRunner.getAppliedMigrations(db);
    expect(applied.size).toBe(3);
    expect(applied.has(4)).toBe(false);

    db.close();
  });
});
