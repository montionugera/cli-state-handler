import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CliDurabilityManager,
  registerExitFlush,
  resetDefaultDurabilityManager,
  SqliteAdapter,
} from '../../src/index.js';
import type { CacheEntry } from '../../src/index.js';

describe('CLI Ephemeral Process Durability & Flush Manager', () => {
  let manager: CliDurabilityManager;

  beforeEach(() => {
    manager = new CliDurabilityManager();
    resetDefaultDurabilityManager();
  });

  afterEach(() => {
    resetDefaultDurabilityManager();
    vi.restoreAllMocks();
  });

  describe('Registration & Priority Execution', () => {
    it('executes registered flusher callbacks in correct priority order', () => {
      const callLog: string[] = [];

      manager.register(() => callLog.push('low (-10)'), -10);
      manager.register(() => callLog.push('critical (100)'), 100);
      manager.register(() => callLog.push('default (0)'));
      manager.register(() => callLog.push('high (50)'), 50);

      manager.flushAll();

      expect(callLog).toEqual([
        'critical (100)',
        'high (50)',
        'default (0)',
        'low (-10)',
      ]);
    });

    it('maintains FIFO order for callbacks registered with the same priority', () => {
      const callLog: string[] = [];

      manager.register(() => callLog.push('first'), 10);
      manager.register(() => callLog.push('second'), 10);
      manager.register(() => callLog.push('third'), 10);

      manager.flushAll();

      expect(callLog).toEqual(['first', 'second', 'third']);
    });

    it('tracks the number of registered callbacks via size property', () => {
      expect(manager.size).toBe(0);

      const unregister1 = manager.register(() => {});
      const unregister2 = manager.register(() => {});
      expect(manager.size).toBe(2);

      unregister1();
      expect(manager.size).toBe(1);

      unregister2();
      expect(manager.size).toBe(0);
    });
  });

  describe('Unregistration', () => {
    it('prevents execution of unregistered callbacks on subsequent flush', () => {
      let runA = 0;
      let runB = 0;

      const unregisterA = manager.register(() => {
        runA++;
      });
      manager.register(() => {
        runB++;
      });

      manager.flushAll();
      expect(runA).toBe(1);
      expect(runB).toBe(1);

      unregisterA();

      manager.flushAll();
      expect(runA).toBe(1); // Should not run again
      expect(runB).toBe(2); // Should continue running
    });

    it('handles multiple unregister calls idempotently without errors', () => {
      const unregister = manager.register(() => {});
      expect(manager.size).toBe(1);

      unregister();
      expect(manager.size).toBe(0);

      expect(() => {
        unregister();
        unregister();
      }).not.toThrow();
      expect(manager.size).toBe(0);
    });
  });

  describe('Error Resilience', () => {
    it('executes remaining flushers even if an earlier flusher throws', () => {
      const callLog: string[] = [];
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.register(() => callLog.push('first'), 10);
      manager.register(() => {
        callLog.push('faulty');
        throw new Error('Disk write error in flush handler');
      }, 5);
      manager.register(() => callLog.push('last'), 0);

      expect(() => manager.flushAll()).not.toThrow();

      expect(callLog).toEqual(['first', 'faulty', 'last']);
      expect(consoleSpy).toHaveBeenCalledWith(
        'CliDurabilityManager: Error executing flush callback:',
        expect.any(Error)
      );
    });

    it('routes errors to custom onError handler if provided in options', () => {
      const errors: unknown[] = [];
      const customManager = new CliDurabilityManager({
        onError: (err) => errors.push(err),
      });

      customManager.register(() => {
        throw new Error('Custom error');
      });

      expect(() => customManager.flushAll()).not.toThrow();
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('Custom error');
    });
  });

  describe('Idempotent Execution', () => {
    it('executes registered handlers appropriately on multiple flushAll() invocations', () => {
      let callCount = 0;
      manager.register(() => {
        callCount++;
      });

      manager.flushAll();
      expect(callCount).toBe(1);

      manager.flushAll();
      expect(callCount).toBe(2);

      manager.flushAll();
      expect(callCount).toBe(3);
    });

    it('safely supports dirty-tracking flush handlers on repeated flushes', () => {
      let pendingChanges = 3;
      let flushedTotal = 0;

      manager.register(() => {
        if (pendingChanges > 0) {
          flushedTotal += pendingChanges;
          pendingChanges = 0;
        }
      });

      manager.flushAll();
      expect(flushedTotal).toBe(3);

      // Subsequent flush without new dirty items is a clean no-op
      manager.flushAll();
      expect(flushedTotal).toBe(3);

      // New changes accumulate and flush on next run
      pendingChanges = 2;
      manager.flushAll();
      expect(flushedTotal).toBe(5);
    });
  });

  describe('Process Exit Hook Attachment', () => {
    it('attaches to beforeExit and triggers flushAll()', () => {
      const mockProc = new EventEmitter();
      let flushed = false;
      manager.register(() => {
        flushed = true;
      });

      const detach = manager.attachToProcess(mockProc);

      expect(flushed).toBe(false);
      mockProc.emit('beforeExit');
      expect(flushed).toBe(true);

      detach();
    });

    it('attaches to exit and triggers flushAll()', () => {
      const mockProc = new EventEmitter();
      let flushed = false;
      manager.register(() => {
        flushed = true;
      });

      const detach = manager.attachToProcess(mockProc);

      expect(flushed).toBe(false);
      mockProc.emit('exit');
      expect(flushed).toBe(true);

      detach();
    });

    it('detaches cleanly and removes process listeners', () => {
      const mockProc = new EventEmitter();
      let flushCount = 0;
      manager.register(() => {
        flushCount++;
      });

      const detach = manager.attachToProcess(mockProc);
      mockProc.emit('beforeExit');
      expect(flushCount).toBe(1);

      detach();

      mockProc.emit('beforeExit');
      mockProc.emit('exit');
      expect(flushCount).toBe(1); // No additional flushes after detach
    });

    it('handles process objects without event emitter gracefully', () => {
      expect(() => {
        manager.attachToProcess({} as any);
      }).not.toThrow();
    });
  });

  describe('SQLite WAL Checkpointing on Exit', () => {
    let tmpDir: string;
    let dbPath: string;
    let walPath: string;
    let adapter: SqliteAdapter;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-durability-test-'));
      dbPath = path.join(tmpDir, 'test.db');
      walPath = `${dbPath}-wal`;
      adapter = new SqliteAdapter(dbPath, { journalMode: 'WAL' });
    });

    afterEach(() => {
      adapter.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('truncates WAL file to 0 bytes via checkpoint("TRUNCATE")', () => {
      // 1. Insert query cache entry to generate WAL frames
      const entry: CacheEntry<{ message: string }> = {
        query_hash: 'q1',
        query_key: ['users', 'profile'],
        data_payload: { message: 'hello durability' },
        created_at: Date.now(),
        stale_at: Date.now() + 10000,
        expires_at: Date.now() + 60000,
      };
      adapter.setQuery(entry);

      // Verify WAL exists and has bytes written
      expect(fs.existsSync(walPath)).toBe(true);
      const sizeBefore = fs.statSync(walPath).size;
      expect(sizeBefore).toBeGreaterThan(0);

      // 2. Execute checkpoint TRUNCATE
      adapter.checkpoint('TRUNCATE');

      // 3. Verify WAL is truncated to 0 bytes
      const sizeAfter = fs.statSync(walPath).size;
      expect(sizeAfter).toBe(0);

      // Verify cached entry remains intact and accessible
      const cached = adapter.getQuery<{ message: string }>('q1');
      expect(cached?.data_payload).toEqual({ message: 'hello durability' });
    });

    it('checkpoints WAL during flushAll() when registered via registerSqliteCheckpoint', () => {
      const entry: CacheEntry<number[]> = {
        query_hash: 'q2',
        query_key: ['metrics'],
        data_payload: [1, 2, 3, 4, 5],
        created_at: Date.now(),
        stale_at: Date.now() + 10000,
        expires_at: Date.now() + 60000,
      };
      adapter.setQuery(entry);

      expect(fs.existsSync(walPath)).toBe(true);
      expect(fs.statSync(walPath).size).toBeGreaterThan(0);

      manager.registerSqliteCheckpoint(adapter);
      manager.flushAll();

      expect(fs.statSync(walPath).size).toBe(0);
    });

    it('executes other checkpoint modes (PASSIVE, FULL, RESTART) without error', () => {
      adapter.setQuery({
        query_hash: 'q3',
        query_key: ['test'],
        data_payload: 'passive test',
        created_at: Date.now(),
        stale_at: Date.now() + 1000,
        expires_at: Date.now() + 2000,
      });

      expect(() => adapter.checkpoint('PASSIVE')).not.toThrow();
      expect(() => adapter.checkpoint('FULL')).not.toThrow();
      expect(() => adapter.checkpoint('RESTART')).not.toThrow();
      expect(() => adapter.checkpoint('TRUNCATE')).not.toThrow();
    });

    it('does not throw when checkpoint is called on a closed adapter', () => {
      const closedAdapter = new SqliteAdapter(':memory:');
      closedAdapter.close();
      expect(() => closedAdapter.checkpoint('TRUNCATE')).not.toThrow();
    });
  });

  describe('registerExitFlush helper & Global Durability Manager', () => {
    it('registers flusher and runs on process exit event', () => {
      let flushed = false;
      const unregister = registerExitFlush(() => {
        flushed = true;
      });

      // Emulate exit
      process.emit('beforeExit', 0);
      expect(flushed).toBe(true);

      unregister();
    });

    it('unregisters cleanly from default durability manager', () => {
      let callCount = 0;
      const unregister = registerExitFlush(() => {
        callCount++;
      });

      process.emit('beforeExit', 0);
      expect(callCount).toBe(1);

      unregister();

      process.emit('beforeExit', 0);
      expect(callCount).toBe(1); // Not called again
    });
  });
});
