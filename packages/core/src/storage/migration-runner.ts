import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export class DatabaseVersionTooNewError extends Error {
  constructor(public readonly currentVersion: number, public readonly supportedVersion: number) {
    super(
      `Database schema version ${currentVersion} is newer than supported version ${supportedVersion}. ` +
      `Please upgrade the UCSA client to access this database.`
    );
    this.name = 'DatabaseVersionTooNewError';
  }
}

export class MigrationChecksumMismatchError extends Error {
  constructor(
    public readonly version: number,
    public readonly expectedChecksum: string,
    public readonly actualChecksum: string
  ) {
    super(
      `Checksum mismatch for migration version ${version}: expected ${expectedChecksum}, found ${actualChecksum}. ` +
      `The migration history has been tampered with or corrupted.`
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export class MigrationError extends Error {
  constructor(public readonly version: number, cause: unknown) {
    super(`Failed to apply migration version ${version}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
    this.cause = cause;
  }
}

export interface MigrationDefinition {
  version: number;
  name: string;
  sql: string;
  sha256?: string;
}

export interface AppliedMigrationRecord {
  version: number;
  name: string;
  applied_at: number;
  checksum: string;
}

export const BASELINE_SQL = `-- Migration 0001: Baseline Canonical Schema for UCSA
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
`;

export const PAYLOAD_VERSION_SQL = `-- Migration 0002: Add payload_version to ucsa_query_cache
-- Enables on-read entity upcasting and lazy schema transitions.

ALTER TABLE ucsa_query_cache ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_ucsa_cache_payload_version ON ucsa_query_cache(payload_version);
`;

export const CHANGE_LOG_AND_BUS_SQL = `-- Migration 0003: Change log, bus hub election, and outbox distributed leases
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
`;

export const CANONICAL_MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: 'baseline',
    sql: BASELINE_SQL,
    sha256: 'fff0ce5e68c0644c5f61b60a05d9f50f6992392ad671abd06685da5a8c34f55c',
  },
  {
    version: 2,
    name: 'payload_version',
    sql: PAYLOAD_VERSION_SQL,
    sha256: 'ab2fb5ac83e34e2b7a13de446cb3cf37778dafddbce0c3c65b22906015712dc1',
  },
  {
    version: 3,
    name: 'change_log_and_bus',
    sql: CHANGE_LOG_AND_BUS_SQL,
    sha256: 'a79e1963523548208d42a61d3be4a08086c4866c71eb1045182eed4ac0a78c05',
  },
];

export const TARGET_SCHEMA_VERSION = 3;

export function computeSqlChecksum(sql: string): string {
  return createHash('sha256').update(sql.trim()).digest('hex');
}

export class MigrationRunner {
  /**
   * Returns current user_version from SQLite PRAGMA.
   */
  static getUserVersion(db: Database.Database): number {
    const row = db.pragma('user_version', { simple: true });
    return Number(row ?? 0);
  }

  /**
   * Updates user_version PRAGMA.
   */
  static setUserVersion(db: Database.Database, version: number): void {
    db.pragma(`user_version = ${Math.floor(version)}`);
  }

  /**
   * Initializes the ucsa_migrations ledger table if absent.
   */
  static initMigrationsTable(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ucsa_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
    `);
  }

  /**
   * Retrieves all applied migration records ordered by version ASC.
   */
  static getAppliedMigrations(db: Database.Database): Map<number, AppliedMigrationRecord> {
    this.initMigrationsTable(db);
    const rows = db
      .prepare('SELECT version, name, applied_at, checksum FROM ucsa_migrations ORDER BY version ASC')
      .all() as AppliedMigrationRecord[];

    const map = new Map<number, AppliedMigrationRecord>();
    for (const row of rows) {
      map.set(row.version, row);
    }
    return map;
  }

  /**
   * Runs all pending migrations up to targetVersion in an atomic transaction.
   */
  static migrate(
    db: Database.Database,
    targetVersion = TARGET_SCHEMA_VERSION,
    availableMigrations: MigrationDefinition[] = CANONICAL_MIGRATIONS
  ): { currentVersion: number; appliedCount: number } {
    const currentVersion = this.getUserVersion(db);

    if (currentVersion > targetVersion) {
      throw new DatabaseVersionTooNewError(currentVersion, targetVersion);
    }

    this.initMigrationsTable(db);
    const appliedMap = this.getAppliedMigrations(db);

    // Verify existing checksums
    for (const migration of availableMigrations) {
      if (appliedMap.has(migration.version)) {
        const applied = appliedMap.get(migration.version)!;
        const expected = migration.sha256 ?? computeSqlChecksum(migration.sql);
        if (applied.checksum !== expected) {
          throw new MigrationChecksumMismatchError(migration.version, expected, applied.checksum);
        }
      }
    }

    // Determine pending migrations
    const pending = availableMigrations
      .filter((m) => m.version > currentVersion && m.version <= targetVersion)
      .sort((a, b) => a.version - b.version);

    if (pending.length === 0) {
      return { currentVersion, appliedCount: 0 };
    }

    // Execute in transaction
    const executeMigrations = db.transaction(() => {
      const insertRecordStmt = db.prepare(`
        INSERT INTO ucsa_migrations (version, name, applied_at, checksum)
        VALUES (?, ?, ?, ?)
      `);

      for (const m of pending) {
        try {
          db.exec(m.sql);
          const checksum = m.sha256 ?? computeSqlChecksum(m.sql);
          insertRecordStmt.run(m.version, m.name, Date.now(), checksum);
          this.setUserVersion(db, m.version);
        } catch (err) {
          throw new MigrationError(m.version, err);
        }
      }
    });

    executeMigrations();

    return {
      currentVersion: this.getUserVersion(db),
      appliedCount: pending.length,
    };
  }
}
