// A network name becomes a directory under workspace/, the compose project
// name and a hostname label, so it must be path-safe, DNS-safe and something
// compose will not silently normalize.
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
// A testnet named `explorer` would get the router rule Host(`explorer.<domain>`)
// - the very hostname a root network's explorer uses - and Traefik would
// silently pick one of the two. Reserved outright rather than only next to
// a root network, so a name never becomes invalid later.
export const RESERVED_NAMES = new Set([
  'explorer',
  'rpc',
  'faucet',
  'vl',
  'pwa',
]);
export const DOMAIN_RE = /^[a-z0-9.-]+$/;

export type NetworkSpec = {
  name: string;
  type: 'testnet' | 'standalone';
  version: string;
  validators: number; // standalone: 1
  quorum: number; // testnet only; default defaultQuorum(validators) (see below)
  networkId: number; // default 21339
  domain: string; // testnet only; default '127.0.0.1.nip.io'; hostnames are `<sub>.<name>.<domain>`
  tls: boolean; // testnet only; default false; true renders https/wss endpoint URLs
  root?: boolean; // testnet only; default false; true serves the bare domain (`<sub>.<domain>`) instead of `<sub>.<name>.<domain>`
  pwa?: boolean; // testnet only; default false; node (index 0) serves on-ledger AppLoader documents (xahaud PR #793 `protocol = pwa`) at pwa.<base> through Traefik
  external?: boolean; // testnet only; default false; runs on another host, only its hostnames are known here (network.json is a stub with version "")
  displayName?: string; // cosmetic, landing page only (section heading); never recreates a network
  displayShortName?: string; // cosmetic, landing page only (nav link, faucet pill); never recreates a network
  portOffset: number; // standalone only; default 0; shifts every published host port
  nodeConfig?: Record<string, string[]>; // `node` (index 0) only: extra/overriding xahaud.cfg sections, section -> lines; validators never get it
  validatorConfig?: Record<string, string[]>; // testnet validators v1..vN only: same shape as nodeConfig; `node` never gets it
  importVlKeys: string[]; // default ["ED74D4036C6591A4BDF9C54CEFA39B996A5DCE5F86D11FDA1874481CE9D5A1CDC1"]
};

// Landing-page labels with their defaults: the network name (`main` for root).
export function displayNames(spec: NetworkSpec): {
  displayName: string;
  displayShortName: string;
} {
  const displayName = spec.displayName ?? (spec.root ? 'main' : spec.name);
  return {
    displayName,
    displayShortName: spec.displayShortName ?? displayName,
  };
}

type ConfigKey = 'nodeConfig' | 'validatorConfig';
const CONFIG_KEYS: ConfigKey[] = ['nodeConfig', 'validatorConfig'];

function checkSectionName(key: ConfigKey, name: string): void {
  if (name === '' || /[[\]\n\r]/.test(name)) {
    throw new Error(
      `${key} section name must be non-empty with no "[", "]" or newline, got "${name}"`,
    );
  }
}

