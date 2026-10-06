import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { certHosts } from './cloudflare.ts';
import { CLI_PATH, TSX_BIN } from './docker.ts';
import {
  DEFAULT_IMPORT_VL_KEYS,
  defaultQuorum,
  explorerHostPort,
  hostPorts,
  nodeConfigLines,
  validateSpec,
} from './types.ts';
import type { NetworkSpec } from './types.ts';

// Declarative `xng.yml` -> create/upgrade/recreate/remove/start. parseXngYml,
// plan and formatPlan are pure; only runPlan touches the world.

// Same names as network.json (NetworkSpec), so there is no translation layer.
// These are also the keys compared against the on-disk network.json.
const COMPARED = [
  'type',
  'version',
  'validators',
  'quorum',
  'networkId',
  'domain',
  'tls',
  'root',
  'portOffset',
  'nodeConfig',
] as const;
const YML_KEYS: readonly string[] = COMPARED;

export function parseXngYml(text: string): NetworkSpec[] {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message}`);
  }
  const networks = (doc as { networks?: unknown } | null)?.networks;
  if (
    typeof networks !== 'object' ||
    networks === null ||
    Array.isArray(networks)
  ) {
    throw new Error('xng.yml must have a top-level `networks:` mapping');
  }

  const specs: NetworkSpec[] = [];
  for (const [name, raw] of Object.entries(networks)) {
    try {
      specs.push(toSpec(name, raw));
    } catch (err) {
      throw new Error(`network "${name}": ${(err as Error).message}`);
    }
  }
  checkAcrossNetworks(specs);
  return specs;
}

function toSpec(name: string, raw: unknown): NetworkSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('must be a mapping (`version` is required)');
  }
  const entry = raw as Record<string, unknown>;
  const unknown = Object.keys(entry).filter((k) => !YML_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown key(s) ${unknown.join(', ')} (allowed: ${YML_KEYS.join(', ')})`,
    );
  }
  if (entry.version === undefined) {
    throw new Error(
      '`version` is required (a release is never resolved implicitly, so apply stays reproducible)',
    );
  }

  // Defaults mirror `xng create`; a standalone is always one validator.
  const type = (entry.type ?? 'testnet') as NetworkSpec['type'];
  const validators = (entry.validators ??
    (type === 'standalone' ? 1 : 3)) as number;
  const spec: NetworkSpec = {
    name,
    type,
    version: entry.version as string,
    validators,
    quorum: (entry.quorum ?? defaultQuorum(validators)) as number,
    networkId: (entry.networkId ?? 21339) as number,
    domain: (entry.domain ?? '127.0.0.1.nip.io') as string,
    tls: (entry.tls ?? false) as boolean,
    root: (entry.root ?? false) as boolean,
    portOffset: (entry.portOffset ?? 0) as number,
    importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  };
  if (entry.nodeConfig !== undefined) {
    spec.nodeConfig = nodeConfigLines(entry.nodeConfig);
  }
  validateSpec(spec);
  return spec;
}

// Rules that `xng create` would only hit one network at a time, at create time.
export function checkAcrossNetworks(specs: NetworkSpec[]): void {
  const rootOf = new Map<string, string>();
  const portOwner = new Map<number, string>();
  for (const spec of specs) {
    if (spec.root) {
      const other = rootOf.get(spec.domain);
      if (other) {
        throw new Error(
          `networks "${other}" and "${spec.name}" both set root: true on domain ${spec.domain}; only one network can serve the bare domain`,
        );
      }
      rootOf.set(spec.domain, spec.name);
    }
    if (spec.type === 'standalone') {
      for (const port of [
        ...Object.values(hostPorts(spec)),
        explorerHostPort(spec),
      ]) {
        const other = portOwner.get(port);
        if (other) {
          throw new Error(
            `standalone networks "${other}" and "${spec.name}" both publish host port ${port}; give one a different portOffset`,
          );
        }
        portOwner.set(port, spec.name);
      }
    }
  }
}

