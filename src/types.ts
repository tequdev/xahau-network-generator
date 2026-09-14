export type NetworkSpec = {
  name: string;
  type: 'testnet' | 'standalone';
  version: string;
  validators: number; // standalone: 1
  quorum: number; // testnet only; default ceil(0.8*validators)
  networkId: number; // default 21339
  domain: string; // testnet only; default '127.0.0.1.nip.io'; hostnames are `<sub>.<name>.<domain>`
  tls: boolean; // testnet only; default false; true renders https/wss endpoint URLs
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

export function endpoints(spec: NetworkSpec): Endpoints {
  if (spec.type === 'testnet') {
    const httpScheme = spec.tls ? 'https' : 'http';
    const wsScheme = spec.tls ? 'wss' : 'ws';
    const { name, domain } = spec;
    return {
      ws: `${wsScheme}://${name}.${domain}`,
      rpc: `${httpScheme}://rpc.${name}.${domain}`,
      explorer: `${httpScheme}://explorer.${name}.${domain}`,
      faucet: `${httpScheme}://faucet.${name}.${domain}`,
      vl: `${httpScheme}://vl.${name}.${domain}`,
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
