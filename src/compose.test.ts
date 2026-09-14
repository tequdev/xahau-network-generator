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

test('compose: every service restarts unless-stopped, so it survives a daemon/host restart', () => {
  for (const spec of [testnetSpec, standaloneSpec]) {
    const doc = parse(renderCompose(spec)) as {
      // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
      services: Record<string, any>;
    };
    for (const [serviceName, service] of Object.entries(doc.services)) {
      assert.equal(
        (service as { restart: string }).restart,
        'unless-stopped',
        `${serviceName} missing restart: unless-stopped`,
      );
    }
  }
});

test('compose: standalone node command runs stand-alone mode, resuming from db/ via --load', () => {
  const doc = parse(renderCompose(standaloneSpec)) as {
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    services: Record<string, any>;
  };
  const command: string = doc.services.node.command[2];
  assert.match(command, /-a\b/);
  assert.match(command, /if \[ -d db \]; then exec [^;]*--load;/);
  assert.match(command, /else exec [^;]*--ledgerfile genesis\.json;/);
  assert.doesNotMatch(command, /--quorum/);
});

test('compose: testnet node command still sets quorum and resumes via --load, not stand-alone mode', () => {
  const doc = parse(renderCompose(testnetSpec)) as {
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    services: Record<string, any>;
  };
  const command: string = doc.services.node.command[2];
  assert.match(command, /--quorum=3\b/);
  assert.match(command, /if \[ -d db \]; then exec [^;]*--load;/);
  assert.match(command, /else exec [^;]*--ledgerfile genesis\.json;/);
  assert.doesNotMatch(command, / -a\b/);
});

test('compose: a root network hangs every service off the bare domain', () => {
  const doc = parse(renderCompose({ ...testnetSpec, name: 'dev', root: true }));
  const labels: string[] = [
    ...doc.services.node.labels,
    ...doc.services.explorer.labels,
    ...doc.services.faucet.labels,
    ...doc.services.vl.labels,
  ];
  const hosts = labels
    .filter((l) => l.includes('.rule=Host'))
    .map((l) => l.replace(/.*Host\(`(.*)`\).*/, '$1'))
    .sort();
  assert.deepEqual(hosts, [
    '127.0.0.1.nip.io',
    'explorer.127.0.0.1.nip.io',
    'faucet.127.0.0.1.nip.io',
    'rpc.127.0.0.1.nip.io',
    'vl.127.0.0.1.nip.io',
  ]);
  // Router/container names still carry the network name, so a root network
  // coexists with named ones on the same Traefik.
  assert.ok(labels.some((l) => l.startsWith('traefik.http.routers.dev-ws.')));
  assert.equal(doc.services.node.container_name, 'dev-node');
});