export type Action = {
  name: string;
  kind: 'create' | 'remove' | 'upgrade' | 'recreate' | 'start' | 'unchanged';
  diff: { key: string; from: unknown; to: unknown }[]; // upgrade/recreate
  steps: string[][]; // xng argv, in execution order
  from?: NetworkSpec; // on-disk spec (absent for create)
  to?: NetworkSpec; // desired spec (absent for remove)
};

// Older network.json files have no `root` or `nodeConfig`; treat a missing one
// as false / {} (nodeConfig as JSON so `===` compares it by value).
function comparable(spec: NetworkSpec, key: (typeof COMPARED)[number]) {
  if (key === 'nodeConfig') return JSON.stringify(spec.nodeConfig ?? {});
  return key === 'root' ? !!spec.root : spec[key];
}

function createArgv(spec: NetworkSpec): string[] {
  return [
    'create',
    '--name',
    spec.name,
    '--type',
    spec.type,
    '--version',
    spec.version,
    '--validators',
    String(spec.validators),
    '--quorum',
    String(spec.quorum),
    '--network-id',
    String(spec.networkId),
    '--domain',
    spec.domain,
    ...(spec.tls ? ['--tls'] : []),
    ...(spec.root ? ['--root'] : []),
    '--port-offset',
    String(spec.portOffset),
    ...(spec.nodeConfig
      ? ['--node-config', JSON.stringify(spec.nodeConfig)]
      : []),
  ];
}

export function plan(
  desired: NetworkSpec[],
  actual: NetworkSpec[],
  running: Set<string>,
  opts: { only?: string[]; timeout?: number } = {},
): Action[] {
  const timeout = String(opts.timeout ?? 300);
  const startArgv = (name: string) => [
    'start',
    '--name',
    name,
    '--wait',
    '--timeout',
    timeout,
  ];

  const want = new Map(desired.map((s) => [s.name, s]));
  const have = new Map(actual.map((s) => [s.name, s]));
  for (const name of opts.only ?? []) {
    if (!want.has(name) && !have.has(name)) {
      throw new Error(
        `--network "${name}" is in neither the yml file nor workspace/`,
      );
    }
  }
  const only = opts.only?.length ? new Set(opts.only) : undefined;
  // The file-wide check in parseXngYml cannot see networks that --network
  // leaves on disk as they are; a recreate that collides with one would
  // remove the old network and then fail to create the new one.
  if (only) {
    checkAcrossNetworks([
      ...desired.filter((s) => only.has(s.name)),
      ...actual.filter((s) => !only.has(s.name)),
    ]);
  }
  const names = [...new Set([...want.keys(), ...have.keys()])]
    .filter((n) => !only || only.has(n))
    .sort();

  return names.map((name): Action => {
    const d = want.get(name);
    const a = have.get(name);
    if (d && !a) {
      return {
        name,
        kind: 'create',
        to: d,
        diff: [],
        steps: [createArgv(d), startArgv(name)],
      };
    }
    if (!d && a) {
      return {
        name,
        kind: 'remove',
        from: a,
        diff: [],
        steps: [['remove', '--name', name]],
      };
    }
    if (!d || !a) throw new Error('unreachable');

    const both = { from: a, to: d };
    const diff = COMPARED.flatMap((key) => {
      const from = comparable(a, key);
      const to = comparable(d, key);
      return from === to ? [] : [{ key, from, to }];
    });
    if (diff.length === 0) {
      return running.has(name)
        ? { name, kind: 'unchanged', diff, steps: [], ...both }
        : { name, kind: 'start', diff, steps: [startArgv(name)], ...both };
    }
    // `xng upgrade` only swaps the binary of a running testnet; anything else
    // that changed (or a standalone, which has no upgrade) needs a new network.
    if (diff.every((c) => c.key === 'version') && d.type === 'testnet') {
      return {
        name,
        kind: 'upgrade',
        ...both,
        diff,
        steps: [
          ...(running.has(name) ? [] : [startArgv(name)]),
          [
            'upgrade',
            '--name',
            name,
            '--version',
            d.version,
            '--timeout',
            timeout,
          ],
        ],
      };
    }
    return {
      name,
      kind: 'recreate',
      ...both,
      diff,
      steps: [['remove', '--name', name], createArgv(d), startArgv(name)],
    };
  });
}

