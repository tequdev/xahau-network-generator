import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  executionSteps,
  formatPlan,
  parseXngYml,
  plan,
  readWorkspace,
} from './apply.ts';
import { DEFAULT_IMPORT_VL_KEYS } from './types.ts';
import type { NetworkSpec } from './types.ts';

const V1 = '2026.6.21-release+3350';
const V2 = '2026.9.9-dev+3667';

// Exactly what `xng create` writes to network.json (src/cli.ts create action).
function created(over: Partial<NetworkSpec> & { name: string }): NetworkSpec {
  const standalone = over.type === 'standalone';
  return {
    type: 'testnet',
    version: V1,
    validators: standalone ? 1 : 3,
    quorum: standalone ? 1 : 2,
    networkId: 21339,
    domain: '127.0.0.1.nip.io',
    tls: false,
    root: false,
    portOffset: 0,
    importVlKeys: DEFAULT_IMPORT_VL_KEYS,
    ...over,
  };
}

function desiredOf(...yml: string[]): NetworkSpec[] {
  return parseXngYml(`networks:\n${yml.join('\n')}\n`);
}

const kinds = (actions: ReturnType<typeof plan>) =>
  Object.fromEntries(actions.map((a) => [a.name, a.kind]));
const argv = (steps: string[][]) => steps.map((s) => s.join(' '));

test('parseXngYml: a minimal entry gets the same defaults as xng create', () => {
  const [spec] = desiredOf(`  dev:\n    version: ${V2}`);
  assert.deepEqual(spec, {
    name: 'dev',
    type: 'testnet',
    version: V2,
    validators: 3,
    quorum: 2,
    networkId: 21339,
    domain: '127.0.0.1.nip.io',
    tls: false,
    root: false,
    portOffset: 0,
    importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  });
});

test('parseXngYml: missing version names the network', () => {
  assert.throws(
    () => desiredOf('  dev:\n    validators: 3'),
    /network "dev".*version/,
  );
});

test('parseXngYml: unknown key is an error', () => {
  assert.throws(
    () => desiredOf(`  dev:\n    version: ${V1}\n    validator: 3`),
    /unknown key.*validator/,
  );
});

test('parseXngYml: every validateSpec rule is enforced', () => {
  const bad: [string, RegExp][] = [
    [`  Bad_Name:\n    version: ${V1}`, /name must match/],
    [`  rpc:\n    version: ${V1}`, /reserved/],
    [`  a:\n    version: ${V1}\n    domain: Example.COM`, /domain must match/],
    [`  a:\n    version: ${V1}\n    validators: 2`, /validators must be/],
    [`  a:\n    version: ${V1}\n    quorum: 4`, /quorum must be/],
    [`  a:\n    version: ${V1}\n    portOffset: 14301`, /portOffset must be/],
    [`  a:\n    version: ${V1}\n    tls: "yes"`, /tls must be/],
    [
      `  a:\n    type: standalone\n    version: ${V1}\n    root: true`,
      /root is testnet only/,
    ],
    [
      `  a:\n    type: standalone\n    version: ${V1}\n    validators: 3`,
      /standalone/,
    ],
  ];
  for (const [yml, re] of bad) assert.throws(() => desiredOf(yml), re, yml);
});

test('parseXngYml: two root networks on one domain are rejected', () => {
  assert.throws(
    () =>
      desiredOf(
        `  a:\n    version: ${V1}\n    root: true`,
        `  b:\n    version: ${V1}\n    root: true`,
      ),
    /both set root/,
  );
});

test('parseXngYml: standalone networks with the same portOffset are rejected', () => {
  assert.throws(
    () =>
      desiredOf(
        `  a:\n    type: standalone\n    version: ${V1}`,
        `  b:\n    type: standalone\n    version: ${V1}`,
      ),
    /host port/,
  );
});

test('parseXngYml: missing networks is an error, empty networks is no networks', () => {
  assert.throws(() => parseXngYml('foo: 1\n'), /networks/);
  assert.throws(() => parseXngYml(''), /networks/);
  assert.throws(() => parseXngYml('networks: []\n'), /networks/);
  assert.deepEqual(parseXngYml('networks: {}\n'), []);
});

