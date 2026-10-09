import * as fs from 'node:fs';
import { SqliteAdapter, CliDurabilityManager } from '@montionugera/ucsa-core';

export interface DurabilityCommandOptions {
  db?: string;
}

export async function runDurability(
  options: DurabilityCommandOptions = {}
): Promise<void> {
  const dbPath = options.db || '.ucsa-cache.db';
  const walPath = `${dbPath}-wal`;

  // Initialize adapter with WAL journal mode
  const sqliteAdapter = new SqliteAdapter(dbPath, { journalMode: 'WAL' });

  try {
    // Write data to ensure WAL frames are generated on disk
    const now = Date.now();
    sqliteAdapter.setQuery({
      query_hash: `durability_test_${now}`,
      query_key: ['durability_check'],
      data_payload: { timestamp: now, status: 'checkpoint_pending' },
      created_at: now,
      stale_at: now + 60000,
      expires_at: now + 300000,
    });

    const walSizeBefore = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    console.log(`[ucsa:durability] WAL size before checkpoint: ${walSizeBefore} bytes`);

    // Use CliDurabilityManager to register and perform synchronous exit flush
    const durabilityManager = new CliDurabilityManager();
    durabilityManager.registerSqliteCheckpoint(sqliteAdapter, -100, 'TRUNCATE');

    durabilityManager.flushAll();

    const walSizeAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    console.log(`[ucsa:durability] WAL size after checkpoint: ${walSizeAfter} bytes`);

    if (walSizeAfter !== 0) {
      throw new Error(
        `WAL checkpoint failed: WAL size is ${walSizeAfter} bytes, expected 0 bytes`
      );
    }

    console.log(
      `[ucsa:durability] WAL checkpoint TRUNCATE verified successfully (0 bytes)`
    );
  } finally {
    sqliteAdapter.close();
  }
}