// Removes first (a recreate's first step included) so that moving `root` or a
// portOffset between networks cannot trip create's own root/port checks, then
// creates (a recreate's remaining steps included), upgrades, starts. Within a
// phase, name order.
export function executionSteps(actions: Action[]): string[][] {
  // create and recreate share a rank so they interleave by name.
  const rank = {
    remove: 0,
    recreate: 1,
    create: 1,
    upgrade: 2,
    start: 3,
    unchanged: 4,
  };
  const steps = actions
    .filter((a) => a.kind !== 'unchanged')
    .sort((x, y) => rank[x.kind] - rank[y.kind] || x.name.localeCompare(y.name))
    .flatMap((a) => a.steps);
  return [
    ...steps
      .filter((s) => s[0] === 'remove')
      .sort((x, y) => (x[2] ?? '').localeCompare(y[2] ?? '')),
    ...steps.filter((s) => s[0] !== 'remove'),
  ];
}

const DISPLAY = [
  ['create', '+'],
  ['upgrade', '~'],
  ['recreate', '!'],
  ['remove', '-'],
  ['start', '^'],
  ['unchanged', '='],
] as const;

function describe(a: Action): { detail: string; note: string } {
  const changes = a.diff
    .map((c) => `${c.key} ${String(c.from)} -> ${String(c.to)}`)
    .join(', ');
  switch (a.kind) {
    case 'create':
      return { detail: a.to ? describeSpec(a.to) : '', note: '' };
    case 'upgrade':
      return {
        detail: changes,
        note:
          a.steps.length > 1
            ? '(starts it first, then rolling upgrade)'
            : '(rolling, no downtime)',
      };
    case 'recreate':
      return { detail: changes, note: '(ledger data and keys are wiped)' };
    case 'remove':
      return { detail: '', note: '(ledger data and keys are deleted)' };
    case 'start':
      return { detail: '(containers not running)', note: '' };
    default:
      return { detail: '', note: '' };
  }
}

function describeSpec(spec: NetworkSpec): string {
  if (spec.type === 'standalone') {
    return `standalone ${spec.version}, portOffset ${spec.portOffset}`;
  }
  const flags = [spec.tls && 'tls', spec.root && 'root'].filter(Boolean);
  return `testnet ${spec.version}, ${spec.validators} validator${spec.validators === 1 ? '' : 's'}, ${spec.domain}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

// With XNG_CF_ZONE (`cf`), create/recreate order an edge certificate pack and
// remove/recreate delete one (see cloudflare.ts); say so, or warn that nothing
// will happen when the variable is missing for a tls testnet.
function cloudflareBlock(
  rows: { a: Action }[],
  cf: { zone: string } | undefined,
): string[] {
  const ordered = rows.filter(
    ({ a }) => ['create', 'recreate'].includes(a.kind) && isTlsTestnet(a.to),
  );
  const deleted = rows.filter(
    ({ a }) => ['remove', 'recreate'].includes(a.kind) && isTlsTestnet(a.from),
  );
  if (!cf) {
    const parts = [
      ordered.length &&
        `ordered for ${ordered.map((r) => r.a.name).join(', ')}`,
      deleted.length &&
        `deleted for ${deleted.map((r) => r.a.name).join(', ')}`,
    ].filter(Boolean);
    return parts.length
      ? [
          '',
          `cloudflare: XNG_CF_ZONE is not set, so no edge certificate will be ${parts.join(' or ')} (see README "Cloudflare only")`,
        ]
      : [];
  }
  const lines = rows.flatMap(({ a }) =>
    (['from', 'to'] as const).flatMap((side) => {
      const spec = a[side];
      const applies =
        side === 'from'
          ? ['remove', 'recreate'].includes(a.kind)
          : ['create', 'recreate'].includes(a.kind);
      if (!spec || !applies) return [];
      let hosts: string[] | undefined;
      try {
        hosts = certHosts(spec, cf.zone);
      } catch (err) {
        // An on-disk network outside the zone has no pack to delete (`xng
        // remove` only warns then); a desired one was already validated.
        if (side === 'to') throw err;
      }
      if (!hosts) return [];
      const verb = side === 'from' ? 'deleted' : 'ordered';
      return [
        [
          `${side === 'from' ? '-' : '+'} certificate ${hosts[1]}`,
          `(${a.name}: ${verb} by ${a.kind})`,
        ],
      ];
    }),
  );
  const w = Math.max(0, ...lines.map(([cert]) => cert?.length ?? 0));
  return lines.length
    ? [
        '',
        `cloudflare (XNG_CF_ZONE=${cf.zone}):`,
        ...lines.map(([cert, note]) => `  ${cert?.padEnd(w)}   ${note}`),
      ]
    : [];
}

