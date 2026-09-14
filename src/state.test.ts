import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffSpec,
  loadState,
  parseState,
  specFor,
  stringifyState,
} from './state.ts';

const YML = `
domain: xahau-dev.net
tls: true
networks:
  jshooks:
    version: 2026.9.8-jshooks+3640
  dev:
    version: 2026.9.9-dev+3667
    root: true
    validators: 5
    enabled: false
`;

test('parseState: defaults fill in like the CLI flags', () => {
  const state = parseState(YML);
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

test('parseState: round-trips through stringifyState; an empty file is an empty declaration', () => {
  const state = parseState(YML);
  assert.deepEqual(parseState(stringifyState(state)), state);
  assert.deepEqual(parseState(''), { networks: {} });
});

test('parseState: rejects what create would reject', () => {
  for (const bad of [
    'networks:\n  explorer:\n    version: v',
    'networks:\n  Bad:\n    version: v',
    'networks:\n  a:\n    validators: 3',
    'networks:\n  a:\n    version: v\n    validators: 2',
    'networks:\n  a:\n    version: v\n    root: true\n  b:\n    version: v\n    root: true',
    'networks:\n  a:\n    version: v\n    type: standalone\n    root: true',
    'domain: Bad Domain',
    'acme_email: not an email',
    'networks: 1',
    '- a list',
    'just a string',
    'not: [yaml',
    'validatorz: 1',
    'network:\n  a:\n    version: v',
    'networks:\n  a:\n    version: v\n    validatorz: 3',
    'networks:\n  a:\n    version: v\n    quorum: 4',
    'networks:\n  a:\n    version: 2026.9',
  ]) {
    assert.throws(() => parseState(bad), /xng\.yml/, bad);
  }
});

test('diffSpec: version is a rolling upgrade, routing is a re-render, the rest is refused', () => {
  const state = parseState(YML);
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
  assert.deepEqual(await loadState('/nonexistent/xng.yml'), { networks: {} });
  await assert.rejects(loadState('/nonexistent/xng.yml', true), /nonexistent/);
});
