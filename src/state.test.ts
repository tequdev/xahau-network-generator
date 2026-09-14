import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffSpec,
  loadState,
  parseState,
  specFor,
  stringifyState,
} from './state.ts';

const TOML = `
domain = "xahau-dev.net"
tls = true

[networks.jshooks]
version = "2026.9.8-jshooks+3640"

[networks.dev]
version = "2026.9.9-dev+3667"
root = true
validators = 5
enabled = false
`;

test('parseState: defaults fill in like the CLI flags', () => {
  const state = parseState(TOML);
  const js = specFor(
    'jshooks',
    state.networks?.jshooks ?? { version: '' },
    state,
  );
  assert.equal(js.type, 'testnet');
  assert.equal(js.validators, 3);
  assert.equal(js.quorum, 2);
  assert.equal(js.domain, 'xahau-dev.net');
  assert.equal(js.tls, true);
  assert.equal(js.root, false);
  const dev = specFor('dev', state.networks?.dev ?? { version: '' }, state);
  assert.equal(dev.root, true);
  assert.equal(dev.validators, 5);
  assert.equal(dev.quorum, 4);
});

test('parseState: round-trips through stringifyState', () => {
  const state = parseState(TOML);
  assert.deepEqual(parseState(stringifyState(state)), state);
});

test('parseState: rejects what create would reject', () => {
  for (const bad of [
    '[networks.explorer]\nversion = "v"',
    '[networks.Bad]\nversion = "v"',
    '[networks.a]\nvalidators = 3',
    '[networks.a]\nversion = "v"\nvalidators = 2',
    '[networks.a]\nversion = "v"\nroot = true\n[networks.b]\nversion = "v"\nroot = true',
    '[networks.a]\nversion = "v"\ntype = "standalone"\nroot = true',
    'domain = "Bad Domain"',
    'acme_email = "not an email"',
    'networks = 1',
    'not toml [[',
    'validatorz = 1',
    '[network.a]\nversion = "v"',
    '[networks.a]\nversion = "v"\nvalidatorz = 3',
    '[networks.a]\nversion = "v"\nquorum = 4',
  ]) {
    assert.throws(() => parseState(bad), /xng\.toml/, bad);
  }
});

test('diffSpec: version is a rolling upgrade, routing is a re-render, the rest is refused', () => {
  const state = parseState(TOML);
  const decl = state.networks?.jshooks ?? { version: '' };
  const actual = specFor('jshooks', decl, state);

  assert.deepEqual(diffSpec(actual, actual), {
    routing: false,
    incompatible: [],
  });

  const newer = specFor('jshooks', { ...decl, version: 'v2' }, state);
  assert.deepEqual(diffSpec(newer, actual).version, {
    from: '2026.9.8-jshooks+3640',
    to: 'v2',
  });

  const moved = specFor(
    'jshooks',
    { ...decl, root: true },
    { ...state, tls: false },
  );
  assert.equal(diffSpec(moved, actual).routing, true);
  assert.deepEqual(diffSpec(moved, actual).incompatible, []);

  const bigger = specFor('jshooks', { ...decl, validators: 5 }, state);
  assert.deepEqual(diffSpec(bigger, actual).incompatible, [
    'validators',
    'quorum',
  ]);

  const standalone = specFor('s', { version: 'a', type: 'standalone' }, state);
  assert.deepEqual(
    diffSpec({ ...standalone, version: 'b' }, standalone).incompatible,
    ['version'],
  );
});

test('loadState: a missing file is empty for the panel but an error for apply', async () => {
  assert.deepEqual(await loadState('/nonexistent/xng.toml'), { networks: {} });
  await assert.rejects(loadState('/nonexistent/xng.toml', true), /nonexistent/);
});
