import type { Ports } from './types.ts';

export type XahaudCfgOptions = {
  type: 'testnet' | 'standalone';
  networkId: number;
  ports: Ports; // container ports
  token?: string; // testnet validators only
  peers: string[]; // testnet only; "hostname 51235" lines, excluding self
  vlKeyHex?: string; // testnet only
  vlUrl?: string; // testnet only
  importVlKeys: string[];
  validators?: string[]; // testnet only; hosted mode: static [validators] list (base58 node public keys) instead of vlUrl/vlKeyHex, since http://<name>-vl/vl.json is only reachable on the compose network
};

export function renderXahaudCfg(o: XahaudCfgOptions): string {
  const lines: string[] = [];

  lines.push('[server]');
  lines.push('port_rpc_admin_local');
  lines.push('port_rpc_public');
  lines.push('port_ws_admin_local');
  lines.push('port_ws_public');
  lines.push('port_peer');
  lines.push('');

  lines.push('[port_rpc_admin_local]');
  lines.push(`port = ${o.ports.rpcAdmin}`);
  lines.push('ip = 0.0.0.0');
  lines.push('admin = 0.0.0.0');
  lines.push('protocol = http');
  lines.push('');

  lines.push('[port_rpc_public]');
  lines.push(`port = ${o.ports.rpcPublic}`);
  lines.push('ip = 0.0.0.0');
  lines.push('protocol = http');
  lines.push('');

  lines.push('[port_ws_admin_local]');
  lines.push(`port = ${o.ports.wsAdmin}`);
  lines.push('ip = 0.0.0.0');
  lines.push('admin = 0.0.0.0');
  lines.push('protocol = ws');
  lines.push('');

  lines.push('[port_ws_public]');
  lines.push(`port = ${o.ports.wsPublic}`);
  lines.push('ip = 0.0.0.0');
  lines.push('protocol = ws');
  lines.push('');

  lines.push('[port_peer]');
  lines.push(`port = ${o.ports.peer}`);
  lines.push('ip = 0.0.0.0');
  lines.push('protocol = peer');
  lines.push('');

  lines.push('[node_size]');
  lines.push(o.type === 'testnet' ? 'medium' : 'small');
  lines.push('');

  lines.push('[node_db]');
  lines.push('type=NuDB');
  lines.push('path=db/nudb');
  lines.push('advisory_delete=0');
  lines.push('online_delete=10000');
  lines.push('');

  lines.push('[database_path]');
  lines.push('db');
  lines.push('');

  lines.push('[ledger_history]');
  lines.push('10000');
  lines.push('');

  lines.push('[network_id]');
  lines.push(String(o.networkId));
  lines.push('');

  lines.push('[peer_private]');
  lines.push('0');
  lines.push('');

  if (o.type === 'testnet') {
    // Default minimum is 1 peer; a single-validator network has none and would
    // stay DISCONNECTED (consensus never runs) without this.
    lines.push('[network_quorum]');
    lines.push('0');
    lines.push('');
  }

  if (o.type === 'testnet' && o.peers.length > 0) {
    lines.push('[ips_fixed]');
    for (const peer of o.peers) lines.push(peer);
    lines.push('');
  }

  if (o.type === 'testnet' && o.token) {
    lines.push('[validator_token]');
    lines.push(o.token);
    lines.push('');
  }

  lines.push('[validators_file]');
  lines.push('validators.txt');
  lines.push('');

  lines.push('[rpc_startup]');
  lines.push('{ "command": "log_level", "severity": "warning" }');
  lines.push('');

  lines.push('[ssl_verify]');
  lines.push('0');
  lines.push('');

  lines.push('[voting]');
  lines.push('account_reserve = 1000000');
  lines.push('owner_reserve = 200000');
  lines.push('reference_fee = 10');
  lines.push('');

  return lines.join('\n');
}

// xahaud reads [import_vl_keys] only from the validators file, so all
// validator-related sections live there.
export function renderValidatorsTxt(o: XahaudCfgOptions): string {
  const lines: string[] = [];
  if (o.type === 'testnet' && o.validators) {
    lines.push('[validators]');
    for (const key of o.validators) lines.push(key);
    lines.push('');
  } else if (o.type === 'testnet') {
    lines.push('[validator_list_sites]');
    if (o.vlUrl) lines.push(o.vlUrl);
    lines.push('');
    lines.push('[validator_list_keys]');
    if (o.vlKeyHex) lines.push(o.vlKeyHex);
    lines.push('');
  }
  lines.push('[import_vl_keys]');
  for (const key of o.importVlKeys) lines.push(key);
  lines.push('');
  return lines.join('\n');
}
