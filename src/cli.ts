import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import {
  formatPlan,
  parseXngYml,
  plan,
  readWorkspace,
  runPlan,
} from './apply.ts';
import { fetchBinary, latestReleaseVersion } from './binary.ts';
import {
  certHosts,
  cfConfigFromEnv,
  ensureCertificate,
  removeCertificate,
} from './cloudflare.ts';
import { renderCompose } from './compose.ts';
import {
  compose,
  enableAcme,
  ensureProxy,
  listContainers,
  proxyDown,
} from './docker.ts';
import { report, runChecks } from './doctor.ts';
import {
  createNetwork,
  ensureNodeLogDir,
  refreshPwaGateway,
  resetNetworkData,
} from './network.ts';
import { startPanel } from './panel.ts';
import {
  DEFAULT_IMPORT_VL_KEYS,
  DOMAIN_RE,
  NAME_RE,
  configSections,
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

// --node-config / --validator-config: JSON -> section -> lines.
function parseConfigFlag(
  key: 'nodeConfig' | 'validatorConfig',
  json: string,
): Record<string, string[]> {
  const flag = key === 'nodeConfig' ? '--node-config' : '--validator-config';
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${flag}: invalid JSON: ${(err as Error).message}`);
  }
  return configSections(key, raw);
}

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
  if (ep.pwa) console.log(`  pwa:      ${ep.pwa}`);
  if (ep.debugstream) console.log(`  debugstream: ${ep.debugstream}`);
  if (ep.rpcAdmin) console.log(`  rpc admin: ${ep.rpcAdmin}`);
  if (ep.wsAdmin) console.log(`  ws admin:  ${ep.wsAdmin}`);
}

// Cloudflare mode (XNG_CF_ZONE set, see cloudflare.ts): make sure the
// network's edge certificate exists and is active. On `create` a failure is
// an error (the URLs just printed would fail TLS); on `start`/`reset` it only
// warns, so a Cloudflare API hiccup never keeps a network from starting.
async function syncCertificate(
  spec: NetworkSpec,
  { fatal }: { fatal: boolean },
): Promise<void> {
  const cfg = cfConfigFromEnv();
  if (!cfg) return;
  try {
    await ensureCertificate(spec, cfg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (fatal) throw err;
    console.warn(`warning: ${message}`);
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
    'testnet only: generate https/wss endpoint URLs (certificates come from `xng proxy up --acme-email`, or from Cloudflare when XNG_CF_ZONE is set)',
    false,
  )
  .option(
    '--root',
    'testnet only: serve the bare domain (hostnames are <sub>.<domain>, not <sub>.<name>.<domain>); one per domain',
    false,
  )
  .option(
    '--pwa',
    'testnet only: serve on-ledger AppLoader documents (xahaud PR #793 `protocol = pwa`) at pwa.<name>.<domain> through Traefik',
    false,
  )
  .option(
    '--port-offset <n>',
    'standalone only: shift every published host port by this amount',
    intArg(0, 14300),
    0,
  )
  .option(
    '--node-config <json>',
    'node only: extra/overriding xahaud.cfg sections as JSON, {"section": "line" | ["lines"] | {"key": "value"}}',
  )
  .option(
    '--validator-config <json>',
    'testnet validators only: extra/overriding xahaud.cfg sections as JSON, same shape as --node-config',
  )
  .action(async (opts) => {
    // A standalone is always one validator; validateSpec (below) covers the
    // rest, so `create` and `apply` accept exactly the same specs.
    const validators = opts.type === 'standalone' ? 1 : opts.validators;
    const quorum = opts.quorum ?? defaultQuorum(validators);
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
      pwa: opts.pwa,
      portOffset: opts.portOffset,
      importVlKeys: DEFAULT_IMPORT_VL_KEYS,
    };
    if (opts.nodeConfig !== undefined) {
      spec.nodeConfig = parseConfigFlag('nodeConfig', opts.nodeConfig);
    }
    if (opts.validatorConfig !== undefined) {
      spec.validatorConfig = parseConfigFlag(
        'validatorConfig',
        opts.validatorConfig,
      );
    }

    // Fail before generating anything if the domain is outside the zone.
    const cfg = cfConfigFromEnv();
    if (cfg) certHosts(spec, cfg.zone);

    const dir = await createNetwork(spec);
    printEndpoints(spec, dir);
    try {
      await syncCertificate(spec, { fatal: true });
    } catch (err) {
      throw new Error(
        `network "${spec.name}" was created, but its Cloudflare certificate is not ready: ${err instanceof Error ? err.message : err}`,
      );
    }
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
    await refreshPwaGateway(spec, `workspace/${opts.name}`);
    await ensureNodeLogDir(spec, `workspace/${opts.name}`);
    // --build so a changed faucet/ is always rebuilt; a no-op when unchanged.
    compose(opts.name, ['up', '-d', '--build']);
    await syncCertificate(spec, { fatal: false });
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
    await refreshPwaGateway(spec, `workspace/${opts.name}`);
    await ensureNodeLogDir(spec, `workspace/${opts.name}`);
    compose(opts.name, ['up', '-d', '--build']);
    await syncCertificate(spec, { fatal: false });
    if (opts.wait) {
      await waitForNetwork(spec, opts.timeout * 1000);
    }
  });

program
  .command('remove')
  .description('docker compose down -v + delete the network directory')
  .requiredOption('--name <name>', 'network name', parseName)
  .action(async (opts) => {
    // A failed teardown must abort: deleting the directory would orphan the
    // containers/volumes. Only a half-created network (no compose.yml) skips it.
    if (existsSync(`workspace/${opts.name}/compose.yml`)) {
      compose(opts.name, ['down', '-v']);
    } else {
      console.warn(
        `network "${opts.name}" is half-created (no compose.yml); removing the directory only`,
      );
    }
    // Before deleting the directory: network.json is what says which
    // certificate pack belongs to this network.
    const cfg = cfConfigFromEnv();
    if (cfg) {
      try {
        const spec: NetworkSpec = JSON.parse(
          await readFile(`workspace/${opts.name}/network.json`, 'utf8'),
        );
        await removeCertificate(spec, cfg);
      } catch (err) {
        console.warn(
          `warning: could not remove the Cloudflare certificate: ${err instanceof Error ? err.message : err}`,
        );
      }
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
  .command('apply')
  .description(
    'make workspace/ match an xng.yml: show the plan, then create/upgrade/recreate/remove/start networks (networks not in the file are removed)',
  )
  .option('-f, --file <path>', 'desired networks', 'xng.yml')
  .option('-y, --yes', 'apply without asking for confirmation', false)
  .option('--dry-run', 'print the plan and exit; change nothing', false)
  .option(
    '--timeout <sec>',
    'readiness timeout in seconds for each start/upgrade',
    intArg(1),
    300,
  )
  .option(
    '--network <name>',
    'only plan this network (repeatable); others are neither created nor removed',
    (value: string, prev: string[]) => [...prev, parseName(value)],
    [] as string[],
  )
  .action(async (opts) => {
    // Everything is validated before anything runs: a recreate removes the old
    // network first, so a spec that only fails at create time would lose it.
    const desired = parseXngYml(await readFile(opts.file, 'utf8'));
    const cfg = cfConfigFromEnv();
    if (cfg) for (const spec of desired) certHosts(spec, cfg.zone);

    // listContainers throws when docker is down, which must abort rather than
    // read as "nothing is running".
    const running = new Set<string>();
    for (const [project, list] of await listContainers()) {
      // Every service is long-lived (restart: unless-stopped), so any
      // container that is not running means the network needs `start`.
      if (list.length > 0 && list.every((c) => c.state === 'running')) {
        running.add(project);
      }
    }

    const actions = plan(desired, await readWorkspace(), running, {
      only: opts.network,
      timeout: opts.timeout,
    });
    console.log(formatPlan(actions, opts.file, cfg));

    const todo = actions.filter((a) => a.kind !== 'unchanged');
    if (todo.length === 0) {
      const n = actions.length;
      console.log(
        `\nno changes (${n} network${n === 1 ? '' : 's'} up to date)`,
      );
      return;
    }
    if (opts.dryRun) return;

    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        throw program.error('refusing to prompt without a TTY; pass -y');
      }
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = (await rl.question('\nApply? [y/N] '))
        .trim()
        .toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') throw program.error('aborted');
    }
    // A version that does not exist would otherwise only fail inside a child
    // `xng create`, after every remove already ran. Downloads are cached, and
    // create would fetch them anyway.
    const versions = new Set(
      actions.flatMap((a) =>
        a.steps.flatMap((s) => {
          const v = s[s.indexOf('--version') + 1];
          return s.includes('--version') && v ? [v] : [];
        }),
      ),
    );
    for (const version of versions) {
      console.log(`fetching xahaud ${version}`);
      await fetchBinary(version);
    }
    console.log();
    if (!runPlan(actions)) process.exit(1);
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
  .command('panel')
  .description(
    'run a web control panel (create/start/stop/reset/remove/upgrade/vote + live status)',
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
    new Option(
      '--domain <domain>',
      'domain for networks created from the panel (per-network hostnames are <sub>.<name>.<domain>)',
    )
      .env('XNG_DOMAIN')
      .argParser(parseDomain)
      .default('127.0.0.1.nip.io'),
  )
  .addOption(
    new Option(
      '--tls',
      'networks created from the panel get --tls (see `xng create --tls`); or XNG_TLS=1',
    )
      // Not .env(): commander treats a boolean env var as set whenever the
      // name exists, so XNG_TLS=false/0 would turn TLS *on*.
      .default(['1', 'true'].includes(process.env.XNG_TLS ?? '')),
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

program
  .command('doctor')
  .description(
    'check that everything xng needs is installed and reachable, and show the state of optional features',
  )
  .action(async () => {
    if (!report(await runChecks())) process.exit(1);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
