import { SqliteAdapter, QueryEngine, type QueryKey } from '@ucsa/core';

export interface StreamCommandOptions {
  db?: string;
  encoding?: string;
}

/**
 * Executes a streaming query CLI command.
 * Connects to the local SQLite database and streams incremental chunk deltas
 * to stdout, printing a summary upon completion.
 */
export async function runStream(
  queryKey: string,
  options: StreamCommandOptions = {}
): Promise<void> {
  const dbPath = options.db || '.ucsa-cache.db';
  const encoding = options.encoding === 'bytes' ? 'bytes' : 'utf8';

  let keyTuple: QueryKey;
  if (queryKey.startsWith('[') && queryKey.endsWith(']')) {
    try {
      keyTuple = JSON.parse(queryKey) as QueryKey;
    } catch {
      keyTuple = [queryKey];
    }
  } else {
    keyTuple = [queryKey];
  }

  const sqliteAdapter = new SqliteAdapter(dbPath);
  const queryEngine = new QueryEngine({ sqliteAdapter });

  try {
    const handle = queryEngine.streamQuery<string>(
      keyTuple,
      async (ctx) => {
        return (async function* () {
          const tokens = [
            'Streaming ',
            'response ',
            'for ',
            `"${queryKey}": `,
            'The ',
            'quick ',
            'brown ',
            'fox ',
            'jumps ',
            'over ',
            'the ',
            'lazy ',
            'dog.',
          ];

          for (const token of tokens) {
            if (ctx.signal.aborted) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield token;
          }
        })();
      },
      {
        encoding,
      }
    );

    let totalBytes = 0;
    let chunkCount = 0;

    for await (const slice of handle) {
      if (slice.delta) {
        const delta = slice.delta as unknown;
        if (typeof delta === 'string') {
          if (delta.length > 0) {
            process.stdout.write(delta);
            totalBytes += Buffer.byteLength(delta, 'utf8');
            chunkCount++;
          }
        } else if (Buffer.isBuffer(delta) || delta instanceof Uint8Array) {
          if (delta.length > 0) {
            process.stdout.write(delta);
            totalBytes += delta.length;
            chunkCount++;
          }
        }
      }
    }

    await handle.done;
    process.stdout.write(`\n[Stream complete: ${totalBytes} bytes, ${chunkCount} chunks]\n`);
  } finally {
    sqliteAdapter.close();
  }
}
