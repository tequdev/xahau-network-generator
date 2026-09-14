import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planState } from './apply.ts';
import { parseState, specFor } from './state.ts';

// A workspace with two existing networks: `js` as declared, `old` whose
// declaration is gone, and `big` declared with a different validator count.
async function workspaceFor(toml: string): Promise<string> {
  const state = parseState(toml);
  const ws = await mkdtemp(join(tmpdir(), 'xng-apply-'));
  const put = async (name: string, spec: object) => {
    await mkdir(join(ws, name));
    await writeFile(join(ws, name, 'network.json'), JSON.stringify(spec));
  };
  const js = state.networks?.js ?? { version: '' };
  await put('js', specFor('js', js, state));
  await put('old', specFor('old', { version: 'v0' }, state));
  await put('big', specFor('big', { version: 'v0', validators: 3 }, state));
  return ws;
}

const TOML = `
[networks.js]
version = "v1"

[networks.big]
version = "v0"
validators = 5

[networks.fresh]
version = "v1"

[networks.parked]
version = "v1"
enabled = false
`;

test('planState: converges in place, creates, removes, and refuses rather than resets', async () => {
  const ws = await workspaceFor(TOML);
  const plans = await planState(parseState(TOML), ws);
  const byName = Object.fromEntries(plans.map((p) => [p.name, p]));
  assert.deepEqual(byName.js?.actions, ['up']);
  assert.deepEqual(byName.fresh?.actions, ['create', 'up']);
  assert.deepEqual(byName.parked?.actions, ['create']);
  assert.deepEqual(byName.old?.actions, ['remove']);
  assert.deepEqual(byName.big?.actions, ['refuse']);
  assert.match(byName.big?.reason ?? '', /validators/);
  assert.ok(!plans.some((p) => p.actions.includes('reset' as never)));
});

test('planState: version change on a running network is up + upgrade; disabled is down', async () => {
  const ws = await workspaceFor(TOML);
  const bumped = TOML.replace(
    '[networks.js]\nversion = "v1"',
    '[networks.js]\nversion = "v2"',
  );
  const plans = await planState(parseState(bumped), ws, 'js');
  assert.deepEqual(
    plans.map((p) => p.name),
    ['js'],
  );
  assert.deepEqual(plans[0]?.actions, ['up', 'upgrade']);

  const parked = TOML.replace(
    '[networks.js]\nversion = "v1"',
    '[networks.js]\nversion = "v1"\nenabled = false',
  );
  assert.deepEqual(
    (await planState(parseState(parked), ws, 'js'))[0]?.actions,
    ['down'],
  );
});

test('planState: --only removes an undeclared network but leaves the others alone', async () => {
  const ws = await workspaceFor(TOML);
  const plans = await planState(parseState(TOML), ws, 'old');
  assert.deepEqual(plans, [
    { name: 'old', actual: plans[0]?.actual, actions: ['remove'] },
  ]);
});
