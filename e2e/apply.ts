// Exercises `xng apply` end to end against a real testnet: dry-run and
// refusal leave nothing behind, apply creates, is idempotent, upgrades,
// restarts a stopped network, --network isolates, and an empty file removes.
// apply owns all of workspace/, so this refuses to run when any directory
// other than apply1 is there, so a local run cannot wipe someone's networks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';

const NAME = 'apply1';
const YML = join(mkdtempSync(join(tmpdir(), 'xng-apply-')), 'xng.yml');

function run(
  cmd: string,
  args: string[],
  stdin: 'inherit' | 'ignore' = 'inherit',
): { status: number | null; out: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: [stdin, 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  return { status: result.status, out: result.stdout };
}

function apply(args: string[], stdin: 'inherit' | 'ignore' = 'inherit') {
  return run('pnpm', ['xng', 'apply', '-f', YML, ...args], stdin);
}

function e2e(...args: string[]): void {
  assert.equal(run('pnpm', ['e2e', '--name', NAME, ...args]).status, 0);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      'upgrade-to': { type: 'string' },
      domain: { type: 'string', default: '127.0.0.1.nip.io' },
      timeout: { type: 'string', default: '600' },
    },
  });
  const version = values.version;
  const upgradeTo = values['upgrade-to'];
  if (!version || !upgradeTo) {
    throw new Error('--version and --upgrade-to are required');
  }
  const timeout = values.timeout as string;

  const others = existsSync('workspace')
    ? readdirSync('workspace', { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== NAME)
        .map((e) => e.name)
    : [];
  if (others.length > 0) {
    throw new Error(
      `workspace/ contains ${others.join(', ')}; xng apply would remove everything that is not in its yml file. Aborting before touching anything.`,
    );
  }

  const writeYml = (networks: Record<string, unknown>) =>
    writeFile(YML, YAML.stringify({ networks }));
  const apply1 = (v: string) => ({
    [NAME]: {
      type: 'testnet',
      version: v,
      validators: 1,
      domain: values.domain,
    },
  });

  // 1-3: nothing happens without confirmation.
  await writeYml(apply1(version));
  let r = apply(['--dry-run']);
  assert.equal(r.status, 0);
  assert.match(r.out, /^\+ apply1 /m);
  assert.ok(!existsSync(`workspace/${NAME}`), 'dry-run created the network');

  r = apply([], 'ignore');
  assert.notEqual(r.status, 0, 'apply without -y and without a TTY succeeded');
  assert.ok(
    !existsSync(`workspace/${NAME}`),
    'refused apply created the network',
  );

  // 4: create + start --wait.
  assert.equal(apply(['-y', '--timeout', timeout]).status, 0);
  e2e();

  // 5: idempotent.
  r = apply(['--dry-run']);
  assert.match(r.out, /^= apply1 /m);
  r = apply(['-y']);
  assert.equal(r.status, 0);
  assert.match(r.out, /no changes/);

  // 6: version change is a rolling upgrade.
  await writeYml(apply1(upgradeTo));
  r = apply(['--dry-run']);
  assert.match(r.out, /^~ apply1 +upgrade/m);
  assert.equal(apply(['-y', '--timeout', timeout]).status, 0);
  e2e('--expect-version', upgradeTo);

  // 7: a stopped network is started again.
  assert.equal(run('pnpm', ['xng', 'stop', '--name', NAME]).status, 0);
  r = apply(['--dry-run']);
  assert.match(r.out, /^\^ apply1 +start/m);
  assert.equal(apply(['-y', '--timeout', timeout]).status, 0);
  e2e();

  // 8: --network leaves the others alone (apply2 is only ever planned, never created).
  await writeYml({
    ...apply1(upgradeTo),
    apply2: { type: 'standalone', version },
  });
  r = apply(['--dry-run', '--network', NAME]);
  assert.equal(r.status, 0);
  assert.ok(!r.out.includes('apply2'), '--network apply1 still planned apply2');
  r = apply(['-y', '--network', NAME]);
  assert.equal(r.status, 0);
  assert.match(r.out, /no changes/);

  // 9: an empty file removes everything.
  await writeYml({});
  assert.equal(apply(['-y']).status, 0);
  assert.ok(!existsSync(`workspace/${NAME}`), 'network directory still exists');
  const ps = run('docker', ['ps', '-a', '--format', '{{.Names}}']);
  assert.ok(
    !ps.out.split('\n').some((n) => n.startsWith(`${NAME}-`)),
    'apply1 containers still exist',
  );
  console.log('[e2e:apply] all checks passed');
}

main().catch((err) => {
  console.error('[e2e:apply] FAILED');
  console.error(err);
  process.exit(1);
});