// Without a zone the apex is unknown, but a root network normally sits on
// it and needs no pack of its own, so it is left out of the warning.
function isTlsTestnet(spec?: NetworkSpec): boolean {
  return spec?.type === 'testnet' && spec.tls && !spec.root;
}

export function formatPlan(
  actions: Action[],
  file = 'xng.yml',
  cf?: { zone: string },
): string {
  const counts = DISPLAY.filter(([k]) => k !== 'unchanged')
    .map(([k]) => [k, actions.filter((a) => a.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} to ${k}`);
  const head = `xng apply: ${file}${counts.length ? ` -> ${counts.join(', ')}` : ''}`;

  const rows = DISPLAY.flatMap(([kind, sym]) =>
    actions
      .filter((a) => a.kind === kind)
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((a) => ({ a, sym, ...describe(a) })),
  );
  const nameW = Math.max(0, ...rows.map((r) => r.a.name.length));
  const lines = rows.map((r) =>
    [r.sym, r.a.name.padEnd(nameW), r.a.kind.padEnd(9), r.detail, r.note]
      .filter((part) => part !== '')
      .join(' ')
      .trimEnd(),
  );
  return [head, '', ...lines, ...cloudflareBlock(rows, cf)].join('\n');
}

// Unlike network.ts's otherSpecs (which create's collision checks use and which
// skips what it cannot read), apply is about to remove or recreate whatever it
// finds, so a directory that is not a valid network aborts instead of being
// mistaken for "absent" or for a network that differs.
export async function readWorkspace(dir = 'workspace'): Promise<NetworkSpec[]> {
  const specs: NetworkSpec[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const spec = JSON.parse(
        await readFile(join(dir, entry.name, 'network.json'), 'utf8'),
      );
      if (spec?.name !== entry.name) {
        throw new Error(`name is "${spec?.name}", expected "${entry.name}"`);
      }
      // network.json files from before --port-offset existed lack it.
      spec.portOffset ??= 0;
      validateSpec(spec);
      specs.push(spec);
    } catch (err) {
      throw new Error(
        `workspace/${entry.name} is not a valid network (${(err as Error).message}); fix or remove that directory by hand before running xng apply`,
      );
    }
  }
  return specs;
}

// Runs each step as a child `xng` (see docker.ts for why). Stops at the first
// failure: re-running apply recomputes from the real state, so there is no
// rollback to get wrong. Returns whether every step succeeded.
export function runPlan(actions: Action[]): boolean {
  const steps = executionSteps(actions);
  const label = (s: string[]) => `xng ${s.join(' ')}`;
  for (const [i, step] of steps.entries()) {
    console.log(`$ ${label(step)}`);
    const result = spawnSync(TSX_BIN, [CLI_PATH, ...step], {
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) {
      const why = result.error
        ? result.error.message
        : `exited with code ${result.status ?? result.signal}`;
      console.error(
        `\nfailed at step ${i + 1}/${steps.length}: ${label(step)} (${why}); re-run xng apply to continue`,
      );
      return false;
    }
  }
  return true;
}
