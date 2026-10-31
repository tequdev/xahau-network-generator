import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseValidatorsOutput, planRotation } from './rotate.ts';
import type { NetworkSpec } from './types.ts';

const spec: NetworkSpec = {
  name: 't',
  type: 'testnet',
  version: 'x',
  validators: 3,
  quorum: 2,
  networkId: 21339,
  domain: 'localhost',
  tls: false,
  portOffset: 0,
  importVlKeys: [],
};

test('planRotation: full rotation', () => {
  const p = planRotation(spec, { add: 3, remove: ['v1', 'v2', 'v3'] });
  assert.deepEqual(p.interim.validatorIds, [1, 2, 3, 4, 5, 6]);
  assert.equal(p.interim.validators, 6);
  assert.equal(p.interim.quorum, 2);
  assert.deepEqual(p.final.validatorIds, [4, 5, 6]);
  assert.equal(p.final.quorum, 2);
  assert.deepEqual(p.added, ['v4', 'v5', 'v6']);
  assert.deepEqual(p.removed, ['v1', 'v2', 'v3']);
});

test('planRotation: interim starts with the final quorum, unchanged count keeps the spec quorum', () => {
  const grow = planRotation(spec, { add: 2, remove: [] });
  assert.equal(grow.final.quorum, 4);
  assert.equal(grow.interim.quorum, grow.final.quorum);
  const same = planRotation({ ...spec, quorum: 3 }, { add: 1, remove: ['v1'] });
  assert.equal(same.interim.quorum, 3);
  assert.equal(same.final.quorum, 3);
});

test('planRotation: partial, ids continue from the max and quorum follows the count', () => {
  const p = planRotation(
    { ...spec, validatorIds: [2, 5, 6] },
    { add: 2, remove: ['v5'] },
  );
  assert.deepEqual(p.final.validatorIds, [2, 6, 7, 8]);
  assert.equal(p.final.validators, 4);
  assert.equal(p.final.quorum, 3);
});

test('planRotation: rejects bad input', () => {
  assert.throws(
    () => planRotation(spec, { add: 0, remove: [] }),
    /nothing to rotate/,
  );
  assert.throws(
    () => planRotation(spec, { add: 1, remove: ['v9'] }),
    /not a validator.*v1, v2, v3/,
  );
  assert.throws(
    () => planRotation(spec, { add: 0, remove: ['v1'] }),
    /validators must be/,
  );
  assert.throws(
    () => planRotation({ ...spec, type: 'standalone' }, { add: 1, remove: [] }),
    /testnet only/,
  );
});

test('parseValidatorsOutput: trusted keys; bad output throws', () => {
  const out = JSON.stringify({
    result: { trusted_validator_keys: ['nA', 'nB'] },
  });
  assert.deepEqual(parseValidatorsOutput(out), { trusted: ['nA', 'nB'] });
  assert.throws(() => parseValidatorsOutput('nope'), /could not parse/);
  assert.throws(() => parseValidatorsOutput('{"result":{}}'), /unexpected/);
});

test('planRotation: a 1-validator network can only grow', () => {
  const one = { ...spec, validators: 1, quorum: 1 };
  assert.throws(() => planRotation(one, { add: 1, remove: ['v1'] }), /--add 2/);
  const { interim, final } = planRotation(one, { add: 2, remove: [] });
  assert.deepEqual(interim.validatorIds, [1, 2, 3]);
  assert.equal(interim.quorum, 2);
  assert.deepEqual(final.validatorIds, [1, 2, 3]);
  assert.equal(final.quorum, 2);
});
