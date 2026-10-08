import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNetwork, writeSiteIndex } from './network.ts';
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

test('writeSiteIndex: lists same-domain testnets (external too), root first, no standalones, other domains or landing: false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xng-site-'));
  for (const s of [
    spec({ name: 'zeta', root: true }),
    spec({ name: 'beta' }),
    spec({ name: 'foo', version: '', external: true }),
    spec({ name: 'hidden', landing: false }),
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
