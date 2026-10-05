import { performance } from 'node:perf_hooks';
import * as crypto from 'node:crypto';
import { SqliteAdapter, QueryEngine, hashQueryKey, type QueryKey } from '@ucsa/core';

export interface QueryCommandOptions {
  db?: string;
  ttl?: number;
  tag?: string;
}

export async function runQuery(
  queryKey: string,
  options: QueryCommandOptions = {}
): Promise<void> {
  const startTime = performance.now();
  const dbPath = options.db || '.ucsa-cache.db';
  const ttl = options.ttl !== undefined ? Number(options.ttl) : 60000;
  const tags = options.tag ? [options.tag] : undefined;

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

  const hash = hashQueryKey(keyTuple);
  const sqliteAdapter = new SqliteAdapter(dbPath);
  const queryEngine = new QueryEngine({
    sqliteAdapter,
    defaultStaleTime: ttl,
  });

  try {
    const cached = sqliteAdapter.getQuery(hash);
    const now = Date.now();
    const isFresh = cached && now < cached.stale_at;

    let payload: unknown;
    let etag: string;
    let source: string;

    if (queryKey.startsWith('http://') || queryKey.startsWith('https://')) {
      const headers: Record<string, string> = {};
      if (cached?.etag) {
        headers['if-none-match'] = cached.etag;
      }

      let res: Response;
      try {
        res = await fetch(queryKey, { headers });
      } catch (networkErr) {
        // Fallback to cache if network fails and cache is available
        if (cached) {
          source = 'cache (SWR)';
          payload = cached.data_payload;
          etag = cached.etag ?? 'none';
          const duration = Math.max(1, Math.round(performance.now() - startTime));
          console.log(`[ucsa:query] Source: ${source}`);
          console.log(`[ucsa:query] Execution time: ${duration}ms`);
          console.log(`[ucsa:query] ETag: ${etag}`);
          console.log(`[ucsa:query] Payload: ${JSON.stringify(payload)}`);
          return;
        }
        throw networkErr;
      }

      if (res.status === 304 && cached) {
        source = 'cache (SWR)';
        payload = cached.data_payload;
        etag = cached.etag ?? 'none';
        sqliteAdapter.setQuery(
          {
            ...cached,
            stale_at: Date.now() + ttl,
          },
          tags
        );
      } else {
        source = 'network';
        etag =
          res.headers.get('etag') ||
          `"${crypto.createHash('sha256').update(queryKey + ':' + now).digest('hex').slice(0, 16)}"`;
        payload = await res.json();
        await queryEngine.fetchQuery(keyTuple, async () => payload, {
          staleTime: ttl,
          tags,
        });
        const saved = sqliteAdapter.getQuery(hash);
        if (saved) {
          sqliteAdapter.setQuery({ ...saved, etag }, tags);
        }
      }
    } else {
      // Non-HTTP / Local query key
      if (isFresh && cached && cached.data_payload !== undefined) {
        source = 'cache (SWR)';
        payload = cached.data_payload;
        etag = cached.etag ?? 'none';
      } else {
        source = 'network';
        const mockData = {
          key: queryKey,
          data: `Payload for ${queryKey}`,
          timestamp: now,
        };
        etag = `"${crypto.createHash('sha256').update(queryKey).digest('hex').slice(0, 16)}"`;
        payload = await queryEngine.fetchQuery(
          keyTuple,
          async () => mockData,
          { staleTime: ttl, tags }
        );
        const saved = sqliteAdapter.getQuery(hash);
        if (saved) {
          sqliteAdapter.setQuery({ ...saved, etag }, tags);
        }
      }
    }

    const duration = Math.max(1, Math.round(performance.now() - startTime));
    console.log(`[ucsa:query] Source: ${source}`);
    console.log(`[ucsa:query] Execution time: ${duration}ms`);
    console.log(`[ucsa:query] ETag: ${etag}`);
    console.log(`[ucsa:query] Payload: ${JSON.stringify(payload)}`);
  } finally {
    sqliteAdapter.close();
  }
}
