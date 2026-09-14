import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Command, InvalidArgumentError, Option } from 'commander';
import { latestReleaseVersion } from './binary.ts';
import { renderCompose } from './compose.ts';
import { compose, ensureProxy, proxyDown } from './docker.ts';
import { createNetwork, resetNetworkData } from './network.ts';
import {
  DEFAULT_IMPORT_VL_KEYS,
  defaultQuorum,
  endpoints,
  nodeName,
} from './types.ts';
import type { NetworkSpec } from './types.ts';
import { upgradeNetwork } from './upgrade.ts';
import { voteAmendment } from './vote.ts';
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

const DOMAIN_RE = /^[a-z0-9.-]+$/;

function parseDomain(value: string): string {
  if (!DOMAIN_RE.test(value)) {
    throw new InvalidArgumentError(
      `--domain must match ${DOMAIN_RE} (lowercase letters, digits, dots, hyphens), got "${value}"`,
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
  const ep = endpoints(spec);
  console.log(`created network "${spec.name}" at ${dir}`);
  console.log(`  rpc:      ${ep.rpc}`);
  console.log(`  ws:       ${ep.ws}`);
  console.log(`  explorer: ${ep.explorer}`);
  if (ep.faucet) console.log(`  faucet:   ${ep.faucet}`);
  if (ep.vl) console.log(`  vl:       ${ep.vl}`);
  if (ep.rpcAdmin) console.log(`  rpc admin: ${ep.rpcAdmin}`);
  if (ep.wsAdmin) console.log(`  ws admin:  ${ep.wsAdmin}`);
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
    'consensus quorum (default: min(ceil(0.8 * validators), validators - 1), so one validator can restart without pausing consensus)',
    intArg(1),
  )
  .option('--network-id <n>', 'network id', intArg(0), 21339)
  .option(
    '--domain <domain>',
    'testnet only: base domain for Traefik routing (per-network hostnames are <sub>.<name>.<domain>)',
    parseDomain,
    '127.0.0.1.nip.io',
  )
  .option(
    '--tls',
    'testnet only: generate https/wss endpoint URLs; enable ACME in traefik/compose.yml yourself',
    false,
  )
  .option(
    '--port-offset <n>',
    'standalone only: shift every published host port by this amount',
    intArg(0, 14300),
    0,
  )
  .action(async (opts) => {
    const validators = opts.type === 'standalone' ? 1 : opts.validators;
    if (validators === 2) {
      program.error(
        '--validators must be 1 or >= 3; a 2-validator network cannot tolerate a rolling restart',
      );
    }
    const quorum = opts.quorum ?? defaultQuorum(validators);
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
      domain: opts.domain,
      tls: opts.tls,
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
    if (spec.type === 'testnet') ensureProxy();
    // compose.yml is a pure function of network.json, so re-rendering here
    // lets networks created by an older xng pick up compose changes (e.g.
    // the restart policy) on their next start.
    await writeFile(`workspace/${opts.name}/compose.yml`, renderCompose(spec));
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
    if (spec.type === 'testnet') ensureProxy();
    await writeFile(`workspace/${opts.name}/compose.yml`, renderCompose(spec));
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

program
  .command('upgrade')
  .description(
    'rolling upgrade of the xahaud binary on a running testnet, one node at a time',
  )
  .requiredOption('--name <name>', 'network name', parseName)
  .requiredOption('--version <ver>', 'xahaud version to upgrade to')
  .option(
    '--timeout <sec>',
    'per-node readiness timeout in seconds',
    intArg(1),
    300,
  )
  .action(async (opts) => {
    const spec = await loadSpec(opts.name);
    if (spec.type !== 'testnet') {
      throw program.error(
        'xng upgrade is testnet only; use `xng remove`/`create` for standalone',
      );
    }
    const services = Array.from({ length: spec.validators + 1 }, (_, i) =>
      nodeName(spec, i),
    );
    console.log(
      `upgrading ${spec.name}: ${services.join(', ')} -> ${opts.version}`,
    );
    await upgradeNetwork(spec, opts.version, opts.timeout * 1000);
    console.log(`upgraded network "${spec.name}" to ${opts.version}`);
  });

program
  .command('vote')
  .description(
    'make every validator of a running testnet vote for (or veto) an amendment',
  )
  .requiredOption('--name <name>', 'network name', parseName)
  .requiredOption('--amendment <name|hash>', 'amendment name or hash')
  .option('--reject', 'veto instead of accept', false)
  .action(async (opts) => {
    const spec = await loadSpec(opts.name);
    if (spec.type !== 'testnet') {
      throw program.error('xng vote is testnet only');
    }
    voteAmendment(spec, opts.amendment, opts.reject ? 'reject' : 'accept');
  });

const proxyCmd = program
  .command('proxy')
  .description(
    'manage the shared Traefik reverse proxy every network routes through',
  );
proxyCmd
  .command('up')
  .description('create the shared proxy network and start Traefik')
  .action(() => ensureProxy());
proxyCmd
  .command('down')
  .description('stop the shared Traefik instance')
  .action(() => proxyDown());

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
