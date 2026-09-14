import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { renderCompose } from './compose.ts';
import { DEFAULT_IMPORT_VL_KEYS } from './types.ts';
import type { NetworkSpec } from './types.ts';

const base = {
  version: 'x',
  networkId: 21339,
  domain: '127.0.0.1.nip.io',
  tls: false,
  portOffset: 0,
  importVlKeys: DEFAULT_IMPORT_VL_KEYS,
};

const testnetSpec: NetworkSpec = {
  ...base,
  name: 'testnet-3',
  type: 'testnet',
  validators: 3,
  quorum: 3,
};

const standaloneSpec: NetworkSpec = {
  ...base,
  name: 's1',
  type: 'standalone',
  validators: 1,
  quorum: 1,
};

const hostedSpec: NetworkSpec = {
  ...base,
  name: 'h1',
  type: 'testnet',
  validators: 3,
  quorum: 3,
  hosts: {
    node: '10.0.0.10',
    v1: '10.0.0.11',
    v2: '10.0.0.12',
    v3: '10.0.0.13',
  },
};

test('compose: testnet publishes no host ports and joins the shared proxy network', () => {
  // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
  const doc = parse(renderCompose(testnetSpec)) as any;
  for (const service of Object.values(doc.services)) {
    assert.equal(
      (service as { ports?: unknown }).ports,
      undefined,
      `service unexpectedly publishes host ports: ${JSON.stringify(service)}`,
    );
  }
  assert.equal(doc.networks.proxy.external, true);
});

test('compose: standalone publishes host ports directly and has no Traefik/proxy wiring', () => {
  // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
  const doc = parse(renderCompose(standaloneSpec)) as any;
  assert.deepEqual(doc.services.node.ports, [
    '5005:5005',
    '5007:5007',
    '6006:6006',
    '6008:6008',
    '51235:51235',
  ]);
  assert.deepEqual(doc.services.explorer.ports, ['4000:4000']);
  assert.equal(doc.services.node.labels, undefined);
  assert.equal(doc.services.node.networks, undefined);
  assert.equal(doc.networks, undefined);
});

test('compose: node has the rpc Traefik rule label', () => {
  const doc = parse(renderCompose(testnetSpec)) as {
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    services: Record<string, any>;
  };
  const labels: string[] = doc.services.node.labels;
  assert.ok(
    labels.some((l) => l.includes('Host(`rpc.testnet-3.127.0.0.1.nip.io`)')),
    'missing rpc router rule label',
  );
});

test('compose: faucet talks to node via its container name, not the bare service name (bare "node" is ambiguous on the shared proxy network across testnets)', () => {
  const doc = parse(renderCompose(testnetSpec)) as {
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    services: Record<string, any>;
  };
  assert.equal(
    doc.services.faucet.environment.XAHAU_WS_URL,
    'ws://testnet-3-node:6008',
  );
});

test('compose: every service container_name is prefixed with the network name', () => {
  const doc = parse(renderCompose(testnetSpec)) as {
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    services: Record<string, any>;
  };
  for (const [serviceName, service] of Object.entries(doc.services)) {
    assert.equal(
      (service as { container_name: string }).container_name,
      `testnet-3-${serviceName}`,
    );
  }
});

test('compose: hosted mode renders no validator services, and node gets extra_hosts + the published peer port', () => {
  const doc = parse(renderCompose(hostedSpec)) as {
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    services: Record<string, any>;
  };
  assert.deepEqual(
    Object.keys(doc.services).sort(),
    ['explorer', 'faucet', 'node', 'vl'].sort(),
    'hosted mode must not render v1..v3 compose services',
  );
  assert.deepEqual(doc.services.node.extra_hosts.sort(), [
    'h1-v1:10.0.0.11',
    'h1-v2:10.0.0.12',
    'h1-v3:10.0.0.13',
  ]);
  assert.deepEqual(doc.services.node.ports, ['51235:51235']);
  // vl/faucet/explorer are still present and unaffected.
  assert.ok(doc.services.vl);
  assert.ok(doc.services.faucet);
  assert.ok(doc.services.explorer);
});
