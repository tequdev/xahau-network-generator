// A network name becomes a directory under workspace/, the compose project
// name and a hostname label, so it must be path-safe, DNS-safe and something
// compose will not silently normalize.
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
// A testnet named `explorer` would get the router rule Host(`explorer.<domain>`)
// - the very hostname a root network's explorer uses - and Traefik would
// silently pick one of the two. Reserved outright rather than only next to
// a root network, so a name never becomes invalid later.
export const RESERVED_NAMES = new Set(['explorer', 'rpc', 'faucet', 'vl']);

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
  portOffset: number; // standalone only; default 0; shifts every published host port
  importVlKeys: string[]; // default ["ED74D4036C6591A4BDF9C54CEFA39B996A5DCE5F86D11FDA1874481CE9D5A1CDC1"]
};

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
};

const CONTAINER_PORTS: Ports = {
  rpcAdmin: 5005,
  rpcPublic: 5007,
  wsAdmin: 6006,
  wsPublic: 6008,
  peer: 51235,
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
export function hostPorts(spec: NetworkSpec): Ports {
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
