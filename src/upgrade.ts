import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { buildVersionOf, fetchBinary } from './binary.ts';
import { renderCompose } from './compose.ts';
import { compose, composeOutput, removeContainer } from './docker.ts';
import { writeNodeConfig } from './network.ts';
import { RELAY, containerName, endpoints, nodeName } from './types.ts';
import type { NetworkSpec } from './types.ts';
import { rpc } from './wait.ts';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type ServerInfo = {
  build_version?: string;
  server_state?: string;
  peers?: number;
  validated_ledger?: { seq?: number };
};

// `xahaud --conf xahaud.cfg server_info` (run inside the container; cwd is
// /node, set by compose's working_dir) prints the same
// {"result":{"info":{...}}} envelope as the JSON-RPC admin API.
export function parseServerInfoOutput(stdout: string): ServerInfo {
  let parsed: { result?: { info?: ServerInfo } };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not parse server_info output as JSON: ${stdout}`);
  }
  const info = parsed.result?.info;
  if (!info) throw new Error(`unexpected server_info output: ${stdout}`);
  return info;
}

// `node` (index 0) is reachable from the host via its rpc endpoint;
// validators aren't, so they're queried by running the xahaud client inside
// their own container instead.
async function fetchInfo(
  spec: NetworkSpec,
  service: string,
  isPrimary: boolean,
): Promise<ServerInfo> {
  if (isPrimary) {
    const result = await rpc(endpoints(spec).rpc, 'server_info', {
      api_version: 1,
    });
    return result.info;
  }
  const stdout = composeOutput(spec.name, [
    'exec',
    '-T',
    service,
    'xahaud',
    '--conf',
    'xahaud.cfg',
    'server_info',
  ]);
  return parseServerInfoOutput(stdout);
}

// `node` never proposes/validates, so "healthy" for it means exactly 'full';
// validators are healthy in any of the states consensus normally cycles
// through.
const VALIDATOR_HEALTHY_STATES = new Set(['full', 'proposing', 'validating']);
function isHealthy(isPrimary: boolean, info: ServerInfo): boolean {
  if (isPrimary) return info.server_state === 'full';
  return !!info.server_state && VALIDATOR_HEALTHY_STATES.has(info.server_state);
}

async function currentSeq(
  spec: NetworkSpec,
  service: string,
  isPrimary: boolean,
): Promise<number> {
  try {
    const info = await fetchInfo(spec, service, isPrimary);
    return info.validated_ledger?.seq ?? 0;
  } catch (err) {
    // A broken binary from a previous upgrade must not block upgrading back.
    // A node started with --load reports its old validated seq at once, so a
    // silent validator must advance past `node`'s current ledger instead.
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `[${spec.name}] ${service}: not answering (${message}); upgrading anyway`,
    );
    return isPrimary ? 0 : currentSeq(spec, nodeName(spec, 0), true);
  }
}

// Polls `service` every 2s until it reports the new version, a healthy
// state, and a validated ledger seq past `seqBefore` — proof it actually
// rejoined consensus after the restart, not just booted on stale data.
async function waitForNode(
  spec: NetworkSpec,
  service: string,
  isPrimary: boolean,
  version: string,
  seqBefore: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for "${service}" to rejoin on ${version}`,
      );
    }
    try {
      const info = await fetchInfo(spec, service, isPrimary);
      const seq = info.validated_ledger?.seq;
      console.log(
        `[${spec.name}] ${service}: build_version=${info.build_version ?? '-'} server_state=${info.server_state ?? '-'} seq=${seq ?? '-'}`,
      );
      if (
        info.build_version === buildVersionOf(version) &&
        isHealthy(isPrimary, info) &&
        typeof seq === 'number' &&
        seq > seqBefore
      ) {
        return;
      }
    } catch (err) {
      console.log(
        `[${spec.name}] ${service}: waiting... (${(err as Error).message})`,
      );
    }
    await sleep(2000);
  }
}

