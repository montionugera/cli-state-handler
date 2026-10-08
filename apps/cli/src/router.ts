import {
  runQuery,
  runCas,
  runOutbox,
  runDurability,
  runStatus,
  runTutorial,
  runMigrate,
} from './commands/index.js';

export interface ParsedCommand {
  command: string;
  args: string[];
  options: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedCommand {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  let stopOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (stopOptions) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      stopOptions = true;
      continue;
    }

    if (token.startsWith('--')) {
      const optionBody = token.slice(2);
      if (optionBody === 'help') {
        options.help = true;
        continue;
      }
      if (optionBody === 'version') {
        options.version = true;
        continue;
      }
      if (optionBody.startsWith('no-')) {
        const flagName = optionBody.slice(3);
        options[flagName] = false;
        continue;
      }
      const eqIndex = optionBody.indexOf('=');
      if (eqIndex !== -1) {
        const key = optionBody.slice(0, eqIndex);
        const value = optionBody.slice(eqIndex + 1);
        options[key] = value;
        if (key.includes('-')) {
          const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          options[camel] = value;
        }
      } else {
        const key = optionBody;
        const nextToken = argv[i + 1];
        if (nextToken !== undefined && !nextToken.startsWith('-')) {
          options[key] = nextToken;
          if (key.includes('-')) {
            const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            options[camel] = nextToken;
          }
          i++;
        } else {
          options[key] = true;
          if (key.includes('-')) {
            const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            options[camel] = true;
          }
        }
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const shortBody = token.slice(1);
      if (shortBody === 'h') {
        options.help = true;
        options.h = true;
        continue;
      }
      if (shortBody === 'v') {
        options.version = true;
        options.v = true;
        continue;
      }
      const eqIndex = shortBody.indexOf('=');
      if (eqIndex !== -1) {
        const key = shortBody.slice(0, eqIndex);
        const value = shortBody.slice(eqIndex + 1);
        options[key] = value;
      } else {
        const key = shortBody;
        const nextToken = argv[i + 1];
        if (nextToken !== undefined && !nextToken.startsWith('-')) {
          options[key] = nextToken;
          i++;
        } else {
          options[key] = true;
        }
      }
      continue;
    }

    positionals.push(token);
  }

  // Determine command and args
  if (positionals.length === 0) {
    return {
      command: 'help',
      args: [],
      options,
    };
  }

  const [first, second, ...rest] = positionals;

  if (first === 'help') {
    return {
      command: 'help',
      args: positionals.slice(1),
      options,
    };
  }

  if (first === 'query') {
    return {
      command: 'query',
      args: positionals.slice(1),
      options,
    };
  }

  if (first === 'cas') {
    if (second !== undefined) {
      return {
        command: `cas ${second}`,
        args: rest,
        options,
      };
    }
    return {
      command: 'cas',
      args: [],
      options,
    };
  }

  if (first.startsWith('cas:')) {
    const subAction = first.slice(4);
    return {
      command: `cas ${subAction}`,
      args: positionals.slice(1),
      options,
    };
  }

  if (first === 'outbox') {
    if (second !== undefined) {
      return {
        command: `outbox ${second}`,
        args: rest,
        options,
      };
    }
    return {
      command: 'outbox',
      args: [],
      options,
    };
  }

  if (first.startsWith('outbox:')) {
    const subAction = first.slice(7);
    return {
      command: `outbox ${subAction}`,
      args: positionals.slice(1),
      options,
    };
  }

  if (first === 'durability' || first === 'durability-test') {
    return {
      command: 'durability',
      args: positionals.slice(1),
      options,
    };
  }

  if (first === 'status') {
    return {
      command: 'status',
      args: positionals.slice(1),
      options,
    };
  }

  if (first === 'tutorial' || first === 'docs') {
    return {
      command: 'tutorial',
      args: positionals.slice(1),
      options,
    };
  }

  if (first === 'migrate') {
    if (second !== undefined) {
      return {
        command: `migrate ${second}`,
        args: rest,
        options,
      };
    }
    return {
      command: 'migrate status',
      args: [],
      options,
    };
  }

  if (first.startsWith('migrate:')) {
    const subAction = first.slice(8);
    return {
      command: `migrate ${subAction}`,
      args: positionals.slice(1),
      options,
    };
  }

  return {
    command: first,
    args: positionals.slice(1),
    options,
  };
}

export function getHelpText(): string {
  return `ucsa - Unified Client State Architecture CLI

Usage:
  ucsa <command> [args] [options]

Subcommands:
  query <key>                       Query local SQLite cache / BFF with SWR & ETag
  cas put <file> [--max <bytes>]    Store file in Content-Addressable Storage
  cas get <hash>                    Retrieve file from Content-Addressable Storage
  cas prune <bytes>                 Prune CAS cache to byte quota using LRU
  outbox queue <json>               Queue an offline mutation
  outbox replay [--policy <policy>] Replay pending mutations (server-wins, client-wins, merge)
  durability                        Verify WAL truncate checkpointing on exit
  status                            Display cache, CAS, and outbox metrics
  migrate [status|up|check|clean]   Inspect/apply schema migrations & evict incompatible cache
  tutorial [--port <port>]          Launch interactive Storybook tutorial & live docs
  docs                              Alias for tutorial
  help, --help, -h                  Display this help message

Options:
  --help, -h                        Show help
  --version, -v                     Show version
  --policy <policy>                 Conflict resolution policy (default: server-wins)
  --max <bytes>                     Maximum byte threshold for storage operations
  --target-version <v>              Target schema/payload version for migrations
`;
}


