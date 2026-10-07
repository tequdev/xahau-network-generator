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
    '127.0.0.1:5005:5005',
    '127.0.0.1:5007:5007',
    '127.0.0.1:6006:6006',
    '127.0.0.1:6008:6008',
    '127.0.0.1:51235:51235',
  ]);
  assert.deepEqual(doc.services.explorer.ports, ['127.0.0.1:4000:4000']);
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
    ...doc.services.site.labels,
  ];
  const hosts = labels
    .filter((l) => l.includes('.rule=Host'))
    .map((l) => l.replace(/.*Host\(`([^`]*)`\).*/, '$1'))
    .sort();
  assert.deepEqual(hosts, [
    '127.0.0.1.nip.io', // ws
    '127.0.0.1.nip.io', // site
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

test('compose: pwa adds a pwa.<base> router to port 8088 on node only when set', () => {
  const labels = (spec: NetworkSpec) =>
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    (parse(renderCompose(spec)) as any).services.node.labels.join('\n');
  assert.ok(!labels(testnetSpec).includes('pwa'));
  const on = labels({ ...testnetSpec, pwa: true });
  assert.ok(on.includes('pwa.testnet-3.127.0.0.1.nip.io'));
  assert.ok(on.includes('=8088'));
});

test('compose: a root network serves the landing page and splits the bare domain by Upgrade header; a non-root one does not', () => {
  const root = parse(
    renderCompose({ ...testnetSpec, name: 'dev', root: true }),
  );
  assert.deepEqual(root.services.site.volumes, [
    './site:/usr/share/nginx/html:ro',
  ]);
  for (const svc of [root.services.site, root.services.vl]) {
    assert.ok(svc.command.join(' ').includes('server_tokens off;'));
  }
  const rule = (labels: string[], router: string) =>
    labels.find((l) =>
      l.startsWith(`traefik.http.routers.dev-${router}.rule=`),
    );
  assert.equal(
    rule(root.services.site.labels, 'site'),
    'traefik.http.routers.dev-site.rule=Host(`127.0.0.1.nip.io`)',
  );
  assert.equal(
    rule(root.services.node.labels, 'ws'),
    'traefik.http.routers.dev-ws.rule=Host(`127.0.0.1.nip.io`) && HeaderRegexp(`Upgrade`, `(?i)^websocket$$`) && !PathPrefix(`/debugstream/`)',
  );

  const plain = parse(renderCompose({ ...testnetSpec, name: 'dev' }));
  assert.equal(plain.services.site, undefined);
  assert.equal(
    rule(plain.services.node.labels, 'ws'),
    'traefik.http.routers.dev-ws.rule=Host(`dev.127.0.0.1.nip.io`)',
  );
});

test('compose: testnet runs a debugstream service tailing node/log; standalone has none', () => {
  // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
  const doc = parse(renderCompose(testnetSpec)) as any;
  const ds = doc.services.debugstream;
  assert.equal(ds.build, '../../debugstream');
  assert.ok(ds.volumes.includes('./nodes/node/log:/log'));
  assert.equal(ds.ports, undefined);
  assert.equal(ds.mem_limit, '128m');
  const labels = ds.labels.join('\n');
  assert.ok(
    labels.includes(
      'Host(`testnet-3.127.0.0.1.nip.io`) && PathPrefix(`/debugstream/`)',
    ),
  );
  assert.ok(labels.includes('=8080'));
  // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
  const sa = parse(renderCompose(standaloneSpec)) as any;
  assert.equal(sa.services.debugstream, undefined);
});

test('compose: xahaud services cap their docker log', () => {
  for (const spec of [testnetSpec, standaloneSpec]) {
    // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
    const doc = parse(renderCompose(spec)) as any;
    assert.equal(doc.services.node.logging.options['max-size'], '20m');
  }
});
