import { describe, it, expect, vi } from 'vitest';
import { parseArgs, getHelpText, dispatchCommand } from '../src/router.js';

vi.mock('../src/commands/index.js', () => ({
  runQuery: vi.fn(async () => console.log('[mock:query]')),
  runCas: vi.fn(async () => console.log('[mock:cas]')),
  runOutbox: vi.fn(async () => console.log('[mock:outbox]')),
  runDurability: vi.fn(async () => console.log('[mock:durability]')),
  runStatus: vi.fn(async () => console.log('[mock:status]')),
  runDaemon: vi.fn(async () => console.log('[mock:daemon]')),
  runStream: vi.fn(async () => console.log('[mock:stream]')),
}));

describe('CLI Router', () => {
  describe('parseArgs', () => {
    it('parses query "users/123"', () => {
      const parsed = parseArgs(['query', 'users/123']);
      expect(parsed.command).toBe('query');
      expect(parsed.args).toEqual(['users/123']);
      expect(parsed.options).toEqual({});
    });

    it('parses stream "llm/completion" --db custom.db --encoding utf8', () => {
      const parsed = parseArgs(['stream', 'llm/completion', '--db', 'custom.db', '--encoding', 'utf8']);
      expect(parsed.command).toBe('stream');
      expect(parsed.args).toEqual(['llm/completion']);
      expect(parsed.options).toEqual({ db: 'custom.db', encoding: 'utf8' });
    });

    it('parses cas put "myfile.tar.gz" --max 1000', () => {
      const parsed = parseArgs(['cas', 'put', 'myfile.tar.gz', '--max', '1000']);
      expect(parsed.command).toBe('cas put');
      expect(parsed.args).toEqual(['myfile.tar.gz']);
      expect(parsed.options).toEqual({ max: '1000' });
    });

    it('parses outbox replay --policy server-wins', () => {
      const parsed = parseArgs(['outbox', 'replay', '--policy', 'server-wins']);
      expect(parsed.command).toBe('outbox replay');
      expect(parsed.args).toEqual([]);
      expect(parsed.options).toEqual({ policy: 'server-wins' });
    });

    it('returns help when --help or -h flag is provided', () => {
      const parsedLong = parseArgs(['--help']);
      expect(parsedLong.command).toBe('help');
      expect(parsedLong.args).toEqual([]);
      expect(parsedLong.options.help).toBe(true);

      const parsedShort = parseArgs(['-h']);
      expect(parsedShort.command).toBe('help');
      expect(parsedShort.args).toEqual([]);
      expect(parsedShort.options.help).toBe(true);

      const parsedEmpty = parseArgs([]);
      expect(parsedEmpty.command).toBe('help');
      expect(parsedEmpty.args).toEqual([]);
    });

    it('parses additional subcommands: cas get, cas prune, outbox queue', () => {
      const getParsed = parseArgs(['cas', 'get', 'hash_abc123']);
      expect(getParsed.command).toBe('cas get');
      expect(getParsed.args).toEqual(['hash_abc123']);

      const pruneParsed = parseArgs(['cas', 'prune', '52428800']);
      expect(pruneParsed.command).toBe('cas prune');
      expect(pruneParsed.args).toEqual(['52428800']);

      const queueParsed = parseArgs(['outbox', 'queue', '{"type":"SYNC"}']);
      expect(queueParsed.command).toBe('outbox queue');
      expect(queueParsed.args).toEqual(['{"type":"SYNC"}']);
    });

    it('parses durability and status subcommands', () => {
      const durabilityParsed = parseArgs(['durability']);
      expect(durabilityParsed.command).toBe('durability');
      expect(durabilityParsed.args).toEqual([]);

      const durabilityTestParsed = parseArgs(['durability-test']);
      expect(durabilityTestParsed.command).toBe('durability');
      expect(durabilityTestParsed.args).toEqual([]);

      const statusParsed = parseArgs(['status']);
      expect(statusParsed.command).toBe('status');
      expect(statusParsed.args).toEqual([]);

      const daemonParsed = parseArgs(['daemon', '--db', '.ucsa/cache.db']);
      expect(daemonParsed.command).toBe('daemon');
      expect(daemonParsed.args).toEqual([]);
      expect(daemonParsed.options).toEqual({ db: '.ucsa/cache.db' });
    });

    it('handles various option formats: key=value, boolean flags, negated flags, -- terminator', () => {
      const parsed = parseArgs([
        'cas',
        'put',
        '--max=2048',
        '--dry-run',
        '--no-cache',
        '--',
        'target-file.bin',
        'extra.bin',
      ]);
      expect(parsed.command).toBe('cas put');
      expect(parsed.options.max).toBe('2048');
      expect(parsed.options['dry-run']).toBe(true);
      expect(parsed.options.cache).toBe(false);
      expect(parsed.args).toEqual(['target-file.bin', 'extra.bin']);
    });
  });

  describe('getHelpText', () => {
    it('returns formatted help containing all subcommands and usage information', () => {
      const help = getHelpText();
      expect(help).toContain('ucsa <command> [args] [options]');
      expect(help).toContain('query <key>');
      expect(help).toContain('cas put <file>');
      expect(help).toContain('cas get <hash>');
      expect(help).toContain('cas prune <bytes>');
      expect(help).toContain('outbox queue <json>');
      expect(help).toContain('outbox replay');
      expect(help).toContain('durability');
      expect(help).toContain('status');
      expect(help).toContain('daemon');
      expect(help).toContain('--help');
      expect(help).toContain('--policy');
      expect(help).toContain('--max');
    });
  });

  describe('dispatchCommand', () => {
    it('outputs help text when help command or help option is given', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await dispatchCommand({ command: 'help', args: [], options: {} });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('dispatches known commands without throwing', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await dispatchCommand({ command: 'query', args: ['users/1'], options: {} });
      await dispatchCommand({ command: 'cas put', args: ['file.txt'], options: {} });
      await dispatchCommand({ command: 'outbox replay', args: [], options: {} });
      await dispatchCommand({ command: 'durability', args: [], options: {} });
      await dispatchCommand({ command: 'status', args: [], options: {} });
      await dispatchCommand({ command: 'daemon', args: [], options: {} });
      expect(consoleSpy).toHaveBeenCalledTimes(6);
      consoleSpy.mockRestore();
    });
  });
});