test('plan: create, remove, unchanged', () => {
  const desired = desiredOf(
    `  new:\n    version: ${V1}`,
    `  same:\n    version: ${V1}`,
  );
  const actual = [created({ name: 'same' }), created({ name: 'old' })];
  const actions = plan(desired, actual, new Set(['same']));
  assert.deepEqual(kinds(actions), {
    new: 'create',
    old: 'remove',
    same: 'unchanged',
  });
  const create = actions.find((a) => a.name === 'new');
  assert.equal(
    argv(create?.steps ?? [])[0],
    `create --name new --type testnet --version ${V1} --validators 3 --quorum 2 --network-id 21339 --domain 127.0.0.1.nip.io --port-offset 0`,
  );
  assert.equal(
    argv(create?.steps ?? [])[1],
    'start --name new --wait --timeout 300',
  );
});

test('plan: a network.json written by xng create is unchanged against a minimal yml (round trip)', () => {
  const desired = desiredOf(
    `  s1:\n    type: standalone\n    version: ${V1}`,
    `  t1:\n    version: ${V1}`,
  );
  const actual = [
    created({ name: 's1', type: 'standalone' }),
    created({ name: 't1' }),
  ];
  const actions = plan(desired, actual, new Set(['s1', 't1']));
  assert.deepEqual(kinds(actions), { s1: 'unchanged', t1: 'unchanged' });
});

test('plan: an old network.json without root matches root: false', () => {
  const { root: _root, ...old } = created({ name: 't1' });
  const actions = plan(
    desiredOf(`  t1:\n    version: ${V1}`),
    [old],
    new Set(['t1']),
  );
  assert.equal(actions[0]?.kind, 'unchanged');
});

test('plan: testnet version change is a rolling upgrade', () => {
  const actions = plan(
    desiredOf(`  t1:\n    version: ${V2}`),
    [created({ name: 't1' })],
    new Set(['t1']),
    { timeout: 600 },
  );
  assert.equal(actions[0]?.kind, 'upgrade');
  assert.deepEqual(argv(actions[0]?.steps ?? []), [
    `upgrade --name t1 --version ${V2} --timeout 600`,
  ]);
});

test('plan: upgrading a stopped testnet starts it first', () => {
  const actions = plan(
    desiredOf(`  t1:\n    version: ${V2}`),
    [created({ name: 't1' })],
    new Set(),
  );
  assert.deepEqual(argv(actions[0]?.steps ?? []), [
    'start --name t1 --wait --timeout 300',
    `upgrade --name t1 --version ${V2} --timeout 300`,
  ]);
});

test('plan: standalone version change is a recreate (xng upgrade is testnet only)', () => {
  const actions = plan(
    desiredOf(`  s1:\n    type: standalone\n    version: ${V2}`),
    [created({ name: 's1', type: 'standalone' })],
    new Set(['s1']),
  );
  assert.equal(actions[0]?.kind, 'recreate');
  assert.deepEqual(actions[0]?.diff, [{ key: 'version', from: V1, to: V2 }]);
  assert.deepEqual(
    actions[0]?.steps.map((s) => s[0]),
    ['remove', 'create', 'start'],
  );
});

test('plan: any other change is a recreate, even together with a version change', () => {
  const actions = plan(
    desiredOf(
      `  a:\n    version: ${V1}\n    validators: 4`,
      `  b:\n    version: ${V2}\n    validators: 4`,
    ),
    [created({ name: 'a' }), created({ name: 'b' })],
    new Set(['a', 'b']),
  );
  assert.deepEqual(kinds(actions), { a: 'recreate', b: 'recreate' });
  assert.deepEqual(
    actions[1]?.diff.map((c) => c.key),
    ['version', 'validators', 'quorum'],
  );
});

test('plan: matching but stopped is a start', () => {
  const actions = plan(
    desiredOf(`  t1:\n    version: ${V1}`),
    [created({ name: 't1' })],
    new Set(),
  );
  assert.equal(actions[0]?.kind, 'start');
  assert.deepEqual(argv(actions[0]?.steps ?? []), [
    'start --name t1 --wait --timeout 300',
  ]);
});

test('executionSteps: removes, then creates, then upgrades, then starts', () => {
  const desired = desiredOf(
    `  a:\n    version: ${V1}`, // create
    `  b:\n    version: ${V2}`, // upgrade
    `  c:\n    version: ${V1}\n    validators: 4`, // recreate
    `  e:\n    version: ${V1}`, // start
  );
  const actual = [
    created({ name: 'b' }),
    created({ name: 'c' }),
    created({ name: 'd' }), // remove
    created({ name: 'e' }),
  ];
  const steps = executionSteps(plan(desired, actual, new Set(['b', 'c'])));
  assert.deepEqual(
    steps.map((s) => `${s[0]} ${s[2]}`),
    [
      'remove c',
      'remove d',
      'create a',
      'start a',
      'create c',
      'start c',
      'upgrade b',
      'start e',
    ],
  );
});

