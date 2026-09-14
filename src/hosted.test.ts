import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHosts, renderHostsLines, renderUnit } from './hosted.ts';
import { DEFAULT_IMPORT_VL_KEYS, HOSTED_DIR, hostedUnit } from './types.ts';
import type { NetworkSpec } from './types.ts';

const spec: NetworkSpec = {
  name: 't1',
  type: 'testnet',
  version: 'x',
  validators: 3,
  quorum: 2,
  networkId: 21339,
  domain: '127.0.0.1.nip.io',
  tls: false,
  portOffset: 0,
  importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  hosts: {
    node: '10.0.0.10',
    v1: '10.0.0.11',
    v2: '10.0.0.12',
    v3: '10.0.0.13',
  },
};

test('HOSTED_DIR/hostedUnit: the fixed paths every rm -rf / sed / systemctl string derives from', () => {
  assert.equal(HOSTED_DIR(spec), '/opt/xng/t1');
  assert.equal(hostedUnit(spec, 'v1'), 'xng-t1-v1');
});

test('renderUnit: WorkingDirectory/ExecStart use xahaudCommand, no stray single quote in the wrapped command', () => {
  const unit = renderUnit(spec, 'v1');
  assert.ok(unit.includes('Wants=network-online.target'));
  assert.ok(unit.includes('After=network-online.target'));
  assert.ok(unit.includes('WorkingDirectory=/opt/xng/t1/nodes/v1'));
  assert.ok(unit.includes("ExecStart=/bin/sh -c 'if [ -d db ]"));
  // The ExecStart line wraps the xahaud command in single quotes; the
  // command itself must not contain any, or the unit file breaks.
  const execLine = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  assert.ok(execLine);
  const inner = execLine.slice("ExecStart=/bin/sh -c '".length, -1);
  assert.ok(
    !inner.includes("'"),
    'xahaudCommand output must not contain a single quote',
  );
});

test('renderHostsLines: one line per host entry, marked for this network', () => {
  const lines = renderHostsLines(spec).trim().split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines.includes('10.0.0.10 t1-node # xng:t1'));
  assert.ok(lines.includes('10.0.0.11 t1-v1 # xng:t1'));
  assert.ok(lines.includes('10.0.0.12 t1-v2 # xng:t1'));
  assert.ok(lines.includes('10.0.0.13 t1-v3 # xng:t1'));
});

test('parseHosts: ok case', () => {
  const hosts = parseHosts(
    'node=10.0.0.10,v1=10.0.0.11,v2=10.0.0.12,v3=10.0.0.13',
    3,
  );
  assert.deepEqual(hosts, {
    node: '10.0.0.10',
    v1: '10.0.0.11',
    v2: '10.0.0.12',
    v3: '10.0.0.13',
  });
});

test('parseHosts: missing v2 is rejected', () => {
  assert.throws(
    () => parseHosts('node=10.0.0.10,v1=10.0.0.11,v3=10.0.0.13', 3),
    /missing: v2/,
  );
});

test('parseHosts: extra v9 is rejected', () => {
  assert.throws(
    () =>
      parseHosts(
        'node=10.0.0.10,v1=10.0.0.11,v2=10.0.0.12,v3=10.0.0.13,v9=10.0.0.19',
        3,
      ),
    /extra: v9/,
  );
});

test('parseHosts: bad IP is rejected', () => {
  assert.throws(
    () =>
      parseHosts('node=10.0.0.10,v1=not-an-ip,v2=10.0.0.12,v3=10.0.0.13', 3),
    /invalid IPv4 address/,
  );
});
