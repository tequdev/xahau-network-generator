import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remappedFromSecurityOptions, staleFromInspect } from './docker.ts';

test('staleFromInspect: only a differing local ID marks a project', () => {
  const rows = [
    { project: 'a', image: 'nginx:alpine', imageId: 'sha256:old' },
    { project: 'b', image: 'nginx:alpine', imageId: 'sha256:new' },
    { project: 'c', image: 'gone:latest', imageId: 'sha256:x' },
  ];
  const local = new Map([['nginx:alpine', 'sha256:new']]);
  assert.deepEqual([...staleFromInspect(rows, local)], ['a']);
});

test('remappedFromSecurityOptions: rootless or userns-remap only', () => {
  assert.equal(
    remappedFromSecurityOptions('name=seccomp,profile=builtin name=cgroupns'),
    false,
  );
  assert.equal(
    remappedFromSecurityOptions(
      'name=seccomp,profile=builtin name=rootless name=cgroupns',
    ),
    true,
  );
  assert.equal(remappedFromSecurityOptions('name=userns'), true);
  assert.equal(remappedFromSecurityOptions(''), false);
});