test('plan --network: only the named networks are planned, removals included', () => {
  const desired = desiredOf(
    `  a:\n    version: ${V1}`,
    `  b:\n    version: ${V2}`,
  );
  const actual = [created({ name: 'b' }), created({ name: 'gone' })];
  assert.deepEqual(
    kinds(plan(desired, actual, new Set(['b']), { only: ['a'] })),
    { a: 'create' },
  );
  assert.deepEqual(
    kinds(plan(desired, actual, new Set(['b']), { only: ['gone'] })),
    { gone: 'remove' },
  );
  assert.throws(
    () => plan(desired, actual, new Set(), { only: ['nope'] }),
    /"nope"/,
  );
});

test('formatPlan: recreate shows every changed key and the wipe warning', () => {
  const actions = plan(
    desiredOf(
      `  s1:\n    type: standalone\n    version: ${V1}\n    portOffset: 4000`,
    ),
    [created({ name: 's1', type: 'standalone' })],
    new Set(['s1']),
  );
  const out = formatPlan(actions);
  assert.match(
    out,
    /^! s1 +recreate +portOffset 0 -> 4000 +\(ledger data and keys are wiped\)$/m,
  );
});

test('formatPlan: summary counts, row symbols and create description', () => {
  const desired = desiredOf(
    `  jshooks:\n    version: ${V1}\n    domain: xahau-dev.net\n    tls: true`,
    `  dev:\n    version: ${V2}`,
    `  t2:\n    version: ${V1}`,
  );
  const actual = [
    created({ name: 'dev' }),
    created({ name: 't2' }),
    created({ name: 'old' }),
  ];
  const out = formatPlan(plan(desired, actual, new Set(['dev', 't2'])));
  const [head] = out.split('\n');
  assert.equal(
    head,
    'xng apply: xng.yml -> 1 to create, 1 to upgrade, 1 to remove',
  );
  assert.match(
    out,
    /^\+ jshooks +create +testnet .*, 3 validators, xahau-dev\.net \(tls\)$/m,
  );
  assert.match(
    out,
    /^~ dev +upgrade +version .* -> .* +\(rolling, no downtime\)$/m,
  );
  assert.match(out, /^- old +remove +\(ledger data and keys are deleted\)$/m);
  assert.match(out, /^= t2 +unchanged$/m);
});

test('plan --network: a recreate that collides with an untouched on-disk network is an error', () => {
  // The yml moves s1 to 4000 and s2 away from it, but only s1 is applied.
  const desired = desiredOf(
    `  s1:\n    type: standalone\n    version: ${V1}\n    portOffset: 4000`,
    `  s2:\n    type: standalone\n    version: ${V1}\n    portOffset: 8000`,
  );
  const actual = [
    created({ name: 's1', type: 'standalone' }),
    created({ name: 's2', type: 'standalone', portOffset: 4000 }),
  ];
  assert.throws(
    () => plan(desired, actual, new Set(['s1', 's2']), { only: ['s1'] }),
    /host port/,
  );
});

const ZONE = { zone: 'xahau-dev.net' };

test('formatPlan: with a zone, lists certificate packs ordered and deleted', () => {
  const desired = desiredOf(
    `  jshooks:\n    version: ${V1}\n    domain: xahau-dev.net\n    tls: true`,
    `  apex:\n    version: ${V1}\n    domain: xahau-dev.net\n    tls: true\n    root: true`,
    `  s1:\n    type: standalone\n    version: ${V1}`,
  );
  const actual = [
    created({ name: 'old', domain: 'xahau-dev.net', tls: true }),
    created({ name: 'plain' }),
  ];
  const out = formatPlan(plan(desired, actual, new Set()), 'xng.yml', ZONE);
  assert.match(out, /^cloudflare \(XNG_CF_ZONE=xahau-dev\.net\):$/m);
  assert.match(
    out,
    /^ {2}\+ certificate \*\.jshooks\.xahau-dev\.net +\(jshooks: ordered by create\)$/m,
  );
  assert.match(
    out,
    /^ {2}- certificate \*\.old\.xahau-dev\.net +\(old: deleted by remove\)$/m,
  );
  assert.equal(
    out.match(/certificate/g)?.length,
    2,
    'apex and standalone add no line',
  );
});

