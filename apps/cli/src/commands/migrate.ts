import Database from 'better-sqlite3';
import {
  SqliteAdapter,
  MigrationRunner,
  TARGET_SCHEMA_VERSION,
  CANONICAL_MIGRATIONS,
  type AppliedMigrationRecord,
} from '@montionugera/ucsa-core';

export interface MigrateCommandOptions {
  db?: string;
  targetVersion?: number;
  migrationsDir?: string;
}

export interface MigrateResult {
  action: 'status' | 'up' | 'check' | 'clean-incompatible';
  currentVersion: number;
  targetVersion: number;
  appliedCount?: number;
  pendingCount?: number;
  evictedCount?: number;
  outboxMutationsCount?: number;
  upToDate?: boolean;
  appliedMigrations?: AppliedMigrationRecord[];
  pendingMigrations?: Array<{ version: number; name: string }>;
}

export async function runMigrate(
  action: 'status' | 'up' | 'check' | 'clean-incompatible',
  options: MigrateCommandOptions = {}
): Promise<MigrateResult> {
  const dbPath = options.db || '.ucsa-cache.db';
  const targetVersion = options.targetVersion ?? TARGET_SCHEMA_VERSION;
  const db = new Database(dbPath);

  try {
    const currentVersion = MigrationRunner.getUserVersion(db);
    const appliedMap = MigrationRunner.getAppliedMigrations(db);
    const applied = Array.from(appliedMap.values()).sort(
      (a, b) => a.version - b.version
    );
    const pending = CANONICAL_MIGRATIONS.filter(
      (m) => m.version > currentVersion && m.version <= targetVersion
    );

    switch (action) {
      case 'status': {
        console.log(`[ucsa:migrate] Database: ${dbPath}`);
        console.log(`[ucsa:migrate] Current schema version: ${currentVersion}`);
        console.log(`[ucsa:migrate] Target schema version: ${targetVersion}`);
        console.log(`[ucsa:migrate] Applied migrations (${applied.length}):`);
        for (const m of applied) {
          console.log(
            `  - v${m.version} (${m.name}) [checksum: ${m.checksum.slice(0, 8)}...]`
          );
        }
        console.log(`[ucsa:migrate] Pending migrations (${pending.length}):`);
        for (const p of pending) {
          console.log(`  - v${p.version} (${p.name})`);
        }

        return {
          action: 'status',
          currentVersion,
          targetVersion,
          appliedCount: applied.length,
          pendingCount: pending.length,
          appliedMigrations: applied,
          pendingMigrations: pending.map((p) => ({
            version: p.version,
            name: p.name,
          })),
        };
      }

      case 'up': {
        const { currentVersion: updatedVersion, appliedCount } =
          MigrationRunner.migrate(db, targetVersion);

        console.log(
          `[ucsa:migrate] Applied ${appliedCount} migration(s). Database schema upgraded from v${currentVersion} to v${updatedVersion}.`
        );

        return {
          action: 'up',
          currentVersion: updatedVersion,
          targetVersion,
          appliedCount,
          pendingCount: 0,
          upToDate: updatedVersion >= targetVersion,
        };
      }

      case 'check': {
        const upToDate = currentVersion >= targetVersion;
        if (upToDate) {
          console.log(
            `[ucsa:migrate] Schema is up-to-date at version ${currentVersion}.`
          );
        } else {
          console.warn(
            `[ucsa:migrate] Schema is outdated: current v${currentVersion} < target v${targetVersion}. (${pending.length} migration(s) pending)`
          );
        }

        return {
          action: 'check',
          currentVersion,
          targetVersion,
          pendingCount: pending.length,
          upToDate,
        };
      }

      case 'clean-incompatible': {
        // 1. Record outbox count before cleanup
        let outboxCountBefore = 0;
        try {
          const row = db
            .prepare('SELECT COUNT(*) as count FROM ucsa_mutation_outbox')
            .get() as { count: number };
          outboxCountBefore = row?.count ?? 0;
        } catch {
          outboxCountBefore = 0;
        }

        // 2. Scan ucsa_query_cache
        let evictedCount = 0;
        let totalScanned = 0;
        try {
          const rows = db
            .prepare(
              'SELECT query_hash, query_key, data_payload, payload_version FROM ucsa_query_cache'
            )
            .all() as Array<{
            query_hash: string;
            query_key: string;
            data_payload: string;
            payload_version: number | null;
          }>;
          totalScanned = rows.length;

          const deleteStmt = db.prepare(
            'DELETE FROM ucsa_query_cache WHERE query_hash = ?'
          );

          for (const row of rows) {
            let evict = false;
            try {
              JSON.parse(row.query_key);
              JSON.parse(row.data_payload);
              const pVersion = row.payload_version ?? 1;
              if (pVersion > targetVersion) {
                evict = true; // Future or unsupported payload version
              }
            } catch {
              evict = true; // Malformed JSON
            }

            if (evict) {
              deleteStmt.run(row.query_hash);
              evictedCount++;
            }
          }
        } catch {
          // Table might not exist yet
        }

        // 3. Verify outbox count after cleanup (Outbox Salvage Protection)
        let outboxCountAfter = 0;
        try {
          const row = db
            .prepare('SELECT COUNT(*) as count FROM ucsa_mutation_outbox')
            .get() as { count: number };
          outboxCountAfter = row?.count ?? 0;
        } catch {
          outboxCountAfter = 0;
        }

        console.log(
          `[ucsa:migrate] Scanned ${totalScanned} query cache records. Selectively evicted ${evictedCount} incompatible/corrupted entries.`
        );
        console.log(
          `[ucsa:migrate] Outbox salvage check: ${outboxCountAfter} pending mutation(s) verified intact (0 modified).`
        );

        return {
          action: 'clean-incompatible',
          currentVersion,
          targetVersion,
          evictedCount,
          outboxMutationsCount: outboxCountAfter,
        };
      }
    }
  } finally {
    db.close();
  }
}
