import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeatureOutput } from './vote.ts';

test('parseFeatureOutput picks the hash-keyed entry', () => {
  const f = parseFeatureOutput(
    '{"result":{"AB12":{"name":"fixFoo","enabled":false,"vetoed":false,"count":1,"threshold":3},"status":"success"}}',
  );
  assert.deepEqual(f, {
    hash: 'AB12',
    name: 'fixFoo',
    enabled: false,
    vetoed: false,
    count: 1,
    threshold: 3,
  });
});

test('parseFeatureOutput throws the node error message', () => {
  assert.throws(
    () =>
      parseFeatureOutput(
        '{"result":{"error":"badFeature","error_message":"Feature unknown or invalid.","status":"error"}}',
      ),
    /Feature unknown or invalid/,
  );
});
