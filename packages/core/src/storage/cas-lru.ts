import type Database from 'better-sqlite3';

export interface CasObjectRecord {
  hash: string;
  size: number;
  last_accessed_at: number;
}

export interface PruneResult {
  prunedCount: number;
  bytesFreed: number;
}

interface CasLruStatements {
  upsert: Database.Statement<[string, number, number]>;
  updateAccess: Database.Statement<[number, string]>;
  get: Database.Statement<[string]>;
  delete: Database.Statement<[string]>;
  totalSize: Database.Statement<[]>;
  getAllLru: Database.Statement<[]>;
}

const statementCache = new WeakMap<Database.Database, CasLruStatements>();

/**
 * Initializes the ucsa_cas_objects table and index in the database.
 */
export function initCasTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ucsa_cas_objects (
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ucsa_cas_access ON ucsa_cas_objects(last_accessed_at);
  `);
}

function getStatements(db: Database.Database): CasLruStatements {
  let stmts = statementCache.get(db);
  if (!stmts) {
    // Ensure table exists before preparing statements
    initCasTable(db);

    stmts = {
      upsert: db.prepare<[string, number, number]>(`
        INSERT INTO ucsa_cas_objects (hash, size, last_accessed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET
          size = excluded.size,
          last_accessed_at = excluded.last_accessed_at;
      `),
      updateAccess: db.prepare<[number, string]>(`
        UPDATE ucsa_cas_objects
        SET last_accessed_at = ?
        WHERE hash = ?;
      `),
      get: db.prepare<[string]>(`
        SELECT hash, size, last_accessed_at
        FROM ucsa_cas_objects
        WHERE hash = ?;
      `),
      delete: db.prepare<[string]>(`
        DELETE FROM ucsa_cas_objects
        WHERE hash = ?;
      `),
      totalSize: db.prepare<[]>(`
        SELECT COALESCE(SUM(size), 0) AS total_size
        FROM ucsa_cas_objects;
      `),
      getAllLru: db.prepare<[]>(`
        SELECT hash, size, last_accessed_at
        FROM ucsa_cas_objects
        ORDER BY last_accessed_at ASC, rowid ASC;
      `),
    };
    statementCache.set(db, stmts);
  }
  return stmts;
}

/**
 * Records or updates a CAS object entry in SQLite with its size and access timestamp.
 */
export function upsertCasObject(
  db: Database.Database,
  hash: string,
  size: number,
  lastAccessedAt: number = Date.now()
): void {
  const { upsert } = getStatements(db);
  upsert.run(hash, size, lastAccessedAt);
}

/**
 * Updates the last_accessed_at timestamp for a given CAS object hash.
 * Returns true if the record was updated, false if the hash was not found.
 */
export function updateCasAccessTime(
  db: Database.Database,
  hash: string,
  lastAccessedAt: number = Date.now()
): boolean {
  const { updateAccess } = getStatements(db);
  const result = updateAccess.run(lastAccessedAt, hash);
  return result.changes > 0;
}

/**
 * Retrieves the CAS object record from SQLite by hash.
 */
export function getCasObject(
  db: Database.Database,
  hash: string
): CasObjectRecord | null {
  const { get } = getStatements(db);
  const row = get.get(hash) as CasObjectRecord | undefined;
  return row ?? null;
}

/**
 * Deletes a CAS object record from SQLite by hash.
 * Returns true if a record was deleted, false otherwise.
 */
export function deleteCasObject(
  db: Database.Database,
  hash: string
): boolean {
  const { delete: deleteStmt } = getStatements(db);
  const result = deleteStmt.run(hash);
  return result.changes > 0;
}

/**
 * Computes the total byte size of all tracked CAS objects in SQLite.
 */
export function getTotalCasSize(db: Database.Database): number {
  const { totalSize } = getStatements(db);
  const row = totalSize.get() as { total_size: number } | undefined;
  return row?.total_size ?? 0;
}

/**
 * Retrieves all tracked CAS objects ordered by last_accessed_at ascending (LRU candidates first).
 */
export function getLruCasObjects(
  db: Database.Database,
  limit?: number
): CasObjectRecord[] {
  const { getAllLru } = getStatements(db);
  const rows = getAllLru.all() as CasObjectRecord[];
  if (limit !== undefined && limit >= 0) {
    return rows.slice(0, limit);
  }
  return rows;
}
