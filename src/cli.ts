import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import { applyState, describePlan, planState } from './apply.ts';
import { latestReleaseVersion } from './binary.ts';
import { compose, enableAcme, ensureProxy, proxyDown } from './docker.ts';
import { createNetwork, resetNetworkData } from './network.ts';
import { startPanel } from './panel.ts';
import { loadState } from './state.ts';
import {
  DEFAULT_IMPORT_VL_KEYS,
  NAME_RE,
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
    'testnet only: generate https/wss endpoint URLs (set XNG_ACME_EMAIL so the shared Traefik issues certificates)',
    false,
  )
  .option(
    '--root',
    'testnet only: serve the bare domain (hostnames are <sub>.<domain>, not <sub>.<name>.<domain>); one per domain',
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
    if (opts.root && opts.type !== 'testnet') {
      program.error('--root is testnet only');
    }
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
      root: opts.root,
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
  .option(
    '--acme-email <email>',
    "enable Let's Encrypt for every routed hostname (persisted in traefik/acme.env; delete that file to disable)",
  )
  .action((opts) => {
    if (opts.acmeEmail) enableAcme(opts.acmeEmail);
    ensureProxy();
  });
proxyCmd
  .command('down')
  .description('stop the shared Traefik instance')
  .action(() => proxyDown());

program
  .command('apply')
  .description(
    'converge the workspace to xng.yml: create/start/upgrade/stop/remove networks as declared (never resets)',
  )
  .addOption(
    new Option('--file <path>', 'path to xng.yml')
      .env('XNG_CONFIG')
      .default('xng.yml'),
  )
  .option('--only <name>', 'reconcile just this network', parseName)
  .option('--dry-run', 'print the plan and exit', false)
  .option(
    '--yes',
    'apply without asking (required when stdin is not a terminal, e.g. from the panel)',
    false,
  )
  .option(
    '--timeout <sec>',
    'readiness / per-node upgrade timeout in seconds',
    intArg(1),
    600,
  )
  .action(async (opts) => {
    const state = await loadState(opts.file, true);
    const plans = await planState(state, 'workspace', opts.only);
    console.log(plans.length > 0 ? describePlan(plans) : 'nothing to do');
    if (opts.dryRun || plans.length === 0) return;
    // The plan can include `remove` (down -v + rm -rf), so a human gets to
    // read it first; default is no. A non-interactive caller (the panel, a
    // script) must say --yes explicitly rather than have the prompt hang or
    // be skipped silently.
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        throw program.error('stdin is not a terminal; pass --yes to apply');
      }
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = (await rl.question('apply? [y/N] ')).trim().toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('aborted');
        process.exitCode = 1;
        return;
      }
    }
    await applyState(state, {
      only: opts.only,
      timeoutMs: opts.timeout * 1000,
    });
  });

program
  .command('panel')
  .description(
    'run a web control panel: every change edits xng.yml and runs `xng apply`',
  )
  .addOption(
    new Option('--port <n>', 'port to listen on')
      .env('XNG_PANEL_PORT')
      .argParser(intArg(1, 65535))
      .default(7777),
  )
  .addOption(
    new Option('--host <host>', 'address to bind')
      .env('XNG_PANEL_HOST')
      .default('127.0.0.1'),
  )
  .addOption(
    new Option('--file <path>', 'path to xng.yml')
      .env('XNG_CONFIG')
      .default('xng.yml'),
  )
  .addOption(
    new Option(
      '--access-team <team>',
      'Cloudflare Access team (<team>.cloudflareaccess.com); with --access-aud, requires a valid Access JWT on every request',
    ).env('XNG_ACCESS_TEAM'),
  )
  .addOption(
    new Option(
      '--access-aud <aud>',
      'Cloudflare Access application audience tag',
    ).env('XNG_ACCESS_AUD'),
  )
  .option(
    '--insecure-no-auth',
    'run without Cloudflare Access verification, serving loopback clients only (local development)',
    false,
  )
  .action(async (opts) => {
    if (!!opts.accessTeam !== !!opts.accessAud) {
      program.error('--access-team and --access-aud must be given together');
    }
    // Refusing to start is deliberate: with a cloudflared tunnel in front,
    // the tunnel's peer *is* loopback, so a forgotten env var would
    // otherwise open the panel to the internet with only a log warning.
    if (!opts.accessTeam && !opts.insecureNoAuth) {
      program.error(
        'refusing to start without --access-team/--access-aud (or --insecure-no-auth for local use)',
      );
    }
    await startPanel(opts);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
