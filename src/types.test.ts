import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultQuorum } from './types.ts';

test('defaultQuorum: single validator stays 1', () => {
  assert.equal(defaultQuorum(1), 1);
});

test('defaultQuorum: capped at validators - 1 so one validator can restart without pausing consensus', () => {
  assert.equal(defaultQuorum(3), 2);
  assert.equal(defaultQuorum(4), 3);
  assert.equal(defaultQuorum(5), 4);
  assert.equal(defaultQuorum(6), 5);
  assert.equal(defaultQuorum(10), 8);
});
