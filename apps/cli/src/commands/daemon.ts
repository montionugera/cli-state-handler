import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqliteAdapter, BusHub } from '@ucsa/core';

export interface DaemonCommandOptions {
  db?: string;
  runOnce?: boolean;
}

/**
 * Runs the UCSA elected bus hub daemon service.
 * Performs election via SQLite epoch locking. If another hub is active,
 * prints a notice. If elected as hub, binds transport and remains active until
 * SIGINT/SIGTERM is received (or immediately shuts down if runOnce is specified).
 */
export async function runDaemon(
  options: DaemonCommandOptions = {}
): Promise<void> {
  const dbPath = options.db || '.ucsa/cache.db';

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const sqliteAdapter = new SqliteAdapter(dbPath);
  const hub = new BusHub({ sqliteAdapter });

  try {
    const res = await hub.electOrConnect();

    if (res.role === 'client') {
      const hubRecord = hub.getHubRecord();
      const pid = hubRecord?.pid ?? 'unknown';
      console.log(
        `[ucsa daemon] Notice: another hub is already active at pid ${pid}, endpoint ${res.endpoint}`
      );
      await hub.close();
      sqliteAdapter.close();
      return;
    }

    // Role is 'hub'
    console.log(
      `[ucsa daemon] Hub active (pid: ${process.pid}, epoch: ${res.epoch}, endpoint: ${res.endpoint})`
    );

    if (options.runOnce) {
      await hub.close();
      sqliteAdapter.close();
      return;
    }

    return new Promise<void>((resolve) => {
      let isClosing = false;
      const cleanup = async () => {
        if (isClosing) return;
        isClosing = true;
        process.removeListener('SIGINT', cleanup);
        process.removeListener('SIGTERM', cleanup);
        try {
          await hub.close();
        } finally {
          sqliteAdapter.close();
          resolve();
        }
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    });
  } catch (err) {
    try {
      await hub.close();
    } catch {
      // ignore
    }
    sqliteAdapter.close();
    throw err;
  }
}
