import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import {
  composeDrifted,
  formatPlan,
  parseXngYml,
  plan,
  readWorkspace,
  runPlan,
  unsafeConfigChanges,
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
  staleProjects,
} from './docker.ts';
import { report, runChecks } from './doctor.ts';
import {
  createNetwork,
  ensureNodeLogDir,
  refreshPwaGateway,
  resetNetworkData,
  writeSiteIndex,
} from './network.ts';
import { rotateValidators } from './rotate.ts';
import {
  DEFAULT_IMPORT_VL_KEYS,
  DOMAIN_RE,
  IMPORT_VL_KEY_RE,
  NAME_RE,
  configSections,
  defaultQuorum,
  endpoints,
  nodeName,
  validateSpec,
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

function keysArg(value: string): string[] {
  const keys = value
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of keys) {
    if (!IMPORT_VL_KEY_RE.test(k)) {
      throw new InvalidArgumentError(
        `must be comma-separated 33-byte hex public keys, got "${k}"`,
      );
    }
  }
  return keys;
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
  let spec: NetworkSpec;
  try {
    spec = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // `throw` here (rather than a bare statement) is what lets TS see this
    // catch block as diverging, since `never`-returning methods (unlike
    // plain functions) aren't narrowed for control flow by themselves.
    throw program.error(`no network named "${name}" found (expected ${path})`);
  }
  // network.json files from before --port-offset existed lack it (as in
  // readWorkspace); hostPorts would otherwise render NaN into compose.yml.
  spec.portOffset ??= 0;
  return spec;
}

