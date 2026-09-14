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
