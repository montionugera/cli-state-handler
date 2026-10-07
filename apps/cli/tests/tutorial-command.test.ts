import { describe, it, expect, vi } from 'vitest';
import * as net from 'node:net';
import { parseArgs, dispatchCommand } from '../src/router.js';
import {
  isPortAvailable,
  resolvePort,
  runTutorial,
} from '../src/commands/tutorial.js';

describe('Tutorial & Docs CLI Command', () => {
  it('parses "tutorial" command and flags correctly', () => {
    const parsed = parseArgs(['tutorial', '--port', '6006', '--dry-run']);
    expect(parsed.command).toBe('tutorial');
    expect(parsed.options.port).toBe('6006');
    expect(parsed.options['dry-run']).toBe(true);
  });

  it('parses "docs" alias as tutorial command', () => {
    const parsed = parseArgs(['docs', '--port', '8080', '--host', '0.0.0.0']);
    expect(parsed.command).toBe('tutorial');
    expect(parsed.options.port).toBe('8080');
    expect(parsed.options.host).toBe('0.0.0.0');
  });

  it('accurately detects available and busy ports', async () => {
    // 1. Verify an arbitrary ephemeral port is available
    const testServer = net.createServer();
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', () => resolve()));
    const address = testServer.address() as net.AddressInfo;
    const busyPort = address.port;

    // 2. isPortAvailable should return false for busyPort
    const isBusy = await isPortAvailable(busyPort, '127.0.0.1');
    expect(isBusy).toBe(false);

    // 3. Close the server, port should become available
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
    const isFree = await isPortAvailable(busyPort, '127.0.0.1');
    expect(isFree).toBe(true);
  });

  it('silently falls back from 6006 to 6007 on port collision (Rule 6)', async () => {
    // Create a listener on 6006 if not already occupied
    const dummyServer = net.createServer();
    let occupied = false;
    try {
      await new Promise<void>((resolve, reject) => {
        dummyServer.once('error', reject);
        dummyServer.listen(6006, 'localhost', () => {
          occupied = true;
          resolve();
        });
      });
    } catch {
      occupied = true;
    }

    try {
      const chosenPort = await resolvePort(6006, 'localhost');
      // If 6006 was occupied, resolvePort should return 6007 (or next)
      if (occupied) {
        expect(chosenPort).toBeGreaterThanOrEqual(6007);
      } else {
        expect(chosenPort).toBe(6006);
      }
    } finally {
      if (dummyServer.listening) {
        await new Promise<void>((resolve) => dummyServer.close(() => resolve()));
      }
    }
  });

  it('executes runTutorial in dry-run mode and returns resolved configuration', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runTutorial({
        port: 6020,
        host: 'localhost',
        dryRun: true,
      });

      expect(result.status).toBe('ready');
      expect(result.port).toBe(6020);
      expect(result.host).toBe('localhost');
      expect(result.url).toBe('http://localhost:6020');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dry-run validated cleanly')
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('dispatches "tutorial --dry-run" via dispatchCommand without error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const parsed = parseArgs(['tutorial', '--dry-run', '--port', '6021']);
      await expect(dispatchCommand(parsed)).resolves.not.toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('dispatches "docs --dry-run" via dispatchCommand without error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const parsed = parseArgs(['docs', '--dry-run', '--port', '6022']);
      await expect(dispatchCommand(parsed)).resolves.not.toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });
});
