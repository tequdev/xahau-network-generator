import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  renderValidatorsTxt,
  renderXahaudCfg,
  withPwaGateway,
} from './config.ts';
import type { XahaudCfgOptions } from './config.ts';
import { containerName, nodeName } from './types.ts';
import type { NetworkSpec } from './types.ts';

const spec: NetworkSpec = {
  name: 'testnet-3',
  type: 'testnet',
  version: 'x',
  validators: 3,
  quorum: 2,
  networkId: 21339,
  domain: '127.0.0.1.nip.io',
  tls: false,
  portOffset: 0,
  importVlKeys: [],
};

const ports = {
  rpcAdmin: 5005,
  rpcPublic: 5007,
  wsAdmin: 6006,
  wsPublic: 6008,
  peer: 51235,
  pwa: 8088,
};

const cfgOpts: XahaudCfgOptions = {
  type: 'testnet',
  networkId: spec.networkId,
  ports,
  peers: [`${containerName(spec, nodeName(spec, 2))} ${ports.peer}`],
  vlKeyHex: 'AB',
  vlUrl: `http://${containerName(spec, 'vl')}/vl.json`,
  importVlKeys: spec.importVlKeys,
};

test('xahaud.cfg peers use the network-prefixed container name, not the bare service name', () => {
  const cfg = renderXahaudCfg(cfgOpts);
  assert.ok(
    cfg.includes(`testnet-3-v2 ${ports.peer}`),
    'ips_fixed line missing the container-name-prefixed peer',
  );
});

test('validators.txt vl URL uses the network-prefixed container name', () => {
  const txt = renderValidatorsTxt(cfgOpts);
  assert.ok(
    txt.includes('http://testnet-3-vl/vl.json'),
    'validator_list_sites entry missing the container-name-prefixed vl host',
  );
});

test('xahaud.cfg sets amendment_majority_time to the 1 minute floor', () => {
  assert.ok(
    renderXahaudCfg(cfgOpts).includes('[amendment_majority_time]\n1 minutes\n'),
  );
});

test('validators keep 256 ledgers, node keeps 10000', () => {
  const validator = renderXahaudCfg({ ...cfgOpts, token: 'T' });
  assert.ok(validator.includes('online_delete=256\n'));
  assert.ok(validator.includes('[ledger_history]\n256\n'));
  const node = renderXahaudCfg(cfgOpts);
  assert.ok(node.includes('online_delete=10000\n'));
  assert.ok(node.includes('[ledger_history]\n10000\n'));
});

test('admin ports bind 127.0.0.1 on testnet, 0.0.0.0 on standalone; public stays open', () => {
  const section = (cfg: string, name: string) =>
    cfg.split(/\n(?=\[)/).find((s) => s.startsWith(`[${name}]`)) ?? '';
  const tn = renderXahaudCfg(cfgOpts);
  for (const name of ['port_rpc_admin_local', 'port_ws_admin_local']) {
    const s = section(tn, name);
    assert.match(s, /ip = 127\.0\.0\.1/);
    assert.match(s, /admin = 127\.0\.0\.1/);
  }
  assert.match(section(tn, 'port_rpc_public'), /ip = 0\.0\.0\.0/);
  const sa = renderXahaudCfg({ ...cfgOpts, type: 'standalone' });
  for (const name of ['port_rpc_admin_local', 'port_ws_admin_local']) {
    assert.match(section(sa, name), /admin = 0\.0\.0\.0/);
  }
});

test('renderXahaudCfg: overrides replaces a section the generator writes, in place', () => {
  const cfg = renderXahaudCfg({
    ...cfgOpts,
    overrides: { node_size: ['huge'] },
  });
  assert.ok(cfg.includes('[node_size]\nhuge\n'));
  assert.ok(!cfg.includes('[node_size]\nsmall'));
  assert.equal(cfg.split('[node_size]').length, 2);
});

test('renderXahaudCfg: overrides appends an unknown section at the end', () => {
  const cfg = renderXahaudCfg({
    ...cfgOpts,
    overrides: { foo: ['a', 'b = 1'] },
  });
  assert.ok(cfg.endsWith('[foo]\na\nb = 1\n'));
});

test('renderXahaudCfg: empty or absent overrides renders the plain cfg', () => {
  const plain = renderXahaudCfg(cfgOpts);
  assert.equal(renderXahaudCfg({ ...cfgOpts, overrides: {} }), plain);
  assert.equal(renderXahaudCfg({ ...cfgOpts, overrides: undefined }), plain);
});

test('xahaud.cfg: pwaGateway adds a pwa-only [port_pwa] behind secure_gateway', () => {
  const cfg = renderXahaudCfg({ ...cfgOpts, pwaGateway: ['172.18.0.0/16'] });
  assert.ok(cfg.includes('port_peer\nport_pwa\n'));
  assert.ok(
    cfg.includes(
      '[port_pwa]\nport = 8088\nip = 0.0.0.0\nprotocol = pwa\nsecure_gateway = 172.18.0.0/16\n',
    ),
  );
});

test('xahaud.cfg: no pwa port without pwaGateway', () => {
  assert.ok(!renderXahaudCfg(cfgOpts).includes('port_pwa'));
});

test('withPwaGateway rewrites only the secure_gateway line', () => {
  const cfg = renderXahaudCfg({ ...cfgOpts, pwaGateway: ['172.18.0.0/16'] });
  const next = withPwaGateway(cfg, ['172.31.0.0/16', 'fd00::/64']);
  assert.ok(next.includes('secure_gateway = 172.31.0.0/16, fd00::/64\n'));
  assert.ok(!next.includes('172.18.0.0/16'));
  assert.equal(
    next.replace(/^secure_gateway = .*$/m, ''),
    cfg.replace(/^secure_gateway = .*$/m, ''),
  );
});

test('xahaud.cfg: node logs hook trace (View at trace) to log/debug.log; validators do not', () => {
  const node = renderXahaudCfg(cfgOpts);
  assert.ok(node.includes('[debug_logfile]\nlog/debug.log'));
  const warning = node.indexOf('"severity": "warning"');
  const trace = node.indexOf(
    '{ "command": "log_level", "partition": "View", "severity": "trace" }',
  );
  assert.ok(warning >= 0 && trace > warning, 'View trace must follow warning');
  const validator = renderXahaudCfg({ ...cfgOpts, token: 'T' });
  assert.ok(!validator.includes('debug_logfile'));
  assert.ok(!validator.includes('log/debug.log'));
  assert.ok(!validator.includes('"partition": "View"'));
});
