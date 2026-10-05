import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqliteAdapter } from '@ucsa/core';

export interface StatusCommandOptions {
  db?: string;
  casDir?: string;
  dir?: string;
}

export interface StatusMetrics {
  cachedCount: number;
  tagsCount: number;
  pendingCount: number;
  casCount: number;
  casTotalSize: number;
  dbSize: number;
  walSize: number;
}

export async function runStatus(
  options: StatusCommandOptions = {}
): Promise<void> {
  const dbPath = options.db || '.ucsa-cache.db';
  const casDir = options.casDir || options.dir || '.ucsa-cas';

  let cachedCount = 0;
  let tagsCount = 0;
  let pendingCount = 0;
  let casCount = 0;
  let casTotalSize = 0;
  let dbSize = 0;
  let walSize = 0;

  // Check main SQLite database
  if (fs.existsSync(dbPath)) {
    dbSize = fs.statSync(dbPath).size;
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      walSize = fs.statSync(walPath).size;
    }

    const sqliteAdapter = new SqliteAdapter(dbPath);
    try {
      const qRow = sqliteAdapter.db
        .prepare('SELECT COUNT(*) as count FROM ucsa_query_cache')
        .get() as { count: number } | undefined;
      cachedCount = qRow?.count ?? 0;

      const tRow = sqliteAdapter.db
        .prepare('SELECT COUNT(DISTINCT tag) as count FROM ucsa_cache_tags')
        .get() as { count: number } | undefined;
      tagsCount = tRow?.count ?? 0;

      const oRow = sqliteAdapter.db
        .prepare(
          "SELECT COUNT(*) as count FROM ucsa_mutation_outbox WHERE status = 'pending'"
        )
        .get() as { count: number } | undefined;
      pendingCount = oRow?.count ?? 0;

      const cRow = sqliteAdapter.db
        .prepare(
          'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM ucsa_cas_objects'
        )
        .get() as { count: number; total_size: number } | undefined;
      if (cRow) {
        casCount += cRow.count;
        casTotalSize += cRow.total_size;
      }
    } catch {
      // Tables might be empty or uninitialized
    } finally {
      sqliteAdapter.close();
    }
  }

  // Check if separate CAS database exists in casDir
  const casDbPath = path.join(casDir, 'cas.db');
  if (
    fs.existsSync(casDbPath) &&
    path.resolve(casDbPath) !== path.resolve(dbPath)
  ) {
    const casSqlite = new SqliteAdapter(casDbPath);
    try {
      const cRow = casSqlite.db
        .prepare(
          'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM ucsa_cas_objects'
        )
        .get() as { count: number; total_size: number } | undefined;
      if (cRow && cRow.count > 0) {
        casCount += cRow.count;
        casTotalSize += cRow.total_size;
      }
    } catch {
    } finally {
      casSqlite.close();
    }
  }

  console.log(`[ucsa:status] Database: ${dbPath}`);
  console.log(`[ucsa:status] Cached Queries: ${cachedCount}`);
  console.log(`[ucsa:status] Cache Tags: ${tagsCount}`);
  console.log(`[ucsa:status] Outbox Pending: ${pendingCount}`);
  console.log(`[ucsa:status] CAS Objects: ${casCount} (${casTotalSize} bytes)`);
  console.log(`[ucsa:status] SQLite Size: ${dbSize} bytes (WAL: ${walSize} bytes)`);
}
