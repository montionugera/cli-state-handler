import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CasStore, SqliteAdapter } from '@montionugera/ucsa-core';

export interface CasCommandOptions {
  dir?: string;
  casDir?: string;
  out?: string;
  maxBytes?: number;
  max?: string | number;
}

export async function runCas(
  action: 'put' | 'get' | 'prune',
  target: string,
  options: CasCommandOptions = {}
): Promise<void> {
  const baseDir = options.dir || options.casDir || path.join(process.cwd(), '.ucsa-cas');
  await fs.mkdir(baseDir, { recursive: true });

  const dbPath = path.join(baseDir, 'cas.db');
  const sqliteAdapter = new SqliteAdapter(dbPath);

  const rawMax = options.maxBytes !== undefined ? options.maxBytes : options.max;
  const maxSizeBytes = rawMax !== undefined ? Number(rawMax) : undefined;

  const store = new CasStore({
    baseDir,
    sqliteAdapter,
    maxSizeBytes,
  });

  await store.init();

  try {
    switch (action) {
      case 'put': {
        const fileData = await fs.readFile(target);
        const result = await store.put(fileData);
        console.log(`[ucsa:cas] Stored object successfully`);
        console.log(`[ucsa:cas] Hash: ${result.hash}`);
        console.log(`[ucsa:cas] Size: ${result.size} bytes`);
        console.log(`[ucsa:cas] Path: ${result.path}`);
        break;
      }
      case 'get': {
        const hash = target;
        const data = await store.get(hash);
        if (!data) {
          throw new Error(`CAS object not found for hash: ${hash}`);
        }
        if (options.out) {
          await fs.writeFile(options.out, data);
          console.log(`[ucsa:cas] Saved object (${data.byteLength} bytes) to ${options.out}`);
        } else {
          console.log(`[ucsa:cas] Retrieved object (${data.byteLength} bytes):`);
          console.log(data.toString('utf-8'));
        }
        break;
      }
      case 'prune': {
        const threshold = Number(target) || maxSizeBytes || 0;
        const result = await store.prune(0.7, threshold > 0 ? threshold : undefined);
        console.log(`[ucsa:cas] Prune complete`);
        console.log(`[ucsa:cas] Pruned count: ${result.prunedCount}`);
        console.log(`[ucsa:cas] Bytes freed: ${result.bytesFreed}`);
        break;
      }
      default:
        throw new Error(`Unknown CAS action: ${action}`);
    }
  } finally {
    sqliteAdapter.close();
  }
}
