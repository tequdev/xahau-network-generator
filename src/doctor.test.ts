import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CF_VERSION } from './cloudflare.ts';
import { legacyAcmeEnvProblem } from './docker.ts';
import {
  checkCf,
  checkCompose,
  checkNode,
  checkPrivilegedPorts,
  report,
} from './doctor.ts';

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

test('checkPrivilegedPorts: only under rootless/userns, fails above port 80', () => {
  assert.equal(checkPrivilegedPorts(false, 1024), undefined);
  assert.equal(checkPrivilegedPorts(true, undefined), undefined);
  assert.equal(checkPrivilegedPorts(true, 1024)?.status, 'fail');
  assert.equal(checkPrivilegedPorts(true, 80)?.status, 'ok');
  assert.equal(checkPrivilegedPorts(true, 0)?.status, 'ok');
});

test('legacy acme.env is reported, not migrated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xng-acme-'));
  const legacy = join(dir, 'legacy.env');
  const current = join(dir, 'current.env');
  assert.equal(legacyAcmeEnvProblem(legacy, current), undefined);
  writeFileSync(legacy, 'XNG_ACME_EMAIL=x@example.com\n');
  const moved = legacyAcmeEnvProblem(legacy, current);
  assert.match(moved ?? '', /mv /);
  assert.ok(moved?.includes(current));
  writeFileSync(current, 'XNG_ACME_EMAIL=x@example.com\n');
  assert.match(legacyAcmeEnvProblem(legacy, current) ?? '', /delete/);
});