test('formatPlan: without a zone, warns for tls testnets that would need certificates', () => {
  const desired = desiredOf(
    `  jshooks:\n    version: ${V1}\n    domain: xahau-dev.net\n    tls: true`,
  );
  const out = formatPlan(
    plan(desired, [created({ name: 'old', tls: true })], new Set()),
  );
  assert.match(
    out,
    /^cloudflare: XNG_CF_ZONE is not set, .*ordered for jshooks or deleted for old /m,
  );
});

test('formatPlan: nothing tls means no cloudflare output', () => {
  const desired = desiredOf(`  a:\n    version: ${V1}`);
  const actions = plan(desired, [created({ name: 'b' })], new Set());
  assert.ok(!/cloudflare/.test(formatPlan(actions)));
  assert.ok(!/cloudflare/.test(formatPlan(actions, 'xng.yml', ZONE)));
});

test('xng.example.yml parses (the template cannot drift from the parser)', () => {
  const text = readFileSync(
    new URL('../xng.example.yml', import.meta.url),
    'utf8',
  );
  assert.equal(parseXngYml(text).length, 4);
});

test('plan with a zone: removing a network outside the zone does not throw', () => {
  const actions = plan(
    [],
    [created({ name: 'old', domain: 'other.example', tls: true })],
    new Set(),
  );
  const out = formatPlan(actions, 'xng.yml', ZONE);
  assert.match(out, /^- old +remove/m);
  assert.ok(!/certificate/.test(out));
});

test('readWorkspace: valid networks are returned, anything else aborts naming the directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xng-ws-'));
  const put = (name: string, json?: unknown) => {
    mkdirSync(join(dir, name));
    if (json !== undefined) {
      writeFileSync(join(dir, name, 'network.json'), JSON.stringify(json));
    }
  };
  try {
    writeFileSync(join(dir, 'stray-file'), '');
    put('good', created({ name: 'good' }));
    assert.deepEqual(
      (await readWorkspace(dir)).map((s) => s.name),
      ['good'],
    );

    put('empty');
    await assert.rejects(
      readWorkspace(dir),
      /workspace\/empty is not a valid network/,
    );
    rmSync(join(dir, 'empty'), { recursive: true });

    put('moved', created({ name: 'other' }));
    await assert.rejects(
      readWorkspace(dir),
      /workspace\/moved .*name is "other"/,
    );
    rmSync(join(dir, 'moved'), { recursive: true });

    put('x', { name: 'x' });
    await assert.rejects(readWorkspace(dir), /workspace\/x .*type must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseXngYml: nodeConfig is normalized to section -> lines', () => {
  const [spec] = desiredOf(
    `  dev:\n    version: ${V2}\n    nodeConfig:\n      node_size: huge\n      voting:\n        reference_fee: 100`,
  );
  assert.deepEqual(spec?.nodeConfig, {
    node_size: ['huge'],
    voting: ['reference_fee = 100'],
  });
  assert.throws(
    () => desiredOf(`  dev:\n    version: ${V2}\n    nodeConfig: 5`),
    /nodeConfig must be a mapping/,
  );
});

test('plan: a nodeConfig change recreates and create carries --node-config', () => {
  const actions = plan(
    desiredOf(
      `  t1:\n    version: ${V1}\n    nodeConfig:\n      node_size: huge`,
    ),
    [created({ name: 't1' })],
    new Set(['t1']),
  );
  assert.equal(actions[0]?.kind, 'recreate');
  assert.equal(actions[0]?.diff[0]?.key, 'nodeConfig');
  assert.ok(
    argv(actions[0]?.steps ?? [])[1]?.endsWith(
      `--node-config {"node_size":["huge"]}`,
    ),
  );
});

test('plan: a missing or empty nodeConfig on disk matches a yml without one', () => {
  for (const nodeConfig of [undefined, {}]) {
    const actions = plan(
      desiredOf(`  t1:\n    version: ${V1}`),
      [created({ name: 't1', nodeConfig })],
      new Set(['t1']),
    );
    assert.equal(actions[0]?.kind, 'unchanged');
  }
});