// Rolling, zero-downtime restart of a running testnet that swaps the xahaud
// binary AND rewrites each node's xahaud.cfg from `spec` (nodeConfig /
// validatorConfig / relayConfig); with the current version it only re-applies
// the config. The caller picks the `services` to roll, in order: `node` first
// (a canary — if the new binary can't even start/sync, nothing else is
// touched), then `relay`, then v1..vN, one at a time. Each node's binary lives at
// its own workspace/<name>/bin/<service>/xahaud (see src/network.ts), so
// swapping one node's file and recreating just that container never affects
// the others; already-upgraded nodes are left running the new binary if a
// later node times out.
export async function upgradeNetwork(
  spec: NetworkSpec,
  version: string,
  timeoutMs: number,
  { services }: { services: string[] },
): Promise<void> {
  spec.version = version;
  const wsDir = join('workspace', spec.name);
  // Fails fast if the version doesn't exist, before anything is touched.
  const { binaryPath } = await fetchBinary(version);
  // relayConfig removed: the relayer goes away, by container name so that a
  // compose.yml already without it (a failed earlier run) cannot break this.
  // Its db is discarded; adding it back later syncs from genesis again.
  if (!spec.relayConfig && existsSync(join(wsDir, 'nodes', RELAY))) {
    removeContainer(containerName(spec, RELAY));
    await rm(join(wsDir, 'bin', RELAY), { recursive: true, force: true });
    await rm(join(wsDir, 'nodes', RELAY), { recursive: true, force: true });
  }
  // `node`'s pwa Traefik labels live in compose.yml, and the `compose up
  // --force-recreate` below applies them; `xng start`/`reset` re-render it
  // the same way.
  await writeFile(
    join('workspace', spec.name, 'compose.yml'),
    renderCompose(spec),
  );

  const upgraded: string[] = [];
  for (const service of services) {
    const isPrimary = service === nodeName(spec, 0);
    const seqBefore = await currentSeq(spec, service, isPrimary);

    const binDir = join(wsDir, 'bin', service);
    const finalPath = join(binDir, 'xahaud');
    const tmpPath = join(binDir, 'xahaud.tmp');
    // Never overwrite the mounted file in place (ETXTBSY / crash risk while
    // the old process still has it open); write alongside and atomically
    // rename over it. The running container keeps its old inode open until
    // it's recreated below.
    // A relayer added to a running network has no directories yet; it starts
    // from the same genesis.json as `node` and syncs to the current ledger.
    const nodeDir = join(wsDir, 'nodes', service);
    if (service === RELAY && !existsSync(nodeDir)) {
      await mkdir(binDir, { recursive: true });
      await mkdir(nodeDir, { recursive: true });
      await copyFile(
        join(wsDir, 'nodes', nodeName(spec, 0), 'genesis.json'),
        join(nodeDir, 'genesis.json'),
      );
    }
    await copyFile(binaryPath, tmpPath);
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, finalPath);

    // The cfg is a bind mount, so rewriting it on the host is enough.
    await writeNodeConfig(
      spec,
      wsDir,
      service === RELAY
        ? RELAY
        : service === 'node'
          ? 0
          : Number(service.slice(1)),
    );

    // --no-deps so `vl` (and any other dependency) is left alone.
    compose(spec.name, ['up', '-d', '--no-deps', '--force-recreate', service]);

    try {
      await waitForNode(
        spec,
        service,
        isPrimary,
        version,
        seqBefore,
        timeoutMs,
      );
    } catch (err) {
      const done =
        upgraded.length > 0
          ? `already upgraded: ${upgraded.join(', ')}`
          : 'no nodes upgraded yet';
      throw new Error(`[${spec.name}] ${(err as Error).message} (${done})`);
    }
    upgraded.push(service);
    console.log(`[${spec.name}] ${service} is healthy on ${version}`);

    // The faucet holds a long-lived WS connection to `node` only (never to
    // a validator); force-recreating `node` above drops that connection,
    // and the faucet's client does not reliably reconnect on its own. A
    // plain restart (not --force-recreate) is enough to make it dial in
    // again, since the faucet's own container/binary aren't changing.
    if (isPrimary) {
      compose(spec.name, ['restart', 'faucet']);
      console.log(`[${spec.name}] restarted faucet to reconnect to ${service}`);
    }
  }

  // Post-condition: `node` is peered to every validator again (validators
  // dial `node` on restart, so this is normally immediate; see network.ts).
  const peersDeadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await fetchInfo(spec, nodeName(spec, 0), true);
    if ((info.peers ?? 0) >= spec.validators) break;
    if (Date.now() > peersDeadline) {
      throw new Error(
        `[${spec.name}] timed out waiting for node to re-peer with all ${spec.validators} validators (peers=${info.peers ?? 0})`,
      );
    }
    console.log(
      `[${spec.name}] node: peers=${info.peers ?? 0}/${spec.validators}, waiting...`,
    );
    await sleep(2000);
  }

  await writeFile(
    join('workspace', spec.name, 'network.json'),
    JSON.stringify(spec, null, 2),
  );
}