export async function dispatchCommand(parsed: ParsedCommand): Promise<void> {
  if (!parsed.command || parsed.command === 'help' || parsed.options.help) {
    console.log(getHelpText());
    return;
  }

  switch (parsed.command) {
    case 'query': {
      const key = parsed.args[0] ?? '';
      await runQuery(key, {
        db: parsed.options.db as string | undefined,
        ttl:
          parsed.options.ttl !== undefined
            ? Number(parsed.options.ttl)
            : undefined,
        tag: parsed.options.tag as string | undefined,
      });
      break;
    }
    case 'cas put': {
      const file = parsed.args[0] ?? '';
      const rawMax =
        parsed.options.maxBytes !== undefined
          ? parsed.options.maxBytes
          : parsed.options.max;
      await runCas('put', file, {
        dir: (parsed.options.dir || parsed.options.casDir) as
          | string
          | undefined,
        maxBytes: rawMax !== undefined ? Number(rawMax) : undefined,
      });
      break;
    }
    case 'cas get': {
      const hash = parsed.args[0] ?? '';
      await runCas('get', hash, {
        dir: (parsed.options.dir || parsed.options.casDir) as
          | string
          | undefined,
        out: parsed.options.out as string | undefined,
      });
      break;
    }
    case 'cas prune': {
      const target = parsed.args[0] ?? '';
      const rawMax =
        parsed.options.maxBytes !== undefined
          ? parsed.options.maxBytes
          : parsed.options.max;
      await runCas('prune', target, {
        dir: (parsed.options.dir || parsed.options.casDir) as
          | string
          | undefined,
        maxBytes: rawMax !== undefined ? Number(rawMax) : undefined,
      });
      break;
    }
    case 'outbox queue': {
      const endpointOrJson = parsed.args[0] ?? '';
      await runOutbox('queue', endpointOrJson, {
        db: parsed.options.db as string | undefined,
        method: parsed.options.method as string | undefined,
        payload: parsed.options.payload as string | undefined,
        policy: parsed.options.policy as any,
      });
      break;
    }
    case 'outbox replay': {
      const arg = parsed.args[0] ?? '';
      const rawRateLimit =
        parsed.options.rateLimitMs !== undefined
          ? parsed.options.rateLimitMs
          : parsed.options.rateLimit;
      const rawBatchSize =
        parsed.options.batchSize !== undefined
          ? parsed.options.batchSize
          : parsed.options.batch;
      await runOutbox('replay', arg, {
        db: parsed.options.db as string | undefined,
        policy: parsed.options.policy as any,
        rateLimitMs:
          rawRateLimit !== undefined ? Number(rawRateLimit) : undefined,
        batchSize:
          rawBatchSize !== undefined ? Number(rawBatchSize) : undefined,
      });
      break;
    }
    case 'durability': {
      await runDurability({
        db: parsed.options.db as string | undefined,
      });
      break;
    }
    case 'status': {
      await runStatus({
        db: parsed.options.db as string | undefined,
        casDir: (parsed.options.casDir || parsed.options.dir) as
          | string
          | undefined,
      });
      break;
    }
    case 'tutorial':
    case 'docs': {
      const rawPort = parsed.options.port;
      const port = rawPort !== undefined ? Number(rawPort) : undefined;
      const host = parsed.options.host as string | undefined;
      const dryRun = Boolean(parsed.options.dryRun || parsed.options['dry-run']);
      const open = parsed.options.open !== undefined ? Boolean(parsed.options.open) : true;
      await runTutorial({ port, host, dryRun, open });
      break;
    }
    case 'migrate':
    case 'migrate status': {
      await runMigrate('status', {
        db: parsed.options.db as string | undefined,
      });
      break;
    }
    case 'migrate up': {
      await runMigrate('up', {
        db: parsed.options.db as string | undefined,
      });
      break;
    }
    case 'migrate check': {
      await runMigrate('check', {
        db: parsed.options.db as string | undefined,
      });
      break;
    }
    case 'migrate clean-incompatible': {
      const rawTarget =
        parsed.options.targetVersion ?? parsed.options['target-version'];
      await runMigrate('clean-incompatible', {
        db: parsed.options.db as string | undefined,
        targetVersion:
          rawTarget !== undefined ? Number(rawTarget) : undefined,
      });
      break;
    }
    default:
      console.warn(`[ucsa] Unknown command: ${parsed.command}`);
      console.log(getHelpText());
      break;
  }
}

export async function runCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  await dispatchCommand(parsed);
}