// Loose yml/JSON shape -> section -> lines. A scalar is one line, a list one
// line per item, a mapping `key = value` lines.
export function configSections(
  key: ConfigKey,
  raw: unknown,
): Record<string, string[]> {
  const bad = `${key} must be a mapping of section -> line | [lines] | {key: value}`;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const scalar = (v: unknown): string => {
    if (typeof v === 'string') {
      if (/[\r\n]/.test(v)) {
        throw new Error(
          `${key}: a line must not contain a newline (use a list for several lines)`,
        );
      }
      return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw new Error(bad);
  };
  if (!isObj(raw)) throw new Error(bad);
  const out: Record<string, string[]> = {};
  for (const [name, v] of Object.entries(raw)) {
    checkSectionName(key, name);
    out[name] = Array.isArray(v)
      ? v.map(scalar)
      : isObj(v)
        ? Object.entries(v).map(([k, x]) => `${k} = ${scalar(x)}`)
        : [scalar(v)];
  }
  return out;
}

// The one place every semantic rule for a spec lives, shared by `xng create`
// and `xng apply` (which checks a whole xng.yml up front so a bad entry cannot
// fail halfway through, after an earlier `recreate` already removed a network).
// Throws on the first violation; messages use bare field names so they read
// well for both a CLI flag and a yml key.
export function validateSpec(spec: NetworkSpec): void {
  const isInt = (n: unknown): n is number => Number.isInteger(n);
  if (typeof spec.name !== 'string' || !NAME_RE.test(spec.name)) {
    throw new Error(
      `name must match ${NAME_RE} (lowercase, digits, "-", "_"), got "${spec.name}"`,
    );
  }
  if (spec.type !== 'testnet' && spec.type !== 'standalone') {
    throw new Error(
      `type must be "testnet" or "standalone", got "${spec.type}"`,
    );
  }
  if (spec.type === 'testnet' && RESERVED_NAMES.has(spec.name)) {
    throw new Error(
      `"${spec.name}" is reserved (it is a service subdomain of a root network); pick another name`,
    );
  }
  if (
    typeof spec.version !== 'string' ||
    (spec.version === '' && !spec.external)
  ) {
    throw new Error('version must be a non-empty string');
  }
  if (typeof spec.domain !== 'string' || !DOMAIN_RE.test(spec.domain)) {
    throw new Error(
      `domain must match ${DOMAIN_RE} (lowercase letters, digits, dots, hyphens), got "${spec.domain}"`,
    );
  }
  if (!isInt(spec.validators) || spec.validators < 1 || spec.validators === 2) {
    throw new Error(
      `validators must be 1 or an integer >= 3 (a 2-validator network cannot tolerate a rolling restart), got "${spec.validators}"`,
    );
  }
  if (spec.type === 'standalone' && spec.validators !== 1) {
    throw new Error('validators must be 1 for a standalone network');
  }
  if (!isInt(spec.quorum) || spec.quorum < 1 || spec.quorum > spec.validators) {
    throw new Error(
      `quorum must be an integer in [1, ${spec.validators}], got "${spec.quorum}"`,
    );
  }
  if (!isInt(spec.networkId) || spec.networkId < 0) {
    throw new Error(
      `networkId must be an integer >= 0, got "${spec.networkId}"`,
    );
  }
  if (
    !isInt(spec.portOffset) ||
    spec.portOffset < 0 ||
    spec.portOffset > 14300
  ) {
    throw new Error(
      `portOffset must be an integer in [0, 14300], got "${spec.portOffset}"`,
    );
  }
  if (typeof spec.tls !== 'boolean') {
    throw new Error(`tls must be true or false, got "${spec.tls}"`);
  }
  if (spec.root !== undefined && typeof spec.root !== 'boolean') {
    throw new Error(`root must be true or false, got "${spec.root}"`);
  }
  if (spec.root && spec.type !== 'testnet') {
    throw new Error('root is testnet only');
  }
  if (spec.external !== undefined && typeof spec.external !== 'boolean') {
    throw new Error(`external must be true or false, got "${spec.external}"`);
  }
  if (spec.external && spec.type !== 'testnet') {
    throw new Error('external is testnet only');
  }
  if (spec.external && spec.root) {
    throw new Error(
      "an external network cannot be root (the landing page is served by this host's root network)",
    );
  }
  if (spec.pwa !== undefined && typeof spec.pwa !== 'boolean') {
    throw new Error(`pwa must be true or false, got "${spec.pwa}"`);
  }
  if (spec.pwa && spec.type !== 'testnet') {
    throw new Error('pwa is testnet only');
  }
  for (const [key, max] of [
    ['displayName', 64],
    ['displayShortName', 24],
  ] as const) {
    const v = spec[key] as unknown;
    if (
      v !== undefined &&
      (typeof v !== 'string' ||
        v.length < 1 ||
        v.length > max ||
        /\p{Cc}/u.test(v))
    ) {
      throw new Error(
        `${key} must be 1-${max} characters with no control characters, got "${v}"`,
      );
    }
  }
  if (spec.validatorConfig !== undefined && spec.type !== 'testnet') {
    throw new Error('validatorConfig is testnet only');
  }
  for (const key of CONFIG_KEYS) {
    const sections = spec[key] as unknown;
    if (sections === undefined) continue;
    if (
      typeof sections !== 'object' ||
      sections === null ||
      Array.isArray(sections)
    ) {
      throw new Error(`${key} must be a mapping of section -> [lines]`);
    }
    for (const [name, lines] of Object.entries(sections)) {
      checkSectionName(key, name);
      if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) {
        throw new Error(`${key}.${name} must be a list of strings`);
      }
    }
  }
}

// Hostnames inside the network. compose.ts uses them as service names; a
// native runner would map them via /etc/hosts. Index 0 is always the
// non-validating, user-facing `node` (the only node routed through Traefik
// on testnet, or published directly on the host on standalone); testnet
// validators are v1..vN.
export const VL_HOST = 'vl';
export function nodeName(spec: NetworkSpec, i: number): string {
  return i === 0 ? 'node' : `v${i}`;
}

// The bare compose service name (e.g. "node", "vl") is only unique within
// one network's own default Docker network. Every testnet's `node`/`vl`/
// `faucet` also join the *shared* external `proxy` network (for Traefik),
// and Docker aliases containers by service name on every network they join
// - so on `proxy`, "node" is ambiguous across testnets. The container name
// (`<network-name>-<service>`, set as `container_name` in compose.ts) is
// unique and resolvable on every network the container is on, so any
// container-to-container reference (xahaud.cfg peers/vl URL, the faucet's
// XAHAU_WS_URL, ...) must use this instead of the bare service name.
export function containerName(spec: NetworkSpec, service: string): string {
  return `${spec.name}-${service}`;
}

