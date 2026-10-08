import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteAdapter, BusHub } from '@ucsa/core';
import { runDaemon } from '../src/commands/daemon.js';
import { runStatus } from '../src/commands/status.js';

describe('CLI daemon command and hub status telemetry', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ucsa-daemon-test-'));
    dbPath = path.join(tempDir, 'daemon-test.db');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe('runDaemon', () => {
    it('elects hub, creates endpoint, prints startup message, and unlinks cleanly on close (runOnce)', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      await runDaemon({ db: dbPath, runOnce: true });

      const startupLog = logs.find((l) => l.includes('[ucsa daemon] Hub active'));
      expect(startupLog).toBeDefined();
      expect(startupLog).toContain(`pid: ${process.pid}`);
      expect(startupLog).toContain('epoch: 1');

      // Verify hub row in DB
      const adapter = new SqliteAdapter(dbPath);
      const hubRow = adapter.db
        .prepare('SELECT id, epoch, pid, endpoint, token FROM ucsa_bus_hub WHERE id = 1')
        .get() as { id: number; epoch: number; pid: number; endpoint: string; token: string } | undefined;
      expect(hubRow).toBeDefined();
      expect(hubRow?.epoch).toBe(1);
      expect(hubRow?.pid).toBe(process.pid);
      expect(hubRow?.endpoint).toBeDefined();

      // Since runOnce was true, the hub should have closed and unlinked its endpoint (on POSIX)
      if (process.platform !== 'win32') {
        expect(fsSync.existsSync(hubRow!.endpoint)).toBe(false);
      }
      adapter.close();

      logSpy.mockRestore();
    });

    it('prints notice when another hub is already active', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      // Elect initial hub
      const adapter = new SqliteAdapter(dbPath);
      const existingHub = new BusHub({ sqliteAdapter: adapter });
      const electionRes = await existingHub.electOrConnect();
      expect(electionRes.role).toBe('hub');

      // Attempt to run daemon while existing hub is active
      await runDaemon({ db: dbPath, runOnce: true });

      const noticeLog = logs.find((l) => l.includes('another hub is already active'));
      expect(noticeLog).toBeDefined();
      expect(noticeLog).toContain(String(process.pid));
      expect(noticeLog).toContain(existingHub.endpoint);

      await existingHub.close();
      adapter.close();
      logSpy.mockRestore();
    });

    it('shuts down cleanly on SIGINT / SIGTERM signals', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      let endpoint = '';
      const daemonPromise = runDaemon({ db: dbPath });

      // Poll briefly until hub active log appears
      for (let i = 0; i < 50; i++) {
        const startupLog = logs.find((l) => l.includes('[ucsa daemon] Hub active'));
        if (startupLog) {
          const match = startupLog.match(/endpoint: ([^)]+)\)/);
          if (match) {
            endpoint = match[1];
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(endpoint).not.toBe('');
      if (process.platform !== 'win32') {
        expect(fsSync.existsSync(endpoint)).toBe(true);
      }

      // Emit SIGTERM to trigger graceful shutdown
      process.emit('SIGTERM');
      await daemonPromise;

      if (process.platform !== 'win32') {
        expect(fsSync.existsSync(endpoint)).toBe(false);
      }

      logSpy.mockRestore();
    });
  });

  describe('status command with hub telemetry', () => {
    it('displays Hub Status: Inactive (no hub elected) when no hub row exists', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      // Empty database
      const adapter = new SqliteAdapter(dbPath);
      adapter.close();

      await runStatus({ db: dbPath });

      const hubLog = logs.find((l) => l.includes('Hub Status:'));
      expect(hubLog).toBeDefined();
      expect(hubLog).toContain('Hub Status: Inactive (no hub elected)');

      logSpy.mockRestore();
    });

    it('displays Hub Status: Active when hub process is alive', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      const adapter = new SqliteAdapter(dbPath);
      const hub = new BusHub({ sqliteAdapter: adapter });
      const election = await hub.electOrConnect();
      expect(election.role).toBe('hub');

      await runStatus({ db: dbPath });

      const hubLog = logs.find((l) => l.includes('Hub Status:'));
      expect(hubLog).toBeDefined();
      expect(hubLog).toContain(
        `Hub Status: Active (PID: ${process.pid}, Epoch: ${election.epoch}, Endpoint: ${election.endpoint})`
      );

      await hub.close();
      adapter.close();
      logSpy.mockRestore();
    });

    it('displays Hub Status: Inactive when hub PID is not running', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      const adapter = new SqliteAdapter(dbPath);
      // Insert a dead PID row
      const deadPid = 99999999;
      adapter.db
        .prepare(`
          INSERT INTO ucsa_bus_hub (id, epoch, pid, endpoint, token, claimed_at)
          VALUES (1, 5, ?, '/tmp/dead-hub.sock', 'fake-token', ?)
        `)
        .run(deadPid, Date.now());

      await runStatus({ db: dbPath });

      const hubLog = logs.find((l) => l.includes('Hub Status:'));
      expect(hubLog).toBeDefined();
      expect(hubLog).toContain(`Hub Status: Inactive (PID: ${deadPid} not running)`);

      adapter.close();
      logSpy.mockRestore();
    });
  });
});
