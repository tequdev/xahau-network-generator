import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  certHosts,
  cfConfigFromEnv,
  cfRunner,
  ensureCertificate,
  removeCertificate,
} from './cloudflare.ts';
import type { CertificatePack, CfConfig, CfRunner } from './cloudflare.ts';
import { DEFAULT_IMPORT_VL_KEYS } from './types.ts';
import type { NetworkSpec } from './types.ts';

const spec: NetworkSpec = {
  name: 'jshooks',
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

const cfg: CfConfig = {
  zone: 'xahau-dev.net',
  ca: 'google',
  timeoutMs: 60_000,
};

// A fake `cf`: records every call and answers list/create/get/delete from
// an in-memory set of packs whose status advances on each `get`.
function fakeCf(initial: CertificatePack[], progression: string[] = []) {
  const packs = new Map(initial.map((p) => [p.id, { ...p }]));
  const calls: string[][] = [];
  let nextId = 1;
  const run: CfRunner = async (args) => {
    calls.push(args);
    const [, , verb, id] = args;
    if (verb === 'list') return [...packs.values()];
    if (verb === 'create') {
      const hosts: string[] = [];
      args.forEach((a, i) => {
        if (a === '--hosts') hosts.push(args[i + 1] as string);
      });
      const pack = {
        id: `new-${nextId++}`,
        type: 'advanced',
        status: 'initializing',
        hosts,
      };
      packs.set(pack.id, pack);
      return pack;
    }
    if (verb === 'get') {
      const pack = packs.get(id as string);
      assert.ok(pack);
      const status = progression.shift();
      if (status) pack.status = status;
      return pack;
    }
    if (verb === 'delete') {
      packs.delete(id as string);
      return { id };
    }
    throw new Error(`unexpected cf call: ${args.join(' ')}`);
  };
  return { run, calls, packs };
}

const quiet = { log: () => {}, sleep: async () => {}, pollMs: 1 };

test('certHosts: nested network needs the wildcard of its own base', () => {
  assert.deepEqual(certHosts(spec, 'xahau-dev.net'), [
    'xahau-dev.net',
    '*.jshooks.xahau-dev.net',
  ]);
});

test('certHosts: root network on the apex is covered by Universal SSL', () => {
  assert.equal(certHosts({ ...spec, root: true }, 'xahau-dev.net'), undefined);
});

test('certHosts: nothing for non-TLS or standalone networks', () => {
  assert.equal(certHosts({ ...spec, tls: false }, 'xahau-dev.net'), undefined);
  assert.equal(
    certHosts({ ...spec, type: 'standalone' }, 'xahau-dev.net'),
    undefined,
  );
});

test('certHosts: --domain below the zone also needs the base itself', () => {
  assert.deepEqual(
    certHosts({ ...spec, domain: 'dev.example.com' }, 'example.com'),
    ['example.com', '*.jshooks.dev.example.com', 'jshooks.dev.example.com'],
  );
  // root network on a subdomain of the zone: `*.dev.example.com` only
  assert.deepEqual(
    certHosts(
      { ...spec, root: true, domain: 'dev.example.com' },
      'example.com',
    ),
    ['example.com', '*.dev.example.com'],
  );
});

test('certHosts: refuses a domain outside the zone', () => {
  assert.throws(() => certHosts(spec, 'example.com'), /outside that zone/);
  // suffix match must be on a label boundary
  assert.throws(
    () => certHosts({ ...spec, domain: 'notxahau-dev.net' }, 'xahau-dev.net'),
    /outside that zone/,
  );
});

test('cfConfigFromEnv: disabled without XNG_CF_ZONE, validates the rest', () => {
  assert.equal(cfConfigFromEnv({}), undefined);
  assert.deepEqual(cfConfigFromEnv({ XNG_CF_ZONE: 'Xahau-Dev.net' }), {
    zone: 'xahau-dev.net',
    ca: 'google',
    timeoutMs: 900_000,
  });
  assert.throws(
    () => cfConfigFromEnv({ XNG_CF_ZONE: 'a.b', XNG_CF_CA: 'digicert' }),
    /XNG_CF_CA/,
  );
  assert.throws(
    () => cfConfigFromEnv({ XNG_CF_ZONE: 'a.b', XNG_CF_CERT_TIMEOUT: '0' }),
    /XNG_CF_CERT_TIMEOUT/,
  );
});

test('ensureCertificate: orders a pack and waits until it is active', async () => {
  const cf = fakeCf([], ['pending_validation', 'pending_deployment', 'active']);
  await ensureCertificate(spec, cfg, { ...quiet, run: cf.run });
  const create = cf.calls.find((c) => c[2] === 'create');
  assert.ok(create);
  // one --hosts flag per host (cf does not split a comma-separated value)
  assert.deepEqual(
    create.filter((_, i) => create[i - 1] === '--hosts'),
    ['xahau-dev.net', '*.jshooks.xahau-dev.net'],
  );
  assert.equal(create[create.indexOf('--certificate-authority') + 1], 'google');
  assert.equal(create[create.indexOf('--validation-method') + 1], 'txt');
  assert.equal(cf.calls.filter((c) => c[2] === 'get').length, 3);
});

test('ensureCertificate: reuses an existing live pack (idempotent start)', async () => {
  const cf = fakeCf([
    {
      id: 'p1',
      type: 'advanced',
      status: 'active',
      hosts: ['xahau-dev.net', '*.jshooks.xahau-dev.net'],
    },
  ]);
  await ensureCertificate(spec, cfg, { ...quiet, run: cf.run });
  assert.deepEqual(
    cf.calls.map((c) => c[2]),
    ['list'],
  );
});

test('ensureCertificate: a timed-out pack is replaced, a failing one throws', async () => {
  const cf = fakeCf(
    [
      {
        id: 'old',
        type: 'advanced',
        status: 'validation_timed_out',
        hosts: ['xahau-dev.net', '*.jshooks.xahau-dev.net'],
      },
    ],
    ['issuance_timed_out'],
  );
  await assert.rejects(
    ensureCertificate(spec, cfg, { ...quiet, run: cf.run }),
    /ended in "issuance_timed_out"/,
  );
  assert.ok(cf.calls.some((c) => c[2] === 'create'));
});

test('ensureCertificate: gives up after the timeout', async () => {
  const cf = fakeCf([], []);
  let t = 0;
  await assert.rejects(
    ensureCertificate(
      spec,
      { ...cfg, timeoutMs: 30_000 },
      {
        ...quiet,
        run: cf.run,
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
        pollMs: 10_000,
      },
    ),
    /still "initializing" after 30s/,
  );
});

test('ensureCertificate: no cf calls when Universal SSL suffices', async () => {
  const cf = fakeCf([]);
  await ensureCertificate({ ...spec, root: true }, cfg, {
    ...quiet,
    run: cf.run,
  });
  assert.equal(cf.calls.length, 0);
});

test('removeCertificate: deletes only packs xng ordered for this network', async () => {
  const cf = fakeCf([
    {
      id: 'ours',
      type: 'advanced',
      status: 'active',
      hosts: ['xahau-dev.net', '*.jshooks.xahau-dev.net'],
    },
    {
      id: 'handmade',
      type: 'advanced',
      status: 'active',
      hosts: [
        'xahau-dev.net',
        '*.jshooks.xahau-dev.net',
        'other.xahau-dev.net',
      ],
    },
    {
      id: 'sibling',
      type: 'advanced',
      status: 'active',
      hosts: ['xahau-dev.net', '*.dev.xahau-dev.net'],
    },
    {
      id: 'universal',
      type: 'universal',
      status: 'active',
      hosts: ['xahau-dev.net', '*.xahau-dev.net'],
    },
  ]);
  await removeCertificate(spec, cfg, { log: () => {}, run: cf.run });
  const deleted = cf.calls.filter((c) => c[2] === 'delete').map((c) => c[3]);
  assert.deepEqual(deleted, ['ours']);
  const del = cf.calls.find((c) => c[2] === 'delete');
  assert.ok(del?.includes('--force'));
});

// A fake `cf` binary whose behaviour is picked by its first argument.
async function withFakeCfBin(fn: (bin: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'xng-fakecf-'));
  const bin = path.join(dir, 'cf');
  await writeFile(
    bin,
    `#!/bin/sh
case "$1" in
  envelope) echo '{"success":true,"errors":[],"result":[{"id":"p1"}]}' ;;
  bare) echo '{"id":"p1"}' ;;
  empty) ;;
  fail) echo 'boom from cf' >&2; exit 1 ;;
  text) echo 'not json' ;;
  token) echo "{\\"token\\":\\"$CLOUDFLARE_API_TOKEN\\"}" ;;
esac
`,
  );
  await chmod(bin, 0o755);
  try {
    await fn(bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('cfRunner: parses cf output, unwrapping the API envelope', () =>
  withFakeCfBin(async (bin) => {
    const run = cfRunner(bin);
    assert.deepEqual(await run(['envelope']), [{ id: 'p1' }]);
    assert.deepEqual(await run(['bare']), { id: 'p1' });
    assert.equal(await run(['empty']), undefined);
  }));

test('cfRunner: reports failures, bad output and a missing binary', () =>
  withFakeCfBin(async (bin) => {
    const run = cfRunner(bin);
    await assert.rejects(
      run(['fail', 'x']),
      (e: Error) =>
        e.message.includes('fail x') && /boom from cf/.test(e.message),
    );
    await assert.rejects(run(['text']), /non-JSON output/);
    await assert.rejects(cfRunner(`${bin}-missing`)(['bare']), /not found/);
  }));

test('cfRunner: passes CLOUDFLARE_API_TOKEN through to cf', () =>
  withFakeCfBin(async (bin) => {
    const saved = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = 'tok-123';
    try {
      assert.deepEqual(await cfRunner(bin)(['token']), { token: 'tok-123' });
    } finally {
      // biome-ignore lint/performance/noDelete: assigning undefined would set the string "undefined"
      if (saved === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = saved;
    }
  }));

// Contract test against the real cf: `--dry-run` needs no auth and prints
// the request cf would send, proving our flag names and value shapes are
// what the installed cf parses.
const cfBin = process.env.XNG_CF_BIN || 'cf';
const hasCf = spawnSync(cfBin, ['--version']).status === 0;

test(
  'cf contract: ensure/removeCertificate build the expected API requests',
  { skip: !hasCf && 'cf CLI not installed' },
  async () => {
    const real = cfRunner(cfBin);
    const requests: {
      method: string;
      url: string;
      query?: unknown;
      body?: unknown;
    }[] = [];
    const cf = fakeCf([], ['active']);
    const run: CfRunner = async (args) => {
      requests.push(
        (await real([...args, '--dry-run'])) as (typeof requests)[number],
      );
      return cf.run(args);
    };
    await ensureCertificate(spec, cfg, { ...quiet, run });
    await removeCertificate(spec, cfg, { log: () => {}, run });

    const base =
      'https://api.cloudflare.com/client/v4/zones/xahau-dev.net/ssl/certificate_packs';
    const pick = ({ method, url, query, body }: (typeof requests)[number]) => ({
      method,
      url,
      ...(query ? { query } : {}),
      ...(body ? { body } : {}),
    });
    const list = {
      method: 'GET',
      url: base,
      query: { page: 1, per_page: 50, status: 'all' },
    };
    assert.deepEqual(requests.map(pick), [
      list,
      {
        method: 'POST',
        url: `${base}/order`,
        body: {
          certificate_authority: 'google',
          hosts: ['xahau-dev.net', '*.jshooks.xahau-dev.net'],
          type: 'advanced',
          validation_method: 'txt',
          validity_days: 90,
        },
      },
      { method: 'GET', url: `${base}/new-1` },
      list,
      { method: 'DELETE', url: `${base}/new-1` },
    ]);
  },
);
