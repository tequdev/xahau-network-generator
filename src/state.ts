import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';
import {
  DEFAULT_IMPORT_VL_KEYS,
  NAME_RE,
  RESERVED_NAMES,
  defaultQuorum,
} from './types.ts';
import type { NetworkSpec } from './types.ts';

// xng.toml: the declared set of networks. `xng apply` (and every panel
// action, which is an edit to this file followed by an apply) converges the
// workspace to it. Only the fields an operator would set by hand live here;
// everything else (keys, genesis, compose.yml) is derived at create time.
//
//   domain = "xahau-dev.net"
//   tls = true
//   acme_email = "you@example.com"
//
//   [networks.jshooks]
//   version = "2026.9.8-jshooks+3640"
//   validators = 3
//
//   [networks.dev]
//   version = "2026.9.9-dev+3667"
//   root = true
export type NetworkDecl = {
  version: string;
  type?: 'testnet' | 'standalone';
  validators?: number;
  quorum?: number;
  network_id?: number;
  root?: boolean;
  port_offset?: number;
  enabled?: boolean; // false = keep the network (and its data) but `compose down` it
};

export type State = {
  domain?: string;
  tls?: boolean;
  acme_email?: string;
  networks?: Record<string, NetworkDecl>;
};

export const DEFAULT_DOMAIN = '127.0.0.1.nip.io';
export const VERSION_RE = /^[0-9A-Za-z.+_-]{1,80}$/;
const DOMAIN_RE = /^[a-z0-9.-]+$/;
export const EMAIL_RE = /^[^\s@=]+@[^\s@=]+$/;
const TOP_KEYS = new Set(['domain', 'tls', 'acme_email', 'networks']);
const NETWORK_KEYS = new Set([
  'version',
  'type',
  'validators',
  'quorum',
  'network_id',
  'root',
  'port_offset',
  'enabled',
]);

// A typo (`validatorz`, `[network.dev]`) must not silently become a default
// or a removal, so anything unknown is an error rather than ignored.
function rejectUnknown(where: string, obj: object, known: Set<string>) {
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) fail(where ? `${where}.${k}` : k, 'unknown key');
  }
}

function fail(where: string, msg: string): never {
  throw new Error(`xng.toml: ${where}: ${msg}`);
}

function optional<T>(
  where: string,
  value: unknown,
  type: 'string' | 'number' | 'boolean',
  check?: (v: T) => boolean,
): T | undefined {
  if (value === undefined) return undefined;
  // biome-ignore lint/suspicious/useValidTypeof: `type` is one of the literal names above
  if (typeof value !== type || (check && !check(value as T))) {
    fail(where, `invalid value ${JSON.stringify(value)}`);
  }
  return value as T;
}

const isInt =
  (min: number, max = Number.POSITIVE_INFINITY) =>
  (n: number) =>
    Number.isInteger(n) && n >= min && n <= max;

