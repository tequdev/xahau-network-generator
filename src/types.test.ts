import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_IMPORT_VL_KEYS,
  configSections,
  defaultQuorum,
  endpoints,
  validateSpec,
} from './types.ts';
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

test('configSections: scalar, list and mapping become lines', () => {
  assert.deepEqual(
    configSections('nodeConfig', {
      node_size: 'huge',
      ledger_history: 50000,
      rpc_startup: ['a', 'b'],
      voting: { reference_fee: 100, flag: true },
    }),
    {
      node_size: ['huge'],
      ledger_history: ['50000'],
      rpc_startup: ['a', 'b'],
      voting: ['reference_fee = 100', 'flag = true'],
    },
  );
});

test('configSections: rejects nested values, bad section names and multi-line scalars', () => {
  assert.throws(
    () => configSections('nodeConfig', []),
    /nodeConfig must be a mapping/,
  );
  assert.throws(
    () => configSections('nodeConfig', { a: { b: { c: 1 } } }),
    /nodeConfig/,
  );
  assert.throws(
    () => configSections('nodeConfig', { a: [['x']] }),
    /nodeConfig/,
  );
  assert.throws(() => configSections('nodeConfig', { a: null }), /nodeConfig/);
  assert.throws(
    () => configSections('nodeConfig', { '': 'x' }),
    /section name/,
  );
  assert.throws(
    () => configSections('nodeConfig', { 'a]': 'x' }),
    /section name/,
  );
  assert.throws(
    () => configSections('nodeConfig', { 'a\nb': 'x' }),
    /section name/,
  );
  assert.throws(() => configSections('nodeConfig', { a: 'x\ny' }), /newline/);
});

test('validateSpec: nodeConfig must map sections to string lists', () => {
  const spec: NetworkSpec = {
    name: 'a',
    type: 'testnet',
    version: 'x',
    validators: 1,
    quorum: 1,
    networkId: 1,
    domain: 'a.b',
    tls: false,
    portOffset: 0,
    importVlKeys: [],
  };
  validateSpec({ ...spec, nodeConfig: { s: ['l'] } });
  const bad = (nodeConfig: unknown) =>
    validateSpec({ ...spec, nodeConfig: nodeConfig as never });
  assert.throws(() => bad({ s: 'l' }), /^Error: nodeConfig/);
  assert.throws(() => bad({ s: [1] }), /^Error: nodeConfig/);
  assert.throws(() => bad([]), /^Error: nodeConfig/);
});

test('configSections: errors name the key they were called with', () => {
  assert.throws(
    () => configSections('validatorConfig', []),
    /validatorConfig must be a mapping/,
  );
  assert.throws(
    () => configSections('validatorConfig', { 'a]': 'x' }),
    /validatorConfig section name/,
  );
  assert.throws(
    () => configSections('validatorConfig', { a: 'x\ny' }),
    /validatorConfig: a line/,
  );
});

test('validateSpec: validatorConfig is testnet only and checked like nodeConfig', () => {
  const spec: NetworkSpec = {
    name: 'a',
    type: 'testnet',
    version: 'x',
    validators: 1,
    quorum: 1,
    networkId: 1,
    domain: 'a.b',
    tls: false,
    portOffset: 0,
    importVlKeys: [],
  };
  validateSpec({ ...spec, validatorConfig: { s: ['l'] } });
  assert.throws(
    () => validateSpec({ ...spec, validatorConfig: { s: 'l' } as never }),
    /^Error: validatorConfig/,
  );
  assert.throws(
    () =>
      validateSpec({
        ...spec,
        type: 'standalone',
        validatorConfig: { s: ['l'] },
      }),
    /validatorConfig is testnet only/,
  );
});

test('endpoints: pwa only when set; validateSpec rejects bad pwa', () => {
  const spec: NetworkSpec = {
    name: 'dev',
    type: 'testnet',
    version: 'x',
    validators: 3,
    quorum: 2,
    networkId: 21339,
    domain: 'example.com',
    tls: true,
    portOffset: 0,
    importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  };
  assert.equal(endpoints(spec).pwa, undefined);
  assert.equal(
    endpoints({ ...spec, pwa: true }).pwa,
    'https://pwa.dev.example.com',
  );
  assert.throws(
    () =>
      validateSpec({
        ...spec,
        type: 'standalone',
        validators: 1,
        quorum: 1,
        pwa: true,
      }),
    /pwa is testnet only/,
  );
  assert.throws(
    () => validateSpec({ ...spec, pwa: 'yes' as unknown as boolean }),
    /pwa must be true or false/,
  );
});