// Stubs for networks on another host have nothing to start, stop or upgrade.
function assertLocal(spec: NetworkSpec): void {
  if (spec.external) {
    program.error(`network "${spec.name}" is external (runs on another host)`);
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
  .addOption(
    new Option(
      '--external',
      "testnet only: register a network that runs on another host so it appears on this host's landing page; writes network.json only (only --domain and --tls apply)",
    )
      .default(false)
      // Anything else baked into the stub would make `apply` see a difference
      // against the yml and recreate it.
      .conflicts([
        'version',
        'validators',
        'quorum',
        'networkId',
        'portOffset',
        'nodeConfig',
        'validatorConfig',
        'importVlKeys',
      ]),
  )
  .option(
    '--display-name <text>',
    'testnet only: landing-page section heading (default: the network name, `main` for root)',
  )
  .option(
    '--display-short-name <text>',
    'testnet only: landing-page nav link and faucet pill (default: the display name)',
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
  .option(
    '--import-vl-keys <keys>',
    'comma-separated hex public keys of the validator lists trusted for Import (default: the XRPL Testnet UNL publisher)',
    keysArg,
    DEFAULT_IMPORT_VL_KEYS,
  )
  .action(async (opts) => {
    // A standalone is always one validator; validateSpec (below) covers the
    // rest, so `create` and `apply` accept exactly the same specs.
    const validators = opts.type === 'standalone' ? 1 : opts.validators;
    const quorum = opts.quorum ?? defaultQuorum(validators);
    const version = opts.external
      ? ''
      : (opts.version ?? (await latestReleaseVersion()));

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
      pwa: opts.type === 'testnet',
      external: opts.external,
      portOffset: opts.portOffset,
      importVlKeys: opts.importVlKeys,
      displayName: opts.displayName,
      displayShortName: opts.displayShortName,
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
    if (cfg && !spec.external) certHosts(spec, cfg.zone);

    const dir = await createNetwork(spec);
    await writeSiteIndex();
    printEndpoints(spec, dir);
    if (spec.external) return;
    try {
      await syncCertificate(spec, { fatal: true });
    } catch (err) {
      throw new Error(
        `network "${spec.name}" was created, but its Cloudflare certificate is not ready: ${err instanceof Error ? err.message : err}`,
      );
    }
  });

program
  .command('label')
  .description(
    'set the landing-page display/short name of an existing network (an empty value clears it); never recreates the network',
  )
  .requiredOption('--name <name>', 'network name', parseName)
  .option('--display-name <text>', 'section heading ("" clears)')
  .option('--display-short-name <text>', 'nav link and faucet pill ("" clears)')
  .action(async (opts) => {
    if (opts.displayName === undefined && opts.displayShortName === undefined) {
      program.error('pass --display-name and/or --display-short-name');
    }
    const spec = await loadSpec(opts.name);
    for (const [key, v] of [
      ['displayName', opts.displayName],
      ['displayShortName', opts.displayShortName],
    ] as const) {
      if (v === '') delete spec[key];
      else if (v !== undefined) spec[key] = v;
    }
    validateSpec(spec);
    await writeFile(
      `workspace/${opts.name}/network.json`,
      JSON.stringify(spec, null, 2),
    );
    await writeSiteIndex();
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
    assertLocal(spec);
    if (spec.type === 'testnet') ensureProxy();
    // compose.yml is a pure function of network.json, so re-rendering here
    // lets networks created by an older xng pick up compose changes (e.g.
    // the restart policy) on their next start.
    await writeFile(`workspace/${opts.name}/compose.yml`, renderCompose(spec));
    await writeSiteIndex(); // before `up`: the root's ./site mount must exist
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
  .action(async (opts) => {
    assertLocal(await loadSpec(opts.name));
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
    assertLocal(spec);
    compose(opts.name, ['down']);
    await resetNetworkData(`workspace/${opts.name}`);
    if (spec.type === 'testnet') ensureProxy();
    await writeFile(`workspace/${opts.name}/compose.yml`, renderCompose(spec));
    await writeSiteIndex();
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
    // network.json says whether this is an external stub (nothing to tear
    // down) and which certificate pack belongs to the network, so it is read
    // before anything is deleted.
    const spec: NetworkSpec | undefined = await readFile(
      `workspace/${opts.name}/network.json`,
      'utf8',
    )
      .then(JSON.parse)
      .catch(() => undefined);
    // A failed teardown must abort: deleting the directory would orphan the
    // containers/volumes. Only a half-created network (no compose.yml) skips it.
    if (existsSync(`workspace/${opts.name}/compose.yml`)) {
      compose(opts.name, ['down', '-v']);
    } else if (!spec?.external) {
      console.warn(
        `network "${opts.name}" is half-created (no compose.yml); removing the directory only`,
      );
    }
    const cfg = cfConfigFromEnv();
    if (cfg && !spec?.external) {
      try {
        if (!spec) throw new Error('network.json is unreadable');
        await removeCertificate(spec, cfg);
      } catch (err) {
        console.warn(
          `warning: could not remove the Cloudflare certificate: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    await rm(`workspace/${opts.name}`, { recursive: true, force: true });
    await writeSiteIndex();
  });

program
  .command('upgrade')
  .description(
    'rolling upgrade of a running testnet, one node at a time: swap the xahaud binary and/or rewrite xahaud.cfg (nodeConfig/validatorConfig; --pwa migrates a network created before pwa was always on); with the current binary and unchanged validatorConfig only `node` is restarted',
  )
  .requiredOption('--name <name>', 'network name', parseName)
  .option('--version <ver>', 'xahaud version to upgrade to (default: current)')
  .option(
    '--node-config <json>',
    'replace nodeConfig (see create); {} removes it',
  )
  .option(
    '--validator-config <json>',
    'replace validatorConfig (see create); {} removes it',
  )
  .option(
    '--import-vl-keys <keys>',
    'replace importVlKeys: comma-separated hex public keys of the validator lists trusted for Import (empty = none)',
    keysArg,
  )
  .option('--pwa', 'enable the pwa port on a network.json that predates it')
  .option(
    '--timeout <sec>',
    'per-node readiness timeout in seconds',
    intArg(1),
    300,
  )
  .action(async (opts) => {
    const spec = await loadSpec(opts.name);
    assertLocal(spec);
    if (spec.type !== 'testnet') {
      throw program.error(
        'xng upgrade is testnet only; use `xng remove`/`create` for standalone',
      );
    }
    const version: string = opts.version ?? spec.version;
    const before = { ...spec };
    for (const [key, flag] of [
      ['nodeConfig', opts.nodeConfig],
      ['validatorConfig', opts.validatorConfig],
    ] as const) {
      if (flag === undefined) continue;
      const sections = parseConfigFlag(key, flag);
      if (Object.keys(sections).length === 0) delete spec[key];
      else spec[key] = sections;
    }
    if (opts.importVlKeys !== undefined) spec.importVlKeys = opts.importVlKeys;
    if (opts.pwa) spec.pwa = true;
    const unsafe = unsafeConfigChanges(before, spec);
    if (unsafe.length > 0) {
      throw program.error(
        `${unsafe.join(', ')} cannot change in place; use xng remove + create`,
      );
    }
    const nodeOnly =
      version === before.version &&
      JSON.stringify(before.validatorConfig ?? {}) ===
        JSON.stringify(spec.validatorConfig ?? {}) &&
      JSON.stringify(before.importVlKeys) === JSON.stringify(spec.importVlKeys);
    const services = Array.from(
      { length: nodeOnly ? 1 : spec.validators + 1 },
      (_, i) => nodeName(spec, i),
    );
    console.log(
      `upgrading ${spec.name}: ${services.join(', ')} -> ${version} (xahaud.cfg rewritten)`,
    );
    await upgradeNetwork(spec, version, opts.timeout * 1000, { nodeOnly });
    await writeSiteIndex(); // the root's networks.json lists versions
    // A pwa network's Cloudflare pack also needs `*.pwa.<base>`;
    // ensureCertificate is idempotent otherwise.
    await syncCertificate(spec, { fatal: false });
    console.log(`upgraded network "${spec.name}" to ${version}`);
  });

program
  .command('rotate')
  .description(
    'replace validators of a running testnet: start new ones, publish a VL with old + new, wait until the new ones are trusted and proposing, publish the final VL, then stop and delete the removed ones (default: rotate every validator)',
  )
  .requiredOption('--name <name>', 'network name', parseName)
  .option('--add <n>', 'number of new validators to add', intArg(0))
  .option(
    '--remove <names>',
    'comma-separated validators to remove, e.g. v1,v2',
    (value: string) => {
      const names = value
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      for (const n of names) {
        if (!/^v[0-9]+$/.test(n)) {
          throw new InvalidArgumentError(
            `must be validator names like v1, got "${n}"`,
          );
        }
      }
      return names;
    },
  )
  .option('--timeout <sec>', 'overall timeout in seconds', intArg(1), 600)
  .action(async (opts) => {
    const spec = await loadSpec(opts.name);
    assertLocal(spec);
    if (spec.type !== 'testnet') {
      throw program.error('xng rotate is testnet only');
    }
    const full = opts.add === undefined && opts.remove === undefined;
    const add: number = full ? spec.validators : (opts.add ?? 0);
    const remove: string[] = full
      ? Array.from({ length: spec.validators }, (_, i) => nodeName(spec, i + 1))
      : (opts.remove ?? []);
    const final = await rotateValidators(
      spec,
      { add, remove },
      opts.timeout * 1000,
    );
    console.log(
      `rotated network "${spec.name}": validators ${Array.from({ length: final.validators }, (_, i) => nodeName(final, i + 1)).join(', ')}`,
    );
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
    if (cfg) {
      for (const spec of desired) if (!spec.external) certHosts(spec, cfg.zone);
    }

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

    // Networks whose compose.yml would render differently, or that run an image
    // older than the one pulled locally: `start` fixes both.
    const stale = await staleProjects();
    const actual = await readWorkspace();
    for (const spec of actual) {
      if (await composeDrifted(spec, `workspace/${spec.name}`)) {
        stale.add(spec.name);
      }
    }

    const actions = plan(desired, actual, running, {
      stale,
      only: opts.network,
      timeout: opts.timeout,
    });
    console.log(formatPlan(actions, opts.file, cfg));

    // The landing page is a repo asset, not part of any spec, so a site/ edit
    // never shows in the plan. Copy it (and the network list) on every run;
    // nginx serves the bind mount, so no restart is needed. Not in dry-run:
    // "change nothing" includes this.
    if (!opts.dryRun) await writeSiteIndex();

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
    assertLocal(spec);
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
