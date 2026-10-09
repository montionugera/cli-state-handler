#!/usr/bin/env node
import { parseArgs, getHelpText, dispatchCommand } from '../src/router.js';

// CLI entrypoint supporting commands: query, stream, cas, outbox, durability, status, migrate, daemon, tutorial
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (!parsed.command || parsed.command === 'help' || parsed.options.help) {
    console.log(getHelpText());
    return;
  }

  await dispatchCommand(parsed);
}

main().catch((err: unknown) => {
  console.error('[ucsa] Fatal error:', err);
  process.exit(1);
});
