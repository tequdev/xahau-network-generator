import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderValidatorsTxt, renderXahaudCfg } from './config.ts';
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

test('validators.txt: hosted mode emits a static [validators] list instead of validator_list_sites/keys', () => {
  const hostedOpts: XahaudCfgOptions = {
    ...cfgOpts,
    validators: ['n9Kabc'],
  };
  const txt = renderValidatorsTxt(hostedOpts);
  assert.ok(txt.includes('[validators]\nn9Kabc'));
  assert.ok(!txt.includes('[validator_list_sites]'));
  assert.ok(!txt.includes('[validator_list_keys]'));
});