// Default consensus quorum. Capped at validators-1 (for validators >= 3) so
// a rolling upgrade (`xng upgrade`) can restart one validator at a time
// without ever dropping below quorum, i.e. without pausing consensus.
// --quorum can still override this.
export function defaultQuorum(validators: number): number {
  if (validators === 1) return 1;
  return Math.min(Math.ceil(0.8 * validators), validators - 1);
}

export const DEFAULT_IMPORT_VL_KEYS = [
  'ED74D4036C6591A4BDF9C54CEFA39B996A5DCE5F86D11FDA1874481CE9D5A1CDC1',
];

export type Ports = {
  rpcAdmin: number;
  rpcPublic: number;
  wsAdmin: number;
  wsPublic: number;
  peer: number;
  pwa: number;
};

const CONTAINER_PORTS: Ports = {
  rpcAdmin: 5005,
  rpcPublic: 5007,
  wsAdmin: 6006,
  wsPublic: 6008,
  peer: 51235,
  pwa: 8088,
};

// Container ports are identical for every node (validator or `node`); kept
// as a function of (spec, i) for call-site symmetry even though neither
// argument currently changes the result.
export function ports(_spec: NetworkSpec, _i: number): Ports {
  return CONTAINER_PORTS;
}

// Validators publish no host ports at all (container-to-container only);
// only `node` (index 0) does, shifted by --port-offset alone (no per-index
// term now that just one node is ever published per network). Standalone
// only — testnet publishes nothing and is routed through Traefik instead.
// No pwa: it is testnet-only and never published, and listing it here would
// make the standalone port-collision checks reject offsets that are fine.
export function hostPorts(spec: NetworkSpec): Omit<Ports, 'pwa'> {
  const { portOffset } = spec;
  return {
    rpcAdmin: CONTAINER_PORTS.rpcAdmin + portOffset,
    rpcPublic: CONTAINER_PORTS.rpcPublic + portOffset,
    wsAdmin: CONTAINER_PORTS.wsAdmin + portOffset,
    wsPublic: CONTAINER_PORTS.wsPublic + portOffset,
    peer: CONTAINER_PORTS.peer + portOffset,
  };
}

export function explorerHostPort(spec: NetworkSpec): number {
  return 4000 + spec.portOffset;
}

// Public URLs for `node` (index 0): on testnet, subdomains of spec.domain
// routed through the shared Traefik instance (mirroring
// https://github.com/tequdev/xahau-devnets); on standalone, published
// directly on localhost via --port-offset, exactly as before Traefik
// existed. faucet/vl only apply to testnet; rpcAdmin/wsAdmin (needed for
// ledger_accept) only apply to standalone — kept optional so a caller has
// to check before using one.
export type Endpoints = {
  ws: string;
  rpc: string;
  explorer: string;
  faucet?: string;
  vl?: string;
  debugstream?: string; // testnet only; ws(s)://<base>/debugstream/, append an r-address to filter; the same path over http(s) is a browser viewer (same as xahau-test.net)
  pwa?: string;
  rpcAdmin?: string;
  wsAdmin?: string;
};

// Testnet only: the hostname every routed service hangs off. Normally
// `<name>.<domain>` (so `explorer.<name>.<domain>` etc.); a `root` network
// takes the bare domain itself (`explorer.<domain>`), which is why only one
// root network per domain can exist (checked in network.ts).
export function hostBase(spec: NetworkSpec): string {
  return spec.root ? spec.domain : `${spec.name}.${spec.domain}`;
}

export function endpoints(spec: NetworkSpec): Endpoints {
  if (spec.type === 'testnet') {
    const httpScheme = spec.tls ? 'https' : 'http';
    const wsScheme = spec.tls ? 'wss' : 'ws';
    const base = hostBase(spec);
    return {
      ws: `${wsScheme}://${base}`,
      rpc: `${httpScheme}://rpc.${base}`,
      explorer: `${httpScheme}://explorer.${base}`,
      faucet: `${httpScheme}://faucet.${base}`,
      vl: `${httpScheme}://vl.${base}`,
      debugstream: `${wsScheme}://${base}/debugstream/`,
      ...(spec.pwa ? { pwa: `${httpScheme}://pwa.${base}` } : {}),
    };
  }
  const host = hostPorts(spec);
  return {
    ws: `ws://localhost:${host.wsPublic}`,
    rpc: `http://localhost:${host.rpcPublic}`,
    explorer: `http://localhost:${explorerHostPort(spec)}`,
    rpcAdmin: `http://localhost:${host.rpcAdmin}`,
    wsAdmin: `ws://localhost:${host.wsAdmin}`,
  };
}
