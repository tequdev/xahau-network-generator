import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_IMPORT_VL_KEYS, defaultQuorum, endpoints } from './types.ts';
import type { NetworkSpec } from './types.ts';

test('defaultQuorum: single validator stays 1', () => {
  assert.equal(defaultQuorum(1), 1);
});

test('defaultQuorum: capped at validators - 1 so one validator can restart without pausing consensus', () => {
  assert.equal(defaultQuorum(3), 2);
  assert.equal(defaultQuorum(4), 3);
  assert.equal(defaultQuorum(5), 4);
  assert.equal(defaultQuorum(6), 5);
  assert.equal(defaultQuorum(10), 8);
});

test('endpoints: root testnet uses the bare domain, named testnet nests under its name', () => {
  const spec: NetworkSpec = {
    name: 'dev',
    type: 'testnet',
    version: 'x',
    validators: 3,
    quorum: 2,
    networkId: 21339,
    domain: 'xahau-dev.net',
    tls: true,
    portOffset: 0,
    importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  };
  assert.equal(endpoints({ ...spec, root: true }).ws, 'wss://xahau-dev.net');
  assert.equal(
    endpoints({ ...spec, root: true }).explorer,
    'https://explorer.xahau-dev.net',
  );
  assert.equal(endpoints(spec).ws, 'wss://dev.xahau-dev.net');
  assert.equal(endpoints(spec).faucet, 'https://faucet.dev.xahau-dev.net');
});
