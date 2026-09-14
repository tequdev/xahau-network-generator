import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Command, InvalidArgumentError, Option } from 'commander';
import { latestReleaseVersion } from './binary.ts';
import { compose } from './docker.ts';
import { createNetwork, resetNetworkData } from './network.ts';
import {
  DEFAULT_IMPORT_VL_KEYS,
  explorerHostPort,
  faucetHostPort,
  hostPorts,
} from './types.ts';
import type { NetworkSpec } from './types.ts';
import { waitForNetwork } from './wait.ts';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();
program
  .name('xng')
  .description('generate and run disposable Xahau testnet/standalone networks')
  .version(pkg.version);
// So a subcommand's own `--version <ver>` (the xahaud release) doesn't get
// swallowed by the program's own `-V/--version` flag.
program.enablePositionalOptions();

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

// The name becomes a directory under workspace/ and the compose project name,
// so it must be path-safe and something compose will not silently normalize.
function parseName(value: string): string {
  if (!NAME_RE.test(value)) {
    throw new InvalidArgumentError(
      `--name must match ${NAME_RE} (lowercase, digits, "-", "_"), got "${value}"`,
    );
  }
  return value;
}

function intArg(min: number, max = Number.POSITIVE_INFINITY) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(
        `must be an integer in [${min}, ${max === Number.POSITIVE_INFINITY ? '...' : max}], got "${value}"`,
      );
    }
    return n;
  };
}

async function loadSpec(name: string): Promise<NetworkSpec> {
  const path = `workspace/${name}/network.json`;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // `throw` here (rather than a bare statement) is what lets TS see this
    // catch block as diverging, since `never`-returning methods (unlike
    // plain functions) aren't narrowed for control flow by themselves.
    throw program.error(`no network named "${name}" found (expected ${path})`);
  }
}

function printEndpoints(spec: NetworkSpec, dir: string): void {
  const primaryHost = hostPorts(spec);
  console.log(`created network "${spec.name}" at ${dir}`);
  console.log(`  rpc:      http://localhost:${primaryHost.rpcPublic}`);
  console.log(`  ws:       ws://localhost:${primaryHost.wsPublic}`);
  console.log(`  explorer: http://localhost:${explorerHostPort(spec)}`);
  if (spec.type === 'testnet') {
    console.log(`  faucet:   http://localhost:${faucetHostPort(spec)}`);
  }
}

program
  .command('create')
  .description('generate a new network under workspace/<name>')
  .requiredOption('--name <name>', 'network name', parseName)
  .addOption(
    new Option('--type <type>', 'network type')
      .choices(['testnet', 'standalone'])
      .default('testnet'),
  )
  .option('--version <ver>', 'xahaud version (default: latest release)')
  .option(
    '--validators <n>',
    'validator count (testnet only; standalone is always 1)',
    intArg(1),
    3,
  )
  .option(
    '--quorum <n>',
    'consensus quorum (default: ceil(0.8 * validators))',
    intArg(1),
  )
  .option('--network-id <n>', 'network id', intArg(0), 21339)
  .option(
    '--port-offset <n>',
    'shift every host port by this amount',
    intArg(0, 14300),
    0,
  )
  .action(async (opts) => {
    const validators = opts.type === 'standalone' ? 1 : opts.validators;
    const quorum = opts.quorum ?? Math.ceil(0.8 * validators);
    if (quorum < 1 || quorum > validators) {
      program.error(
        `--quorum must be an integer in [1, ${validators}], got "${quorum}"`,
      );
    }
    const version = opts.version ?? (await latestReleaseVersion());

    const spec: NetworkSpec = {
      name: opts.name,
      type: opts.type,
      version,
      validators,
      quorum,
      networkId: opts.networkId,
      portOffset: opts.portOffset,
      importVlKeys: DEFAULT_IMPORT_VL_KEYS,
    };

    const dir = await createNetwork(spec);
    printEndpoints(spec, dir);
  });

program
  .command('start')
  .description(
    'docker compose up -d --build for an existing network (+ optionally wait for readiness)',
  )
  .requiredOption('--name <name>', 'network name', parseName)
  .option('--wait', 'wait for the network to become ready', false)
  .option('--timeout <sec>', 'readiness timeout in seconds', intArg(1), 300)
  .action(async (opts) => {
    const spec = await loadSpec(opts.name);
    // --build so a changed faucet/ is always rebuilt; a no-op when unchanged.
    compose(opts.name, ['up', '-d', '--build']);
    if (opts.wait) {
      await waitForNetwork(spec, opts.timeout * 1000);
    }
  });

program
  .command('stop')
  .description('docker compose down')
  .requiredOption('--name <name>', 'network name', parseName)
  .action((opts) => {
    compose(opts.name, ['down']);
  });

program
  .command('reset')
  .description('stop, wipe ledger data, start again from genesis')
  .requiredOption('--name <name>', 'network name', parseName)
  .option('--wait', 'wait for the network to become ready', false)
  .option('--timeout <sec>', 'readiness timeout in seconds', intArg(1), 300)
  .action(async (opts) => {
    const spec = await loadSpec(opts.name);
    compose(opts.name, ['down']);
    await resetNetworkData(`workspace/${opts.name}`);
    compose(opts.name, ['up', '-d', '--build']);
    if (opts.wait) {
      await waitForNetwork(spec, opts.timeout * 1000);
    }
  });

program
  .command('remove')
  .description('docker compose down -v + delete the network directory')
  .requiredOption('--name <name>', 'network name', parseName)
  .action(async (opts) => {
    try {
      compose(opts.name, ['down', '-v']);
    } catch (err) {
      // A half-created network has no compose.yml; still remove the directory.
      console.warn(err instanceof Error ? err.message : err);
    }
    await rm(`workspace/${opts.name}`, { recursive: true, force: true });
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