export function parseState(toml: string): State {
  let raw: Record<string, unknown>;
  try {
    raw = parse(toml);
  } catch (err) {
    throw new Error(`xng.toml: ${(err as Error).message}`);
  }
  rejectUnknown('', raw, TOP_KEYS);
  const state: State = {
    domain: optional('domain', raw.domain, 'string', (d: string) =>
      DOMAIN_RE.test(d),
    ),
    tls: optional('tls', raw.tls, 'boolean'),
    acme_email: optional('acme_email', raw.acme_email, 'string', (e: string) =>
      EMAIL_RE.test(e),
    ),
    networks: {},
  };
  const networks = raw.networks ?? {};
  if (typeof networks !== 'object' || Array.isArray(networks)) {
    fail('networks', 'must be a table');
  }
  let roots = 0;
  for (const [name, decl] of Object.entries(networks as object)) {
    const at = `networks.${name}`;
    if (!NAME_RE.test(name)) fail(at, `name must match ${NAME_RE}`);
    if (RESERVED_NAMES.has(name)) fail(at, 'name is reserved');
    if (typeof decl !== 'object' || decl === null) fail(at, 'must be a table');
    const d = decl as Record<string, unknown>;
    rejectUnknown(at, d, NETWORK_KEYS);
    const version = optional<string>(
      `${at}.version`,
      d.version,
      'string',
      (v) => VERSION_RE.test(v),
    );
    if (!version) fail(`${at}.version`, 'required');
    const type = optional<string>(`${at}.type`, d.type, 'string', (t) =>
      ['testnet', 'standalone'].includes(t),
    ) as NetworkDecl['type'];
    const out: NetworkDecl = {
      version,
      type,
      validators: optional(
        `${at}.validators`,
        d.validators,
        'number',
        isInt(1),
      ),
      quorum: optional(`${at}.quorum`, d.quorum, 'number', isInt(1)),
      network_id: optional(
        `${at}.network_id`,
        d.network_id,
        'number',
        isInt(0),
      ),
      root: optional(`${at}.root`, d.root, 'boolean'),
      port_offset: optional(
        `${at}.port_offset`,
        d.port_offset,
        'number',
        isInt(0, 14300),
      ),
      enabled: optional(`${at}.enabled`, d.enabled, 'boolean'),
    };
    if (out.validators === 2) fail(`${at}.validators`, 'must be 1 or >= 3');
    const validators =
      (type ?? 'testnet') === 'standalone' ? 1 : (out.validators ?? 3);
    if (out.quorum !== undefined && out.quorum > validators) {
      fail(`${at}.quorum`, `must be <= validators (${validators})`);
    }
    if (out.root && (type ?? 'testnet') !== 'testnet') {
      fail(`${at}.root`, 'testnet only');
    }
    if (out.root && ++roots > 1) fail(`${at}.root`, 'only one root network');
    for (const k of Object.keys(out) as (keyof NetworkDecl)[]) {
      if (out[k] === undefined) delete out[k];
    }
    (state.networks as Record<string, NetworkDecl>)[name] = out;
  }
  for (const k of ['domain', 'tls', 'acme_email'] as const) {
    if (state[k] === undefined) delete state[k];
  }
  return state;
}

export function stringifyState(state: State): string {
  return stringify(state);
}

// A missing file is an empty declaration only where that is harmless (the
// panel, before its first network). `xng apply` passes mustExist: an empty
// declaration means "remove every network", so a typo'd --file or an unset
// XNG_CONFIG must fail instead of wiping the workspace.
export async function loadState(
  path: string,
  mustExist = false,
): Promise<State> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist)
      return { networks: {} };
    throw new Error(`${path}: ${(err as Error).message}`);
  }
  return parseState(text);
}

export async function saveState(path: string, state: State): Promise<void> {
  await writeFile(path, stringifyState(state));
}

// The NetworkSpec `xng create` would build for this declaration: the same
// defaults as the CLI flags, so a network created from xng.toml and one
// created by hand with the equivalent flags are indistinguishable.
export function specFor(
  name: string,
  decl: NetworkDecl,
  state: State,
): NetworkSpec {
  const type = decl.type ?? 'testnet';
  const validators = type === 'standalone' ? 1 : (decl.validators ?? 3);
  return {
    name,
    type,
    version: decl.version,
    validators,
    quorum: decl.quorum ?? defaultQuorum(validators),
    networkId: decl.network_id ?? 21339,
    domain: state.domain ?? DEFAULT_DOMAIN,
    tls: state.tls ?? false,
    root: decl.root ?? false,
    portOffset: decl.port_offset ?? 0,
    importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  };
}

// What it takes to turn `actual` (workspace/<name>/network.json) into
// `desired`. `version` is a rolling upgrade (testnet only); `routing` is a
// compose.yml re-render (hostnames/URLs only, the ledger is untouched);
// anything in `incompatible` is baked into keys/genesis/config at create
// time and can only change by removing and re-adding the network - apply
// refuses rather than doing that implicitly.
export type SpecDiff = {
  version?: { from: string; to: string };
  routing: boolean;
  incompatible: string[];
};

export function diffSpec(desired: NetworkSpec, actual: NetworkSpec): SpecDiff {
  const incompatible: string[] = [];
  for (const k of [
    'type',
    'validators',
    'quorum',
    'networkId',
    'portOffset',
  ] as const) {
    if (desired[k] !== actual[k]) incompatible.push(k);
  }
  const diff: SpecDiff = { routing: false, incompatible };
  if (desired.version !== actual.version) {
    if (desired.type === 'standalone') incompatible.push('version');
    else diff.version = { from: actual.version, to: desired.version };
  }
  for (const k of ['domain', 'tls'] as const) {
    if (desired[k] !== actual[k]) diff.routing = true;
  }
  if ((desired.root ?? false) !== (actual.root ?? false)) diff.routing = true;
  return diff;
}
