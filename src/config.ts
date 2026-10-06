import type { Ports } from './types.ts';

export type XahaudCfgOptions = {
  type: 'testnet' | 'standalone';
  networkId: number;
  ports: Ports; // container ports
  token?: string; // testnet validators only
  peers: string[]; // testnet only; "hostname 51235" lines, excluding self
  vlKeyHex?: string; // testnet only
  vlUrl?: string; // testnet only
  pwaGateway?: string[]; // testnet node only: secure_gateway networks for a [port_pwa] (PR #793); absent = no pwa port
  importVlKeys: string[];
  overrides?: Record<string, string[]>; // extra/overriding sections; the caller picks nodeConfig or validatorConfig
};

export function renderXahaudCfg(o: XahaudCfgOptions): string {
  const sections: [string, string[]][] = [];
  // On testnet every node's admin port is otherwise reachable from every
  // container on the shared `proxy` network. The xahaud CLI runs inside the
  // container and connects to this ip. Standalone publishes the admin port to
  // the host (ledger_accept), which a container-loopback bind can't serve.
  const adminIp = o.type === 'testnet' ? '127.0.0.1' : '0.0.0.0';

  sections.push([
    'server',
    [
      'port_rpc_admin_local',
      'port_rpc_public',
      'port_ws_admin_local',
      'port_ws_public',
      'port_peer',
      ...(o.pwaGateway ? ['port_pwa'] : []),
    ],
  ]);

  sections.push([
    'port_rpc_admin_local',
    [
      `port = ${o.ports.rpcAdmin}`,
      `ip = ${adminIp}`,
      `admin = ${adminIp}`,
      'protocol = http',
    ],
  ]);

  sections.push([
    'port_rpc_public',
    [`port = ${o.ports.rpcPublic}`, 'ip = 0.0.0.0', 'protocol = http'],
  ]);

  sections.push([
    'port_ws_admin_local',
    [
      `port = ${o.ports.wsAdmin}`,
      `ip = ${adminIp}`,
      `admin = ${adminIp}`,
      'protocol = ws',
    ],
  ]);

  sections.push([
    'port_ws_public',
    [`port = ${o.ports.wsPublic}`, 'ip = 0.0.0.0', 'protocol = ws'],
  ]);

  sections.push([
    'port_peer',
    [`port = ${o.ports.peer}`, 'ip = 0.0.0.0', 'protocol = peer'],
  ]);

  // pwa must be the only protocol on its port, requires secure_gateway, and
  // refuses admin/user/ssl keys, so it gets its own section with just these
  // four lines.
  if (o.pwaGateway) {
    sections.push([
      'port_pwa',
      [
        `port = ${o.ports.pwa}`,
        'ip = 0.0.0.0',
        'protocol = pwa',
        `secure_gateway = ${o.pwaGateway.join(', ')}`,
      ],
    ]);
  }

  // Not tiny: its 30s ledger cache (medium: 180s) drops the unvalidated
  // ledger a peer asks for while re-syncing after `xng upgrade`, and the
  // 1-validator e2e then never confirms a payment.
  sections.push(['node_size', ['small']]);

  // Validators only need enough history to serve peers; `node` keeps more
  // for users and the explorer.
  const history = o.token ? 256 : 10000;
  sections.push([
    'node_db',
    [
      'type=NuDB',
      'path=db/nudb',
      'advisory_delete=0',
      `online_delete=${history}`,
    ],
  ]);

  sections.push(['database_path', ['db']]);

  sections.push(['ledger_history', [String(history)]]);

  sections.push(['network_id', [String(o.networkId)]]);

  sections.push(['peer_private', ['0']]);

  // xahaud's floor is 1 minute (default 2 weeks); votes cast with `xng vote`
  // then take effect at the next flag ledger after a minute of majority.
  sections.push(['amendment_majority_time', ['1 minutes']]);

  if (o.type === 'testnet') {
    // Default minimum is 1 peer; a single-validator network has none and would
    // stay DISCONNECTED (consensus never runs) without this.
    sections.push(['network_quorum', ['0']]);
  }

  if (o.type === 'testnet' && o.peers.length > 0) {
    sections.push(['ips_fixed', o.peers]);
  }

  if (o.type === 'testnet' && o.token) {
    sections.push(['validator_token', [o.token]]);
  }

  sections.push(['validators_file', ['validators.txt']]);

  sections.push([
    'rpc_startup',
    ['{ "command": "log_level", "severity": "warning" }'],
  ]);

  sections.push(['ssl_verify', ['0']]);

  sections.push([
    'voting',
    [
      'account_reserve = 1000000',
      'owner_reserve = 200000',
      'reference_fee = 10',
    ],
  ]);

  // A section xng already writes is replaced in place, not repeated: xahaud
  // reads single-value sections (node_size, ...) only when they have exactly
  // one line. Unknown sections go last.
  for (const [name, userLines] of Object.entries(o.overrides ?? {})) {
    const existing = sections.find(([n]) => n === name);
    if (existing) existing[1] = userLines;
    else sections.push([name, userLines]);
  }

  return sections
    .flatMap(([name, lines]) => [`[${name}]`, ...lines, ''])
    .join('\n');
}

// The `proxy` Docker network can be removed (prune, Docker Desktop reset) and
// recreated with another subnet while every network is stopped; xahaud would
// then 403 every Traefik-routed pwa request. `xng start`/`reset` rewrite the
// line from the live subnets, as they already re-render compose.yml.
export function withPwaGateway(cfg: string, subnets: string[]): string {
  return cfg.replace(
    /^secure_gateway = .*$/m,
    `secure_gateway = ${subnets.join(', ')}`,
  );
}

// xahaud reads [import_vl_keys] only from the validators file, so all
// validator-related sections live there.
export function renderValidatorsTxt(o: XahaudCfgOptions): string {
  const lines: string[] = [];
  if (o.type === 'testnet') {
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
