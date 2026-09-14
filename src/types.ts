export type NetworkSpec = {
  name: string;
  type: 'testnet' | 'standalone';
  version: string;
  validators: number; // standalone: 1
  quorum: number; // testnet only; default ceil(0.8*validators)
  networkId: number; // default 21339
  portOffset: number; // default 0
  importVlKeys: string[]; // default ["ED74D4036C6591A4BDF9C54CEFA39B996A5DCE5F86D11FDA1874481CE9D5A1CDC1"]
};

// Hostnames inside the network. compose.ts uses them as service names; a
// native runner would map them via /etc/hosts. Index 0 is always the
// non-validating, user-facing `node` (the only node with published host
// ports); testnet validators are v1..vN.
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
// term now that just one node is ever published per network).
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

export function faucetHostPort(spec: NetworkSpec): number {
  return 8080 + spec.portOffset;
}

export function explorerHostPort(spec: NetworkSpec): number {
  return 4000 + spec.portOffset;
}

export function allHostPorts(spec: NetworkSpec): number[] {
  const result = Object.values(hostPorts(spec));
  result.push(explorerHostPort(spec));
  if (spec.type === 'testnet') result.push(faucetHostPort(spec));
  return result;
}
