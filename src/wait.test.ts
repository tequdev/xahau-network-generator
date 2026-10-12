import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText } from './wait.ts';

test('errorText: appends the fetch cause when there is one', () => {
  assert.equal(errorText(new Error('fetch failed')), 'fetch failed');
  const err = new Error('fetch failed', {
    cause: new Error('connect ECONNREFUSED 127.0.0.1:80'),
  });
  assert.equal(
    errorText(err),
    'fetch failed: connect ECONNREFUSED 127.0.0.1:80',
  );
});
