import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CF_VERSION } from './cloudflare.ts';
import { checkCf, checkCompose, checkNode, report } from './doctor.ts';

test('node and compose version gates', () => {
  assert.equal(checkNode('v22.12.0').status, 'ok');
  assert.equal(checkNode('v20.19.0').status, 'fail');
  assert.equal(checkCompose('2.29.7').status, 'ok');
  assert.equal(checkCompose('1.29.2').status, 'fail');
  assert.equal(checkCompose(undefined).status, 'fail');
});

test('cf version gate', () => {
  assert.equal(checkCf(undefined, false).status, 'info');
  assert.equal(checkCf(undefined, true).status, 'fail');
  assert.equal(checkCf('0.0.1', false).status, 'fail');
  assert.equal(checkCf(CF_VERSION, false).status, 'ok');
});

test('report fails only on required checks', () => {
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(report([{ name: 'a', status: 'info', detail: 'off' }]), true);
    assert.equal(
      report([
        { name: 'a', status: 'ok', detail: '' },
        { name: 'b', status: 'fail', detail: '' },
      ]),
      false,
    );
  } finally {
    console.log = log;
  }
});
