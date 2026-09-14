// Proves a network survives a simulated host reboot: every node must resume
// from its last validated ledger (via --load / -a --load, see compose.ts)
// rather than restart from genesis. The reboot itself is simulated by
// whatever command is passed after `--` (CI uses `sudo systemctl restart
// docker`); this script deliberately does NOT run `xng start` afterwards —
// containers must come back on their own via `restart: unless-stopped`.
// Ledger advance/faucet/peers are covered by the subsequent `pnpm e2e`, not
// here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { containerName, endpoints, nodeName } from '../src/types.ts';
import type { NetworkSpec } from '../src/types.ts';
import { rpc, waitForNetwork } from '../src/wait.ts';

function startedAt(container: string): string {
  const result = spawnSync(
    'docker',
    ['inspect', container, '--format', '{{.State.StartedAt}}'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `docker inspect ${container} failed: ${result.stderr || result.status}`,
    );
  }
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      name: { type: 'string' },
      timeout: { type: 'string', default: '300' },
    },
    allowPositionals: true,
  });
  const name = values.name;
  if (!name) throw new Error('--name is required');
  if (positionals.length === 0) {
    throw new Error('a reboot-simulating command is required after --');
  }
  const timeoutSec = Number(values.timeout);

  const specPath = path.resolve('workspace', name, 'network.json');
  const spec: NetworkSpec = JSON.parse(await readFile(specPath, 'utf8'));
  const ep = endpoints(spec);

  const before = (await rpc(ep.rpc, 'server_info')).info.validated_ledger?.seq;
  assert.equal(
    typeof before,
    'number',
    'no validated_ledger.seq before restart',
  );
  console.log(`[e2e:restart] validated ledger before: seq ${before}`);

  const container = containerName(spec, nodeName(spec, 0));
  const startedBefore = startedAt(container);
  console.log(`[e2e:restart] ${container} StartedAt before: ${startedBefore}`);

  console.log(`[e2e:restart] running: ${positionals.join(' ')}`);
  const result = spawnSync(positionals[0], positionals.slice(1), {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `reboot-simulating command exited with code ${result.status}`,
    );
  }

  await waitForNetwork(spec, timeoutSec * 1000);

  const startedAfter = startedAt(container);
  console.log(`[e2e:restart] ${container} StartedAt after: ${startedAfter}`);
  assert.notEqual(
    startedAfter,
    startedBefore,
    'node container was not restarted by the reboot-simulating command (restart policy not applied?)',
  );

  const after = (await rpc(ep.rpc, 'server_info')).info.validated_ledger?.seq;
  assert.ok(
    typeof after === 'number' && after >= before,
    `validated_ledger.seq went from ${before} to ${after}: network restarted from genesis instead of resuming from its validated ledger`,
  );
  console.log(
    `[e2e:restart] resumed from validated ledger: seq ${before} -> ${after}`,
  );
}

main().catch((err) => {
  console.error('[e2e:restart] FAILED');
  console.error(err);
  process.exit(1);
});
