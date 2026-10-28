import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNetwork, writeNodeConfig, writeSiteIndex } from './network.ts';
import { DEFAULT_IMPORT_VL_KEYS } from './types.ts';
import type { NetworkSpec } from './types.ts';

const spec = (over: Partial<NetworkSpec> & { name: string }): NetworkSpec => ({
  type: 'testnet',
  version: 'x',
  validators: 3,
  quorum: 2,
  networkId: 21339,
  domain: 'example.com',
  tls: true,
  portOffset: 0,
  importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  ...over,
});

async function put(dir: string, s: NetworkSpec) {
  await mkdir(join(dir, s.name), { recursive: true });
  await writeFile(join(dir, s.name, 'network.json'), JSON.stringify(s));
}

test('writeSiteIndex: lists same-domain testnets (external too), root first, no standalones or other domains', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xng-site-'));
  for (const s of [
    spec({ name: 'zeta', root: true }),
    spec({ name: 'beta' }),
    spec({ name: 'foo', version: '', external: true }),
    spec({ name: 'other', domain: 'other.net' }),
    spec({ name: 's1', type: 'standalone', validators: 1, quorum: 1 }),
  ]) {
    await put(dir, s);
  }
  await writeSiteIndex(dir);
  const out = JSON.parse(
    await readFile(join(dir, 'zeta', 'site', 'networks.json'), 'utf8'),
  );
  assert.equal(out.domain, 'example.com');
  assert.deepEqual(
    out.networks.map((n: { name: string }) => n.name),
    ['zeta', 'beta', 'foo'],
  );
  assert.equal(out.networks[0].endpoints.ws, 'wss://example.com');
  assert.equal(out.networks[2].endpoints.ws, 'wss://foo.example.com');
  assert.equal(out.networks[0].version, 'x');
  // The page is copied next to the list; only roots get a site/ directory.
  assert.ok((await readdir(join(dir, 'zeta', 'site'))).includes('index.html'));
  await assert.rejects(readdir(join(dir, 'beta', 'site')));
});

test('createNetwork: an external network writes network.json and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xng-ext-'));
  const stub = spec({ name: 'foo', version: '', external: true });
  await createNetwork(stub, dir);
  assert.deepEqual(await readdir(join(dir, 'foo')), ['network.json']);
  // It still claims its hostnames: a local root on foo.example.com collides.
  await assert.rejects(
    createNetwork(
      spec({ name: 'x', root: true, domain: 'foo.example.com' }),
      dir,
    ),
    /already serves/,
  );
});

test('writeSiteIndex: entries carry resolved displayName/displayShortName (main for root, name otherwise)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xng-labels-'));
  for (const s of [
    spec({ name: 'zeta', root: true }),
    spec({ name: 'beta', displayName: 'Beta Net' }),
    spec({ name: 'gam', displayName: 'Gamma', displayShortName: 'G' }),
  ]) {
    await put(dir, s);
  }
  await writeSiteIndex(dir);
  const out = JSON.parse(
    await readFile(join(dir, 'zeta', 'site', 'networks.json'), 'utf8'),
  );
  assert.deepEqual(
    out.networks.map((n: Record<string, string>) => [
      n.displayName,
      n.displayShortName,
    ]),
    [
      ['main', 'main'],
      ['Beta Net', 'Beta Net'],
      ['Gamma', 'G'],
    ],
  );
});

test('writeNodeConfig: renders node and validator cfgs from keys on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xng-cfg-'));
  const s = spec({ name: 't', validators: 1, quorum: 1 });
  await mkdir(join(dir, 'keys'));
  await writeFile(
    join(dir, 'keys', 'vl.json'),
    JSON.stringify({ master: { publicKey: 'EDVL' } }),
  );
  await writeFile(
    join(dir, 'keys', 'v1.json'),
    JSON.stringify({ token: 'TOKEN1' }),
  );
  for (const i of [0, 1]) {
    await mkdir(join(dir, 'nodes', i === 0 ? 'node' : 'v1'), {
      recursive: true,
    });
    await writeNodeConfig(s, dir, i);
  }
  const node = await readFile(join(dir, 'nodes', 'node', 'xahaud.cfg'), 'utf8');
  const v1 = await readFile(join(dir, 'nodes', 'v1', 'xahaud.cfg'), 'utf8');
  assert.ok(node.includes('[hook_validate_rpc]\n1'));
  assert.ok(!v1.includes('[hook_validate_rpc]'));
  assert.ok(v1.includes('TOKEN1'));
  assert.ok(
    (await readdir(join(dir, 'nodes', 'v1'))).includes('validators.txt'),
  );
});

test('writeNodeConfig: the relay peers with every validator, takes relayConfig only and is not dialled back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xng-relay-'));
  const s = spec({
    name: 't',
    validators: 2,
    relayConfig: { xrpl_relay: ['relay.example 51235', 'network_id=1'] },
    nodeConfig: { node_size: ['huge'] },
  });
  await mkdir(join(dir, 'keys'));
  await writeFile(
    join(dir, 'keys', 'vl.json'),
    JSON.stringify({ master: { publicKey: 'EDVL' } }),
  );
  await writeFile(
    join(dir, 'keys', 'v1.json'),
    JSON.stringify({ token: 'TOKEN1' }),
  );
  for (const service of ['relay', 'v1']) {
    await mkdir(join(dir, 'nodes', service), { recursive: true });
  }
  await writeNodeConfig(s, dir, 'relay');
  await writeNodeConfig(s, dir, 1);
  const cfg = (service: string) =>
    readFile(join(dir, 'nodes', service, 'xahaud.cfg'), 'utf8');
  const relay = await cfg('relay');
  assert.ok(
    relay.includes('[xrpl_relay]\nrelay.example 51235\nnetwork_id=1\n'),
  );
  assert.ok(relay.includes('[ips_fixed]\nt-v1 51235\nt-v2 51235\n'));
  assert.ok(!relay.includes('[port_pwa]'));
  assert.ok(!relay.includes('huge'));
  assert.ok(!relay.includes('validator_token'));
  assert.ok(!(await cfg('v1')).includes('t-relay'));
  assert.ok(
    (await readdir(join(dir, 'nodes', 'relay'))).includes('validators.txt'),
  );
});
