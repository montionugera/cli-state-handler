import {
  SqliteAdapter,
  MutationOutbox,
  type ConflictPolicy,
  type OutboxMutation,
} from '@ucsa/core';

export interface OutboxCommandOptions {
  db?: string;
  method?: string;
  payload?: string;
  policy?: 'server-wins' | 'client-wins' | 'merge';
}

export async function runOutbox(
  action: 'queue' | 'replay',
  endpointOrArgs: string,
  options: OutboxCommandOptions = {}
): Promise<void> {
  const dbPath = options.db || '.ucsa-cache.db';
  const sqliteAdapter = new SqliteAdapter(dbPath);

  const outbox = new MutationOutbox({
    sqliteAdapter,
    onRollback: (mutation: OutboxMutation) => {
      console.log(
        `[ucsa:outbox] Rolled back mutation ${mutation.mutation_id} (server-wins)`
      );
    },
    mergeResolver: (localData: unknown, serverData: unknown) => {
      console.log(`[ucsa:outbox] Merged mutation conflict with server`);
      if (
        typeof localData === 'object' &&
        localData !== null &&
        typeof serverData === 'object' &&
        serverData !== null
      ) {
        return {
          ...(serverData as object),
          ...(localData as object),
          _merged: true,
        };
      }
      return localData ?? serverData;
    },
  });

  try {
    if (action === 'queue') {
      let endpoint = endpointOrArgs || '/api/resource';
      let method = options.method || 'POST';
      let payload: unknown = options.payload;
      let policy: ConflictPolicy = options.policy || 'server-wins';

      // Check if endpointOrArgs is a JSON string
      if (endpointOrArgs && endpointOrArgs.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(endpointOrArgs) as Record<string, unknown>;
          if (parsed.endpoint && typeof parsed.endpoint === 'string') {
            endpoint = parsed.endpoint;
          }
          if (parsed.method && typeof parsed.method === 'string') {
            method = parsed.method;
          }
          if (parsed.policy && typeof parsed.policy === 'string') {
            policy = parsed.policy as ConflictPolicy;
          }
          payload = parsed.payload !== undefined ? parsed.payload : parsed;
        } catch {
          // keep as string
        }
      }

      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          // keep payload as string
        }
      }

      const headers: Record<string, string> = {
        'x-conflict-policy': policy,
      };

      const mutationId = `mut_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const mutation = outbox.enqueue({
        mutation_id: mutationId,
        endpoint,
        method,
        headers,
        payload,
        conflictPolicy: policy,
      });

      console.log(`[ucsa:outbox] Enqueued mutation: ${mutation.mutation_id}`);
      console.log(`[ucsa:outbox] Endpoint: ${mutation.endpoint}`);
      console.log(`[ucsa:outbox] Method: ${mutation.method}`);
      console.log(`[ucsa:outbox] Policy: ${mutation.conflictPolicy}`);
      console.log(`[ucsa:outbox] Status: ${mutation.status}`);
    } else if (action === 'replay') {
      console.log(`[ucsa:outbox] Replaying pending mutations...`);

      // Mock executor: returns 409 Conflict if conflict is flagged in payload or endpoint
      const executor = async (mutation: OutboxMutation) => {
        const payloadObj =
          mutation.payload && typeof mutation.payload === 'object'
            ? (mutation.payload as Record<string, unknown>)
            : undefined;

        const hasConflict =
          payloadObj?.conflict === true ||
          mutation.endpoint.includes('conflict');

        if (hasConflict && !mutation.forced && !payloadObj?._merged) {
          return {
            status: 409,
            data: {
              serverVersion: 2,
              error: 'Conflict detected on server',
            },
          };
        }

        return {
          status: 200,
          data: { success: true, processedAt: Date.now() },
        };
      };

      const conflictResolver = async (
        mutation: OutboxMutation,
        _conflictData: unknown
      ) => {
        const effectivePolicy =
          options.policy ||
          mutation.headers?.['x-conflict-policy'] ||
          mutation.conflictPolicy ||
          'server-wins';
        if (effectivePolicy === 'client-wins') return 'force' as const;
        if (effectivePolicy === 'merge') return 'merged' as const;
        return 'rollback' as const;
      };

      const result = await outbox.replay(executor, conflictResolver);

      console.log(`[ucsa:outbox] Replay complete:`);
      console.log(`[ucsa:outbox] Processed: ${result.processed}`);
      console.log(`[ucsa:outbox] Successful: ${result.successful}`);
      console.log(`[ucsa:outbox] Failed: ${result.failed}`);
    } else {
      throw new Error(`Unknown outbox action: ${action}`);
    }
  } finally {
    sqliteAdapter.close();
  }
}
