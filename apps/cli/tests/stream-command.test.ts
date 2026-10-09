import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runStream } from '../src/commands/stream.js';
import { parseArgs, dispatchCommand } from '../src/router.js';

describe('CLI stream command', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ucsa-cli-stream-test-'));
    dbPath = path.join(tempDir, 'stream-cache.db');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('parses stream command and options in router parseArgs', () => {
    const parsed = parseArgs(['stream', 'llm/completion', '--db', dbPath, '--encoding', 'utf8']);
    expect(parsed.command).toBe('stream');
    expect(parsed.args).toEqual(['llm/completion']);
    expect(parsed.options.db).toBe(dbPath);
    expect(parsed.options.encoding).toBe('utf8');
  });

  it('runs runStream and outputs tokens and summary to process.stdout.write', async () => {
    const stdoutChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    await runStream('llm/test-query', { db: dbPath });

    writeSpy.mockRestore();

    const output = stdoutChunks.join('');
    expect(output).toContain('Streaming response for "llm/test-query": The quick brown fox jumps over the lazy dog.');
    expect(output).toContain('[Stream complete:');
    expect(output).toMatch(/\[Stream complete: \d+ bytes, \d+ chunks\]/);
  });

  it('dispatches stream command via router dispatchCommand', async () => {
    const stdoutChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const parsed = parseArgs(['stream', 'ai/prompt-1', '--db', dbPath]);
    await dispatchCommand(parsed);

    writeSpy.mockRestore();

    const output = stdoutChunks.join('');
    expect(output).toContain('Streaming response for "ai/prompt-1":');
    expect(output).toContain('[Stream complete:');
  });

  it('hits cache on second run of runStream without error', async () => {
    const stdoutChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    // 1st run: streams and compacts into SQLite cache
    await runStream('cached/token-stream', { db: dbPath });

    const firstRunOutput = stdoutChunks.join('');
    expect(firstRunOutput).toContain('Streaming response for "cached/token-stream":');
    expect(firstRunOutput).toContain('[Stream complete:');

    stdoutChunks.length = 0;

    // 2nd run: should hit SQLite cache
    await runStream('cached/token-stream', { db: dbPath });

    writeSpy.mockRestore();

    const secondRunOutput = stdoutChunks.join('');
    expect(secondRunOutput).toContain('Streaming response for "cached/token-stream":');
    expect(secondRunOutput).toContain('[Stream complete:');
  });
});
