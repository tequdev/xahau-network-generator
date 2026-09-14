import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  amendmentHash,
  commitFromReleaseinfo,
  fetchFeatureSource,
  parseAmendments,
} from './amendments.ts';
import { fetchBinary } from './binary.ts';
import { renderCompose } from './compose.ts';
import { renderValidatorsTxt, renderXahaudCfg } from './config.ts';
import type { XahaudCfgOptions } from './config.ts';
import { buildGenesis } from './genesis.ts';
import {
  createFaucetKeys,
  createPublisherKeys,
  createValidatorKeys,
  signVl,
} from './keys.ts';
import type { NetworkSpec } from './types.ts';
import {
  VL_HOST,
  containerName,
  explorerHostPort,
  hostPorts,
  isHosted,
  nodeName,
  ports,
} from './types.ts';

const REPO_FAUCET_DIR = fileURLToPath(new URL('../faucet', import.meta.url));

export async function createNetwork(
  spec: NetworkSpec,
  outDir = 'workspace',
): Promise<string> {
  const dir = join(outDir, spec.name);
  if (existsSync(dir)) {
    throw new Error(
      `network directory "${dir}" already exists; run \`xng remove --name ${spec.name}\` first`,
    );
  }
  // A non-hosted testnet publishes nothing (routed through Traefik
  // instead); standalone publishes its full port set, and a hosted testnet
  // additionally publishes the peer port directly on the docker host (see
  // compose.ts) — both can collide with another network under outDir.
  if (spec.type === 'standalone' || isHosted(spec)) {
    await assertPortsFree(spec, outDir);
  }
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, 'network.json'), JSON.stringify(spec, null, 2));

  // 1. binary
  // Each node gets its own copy of the binary (workspace/<name>/bin/<service>/xahaud)
  // rather than one shared file, so a rolling upgrade (src/upgrade.ts) can
  // replace one node's binary without touching the others. The first copy is
  // written for real; the rest are hard-linked to it (same inode, so no extra
  // disk use) and only diverge later when `xng upgrade` rewrites one of them.
  const { binaryPath, releaseinfo } = await fetchBinary(spec.version);
  const serviceNames =
    spec.type === 'standalone'
      ? [nodeName(spec, 0)]
      : Array.from({ length: spec.validators + 1 }, (_, i) =>
          nodeName(spec, i),
        );
  const [primaryService, ...restServices] = serviceNames;
  if (!primaryService) throw new Error('no services to install a binary for');
  const primaryBinDir = join(dir, 'bin', primaryService);
  await mkdir(primaryBinDir, { recursive: true });
  const primaryBinPath = join(primaryBinDir, 'xahaud');
  await copyFile(binaryPath, primaryBinPath);
  await chmod(primaryBinPath, 0o755);
  for (const service of restServices) {
    const binDir = join(dir, 'bin', service);
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, 'xahaud');
    try {
      await link(primaryBinPath, binPath);
    } catch {
      await copyFile(primaryBinPath, binPath);
      await chmod(binPath, 0o755);
    }
  }

  // 2. amendments
  const commit = commitFromReleaseinfo(releaseinfo);
  const source = await fetchFeatureSource(commit, spec.version);
  const names = parseAmendments(source);
  const amendmentsMap: Record<string, string> = {};
  for (const name of [...names].sort()) {
    amendmentsMap[name] = amendmentHash(name);
  }
  await writeFile(
    join(dir, 'amendments.json'),
    JSON.stringify(amendmentsMap, null, 2),
  );

  // 3. genesis
  const hashes = Object.values(amendmentsMap);
  const genesis = buildGenesis(hashes);

  // 4. keys (testnet only) + config + genesis per node
  await mkdir(join(dir, 'nodes'), { recursive: true });

  if (spec.type === 'testnet') {
    await mkdir(join(dir, 'keys'), { recursive: true });
    await mkdir(join(dir, 'vl'), { recursive: true });

    const validatorKeysList = [];
    for (let i = 1; i <= spec.validators; i++) {
      const v = createValidatorKeys();
      validatorKeysList.push(v);
      await writeFile(
        join(dir, 'keys', `v${i}.json`),
        JSON.stringify(v, null, 2),
      );
    }

    await writeFile(
      join(dir, 'keys', 'faucet.json'),
      JSON.stringify(createFaucetKeys(), null, 2),
    );

    // Hosted mode: http://<name>-vl/vl.json is only reachable on the compose
    // network, so every node (node included) gets a static [validators]
    // list instead.
    const hostedValidatorKeys = isHosted(spec)
      ? validatorKeysList.map((v) => v.nodePublic)
      : undefined;

    const publisher = createPublisherKeys();
    await writeFile(
      join(dir, 'keys', 'vl.json'),
      JSON.stringify(
        {
          master: publisher.master,
          ephemeral: publisher.ephemeral,
          manifest: publisher.manifest,
        },
        null,
        2,
      ),
    );

    const vl = signVl(
      publisher,
      validatorKeysList.map((v) => ({
        publicKeyHex: v.publicKeyHex,
        manifestBase64: v.manifest.base64,
      })),
    );
    await writeFile(join(dir, 'vl', 'vl.json'), JSON.stringify(vl, null, 2));

    for (let i = 1; i <= spec.validators; i++) {
      const nodeDir = join(dir, 'nodes', nodeName(spec, i));
      await mkdir(nodeDir, { recursive: true });
      // Every other node, `node` included: xahaud retries a failed fixed
      // peer with a 1/1/2/3/5... minute backoff, so if only `node` dialled
      // validators, a validator restarted by `xng upgrade` would stay
      // unpeered from `node` for minutes. Having both sides dial each other
      // means whichever side just restarted reconnects immediately.
      const peers: string[] = [];
      for (let j = 0; j <= spec.validators; j++) {
        if (j !== i)
          peers.push(
            `${containerName(spec, nodeName(spec, j))} ${ports(spec, j).peer}`,
          );
      }
      const validatorKeys = validatorKeysList[i - 1];
      if (!validatorKeys) throw new Error(`missing keys for validator ${i}`);
      const cfgOpts = {
        type: 'testnet',
        networkId: spec.networkId,
        ports: ports(spec, i),
        token: validatorKeys.token,
        peers,
        vlKeyHex: publisher.master.publicKey,
        vlUrl: `http://${containerName(spec, VL_HOST)}/vl.json`,
        importVlKeys: spec.importVlKeys,
        validators: hostedValidatorKeys,
      } satisfies XahaudCfgOptions;
      await writeFile(join(nodeDir, 'xahaud.cfg'), renderXahaudCfg(cfgOpts));
      await writeFile(
        join(nodeDir, 'validators.txt'),
        renderValidatorsTxt(cfgOpts),
      );
      await writeFile(
        join(nodeDir, 'genesis.json'),
        JSON.stringify(genesis, null, 2),
      );
    }

    // Non-validating `node`: users, the faucet and the explorer talk to this
    // one, never to a validator. Same shape as a validator config, but no
    // token and peered to every validator (and they to it, see above).
    const primaryNodeDir = join(dir, 'nodes', nodeName(spec, 0));
    await mkdir(primaryNodeDir, { recursive: true });
    const primaryPeers = Array.from(
      { length: spec.validators },
      (_, idx) =>
        `${containerName(spec, nodeName(spec, idx + 1))} ${ports(spec, idx + 1).peer}`,
    );
    const primaryCfgOpts = {
      type: 'testnet',
      networkId: spec.networkId,
      ports: ports(spec, 0),
      peers: primaryPeers,
      vlKeyHex: publisher.master.publicKey,
      vlUrl: `http://${containerName(spec, VL_HOST)}/vl.json`,
      importVlKeys: spec.importVlKeys,
      validators: hostedValidatorKeys,
    } satisfies XahaudCfgOptions;
    await writeFile(
      join(primaryNodeDir, 'xahaud.cfg'),
      renderXahaudCfg(primaryCfgOpts),
    );
    await writeFile(
      join(primaryNodeDir, 'validators.txt'),
      renderValidatorsTxt(primaryCfgOpts),
    );
    await writeFile(
      join(primaryNodeDir, 'genesis.json'),
      JSON.stringify(genesis, null, 2),
    );
  } else {
    const nodeDir = join(dir, 'nodes', nodeName(spec, 0));
    await mkdir(nodeDir, { recursive: true });
    const cfgOpts = {
      type: 'standalone',
      networkId: spec.networkId,
      ports: ports(spec, 0),
      peers: [],
      importVlKeys: spec.importVlKeys,
    } satisfies XahaudCfgOptions;
    await writeFile(join(nodeDir, 'xahaud.cfg'), renderXahaudCfg(cfgOpts));
    await writeFile(
      join(nodeDir, 'validators.txt'),
      renderValidatorsTxt(cfgOpts),
    );
    await writeFile(
      join(nodeDir, 'genesis.json'),
      JSON.stringify(genesis, null, 2),
    );
  }

  // 5. faucet (testnet only)
  if (spec.type === 'testnet') {
    if (existsSync(REPO_FAUCET_DIR)) {
      await cp(REPO_FAUCET_DIR, join(dir, 'faucet'), {
        recursive: true,
        filter: (src) => !src.split('/').includes('node_modules'),
      });
    } else {
      console.warn(
        `warning: repo faucet/ directory not found at ${REPO_FAUCET_DIR}; skipping faucet copy`,
      );
    }
  }

  // 6. compose
  await writeFile(join(dir, 'compose.yml'), renderCompose(spec));

  return dir;
}

// Deletes each node's ledger data (nodedb under nodes/*/db) so the network
// restarts from genesis on next `compose up`, while keeping everything else
// (xahaud.cfg, validators.txt, genesis.json, keys/, vl/, faucet/) in place.
export async function resetNetworkData(dir: string): Promise<void> {
  const nodesDir = join(dir, 'nodes');
  const nodeDirs = await readdir(nodesDir).catch(() => []);
  for (const nodeDir of nodeDirs) {
    await rm(join(nodesDir, nodeDir, 'db'), {
      recursive: true,
      force: true,
    });
  }
}

// Ports a network publishes directly on the docker host: standalone
// publishes its full port set (shifted by --port-offset); a hosted testnet
// additionally publishes just the peer port (see compose.ts), since
// validators dial it directly; a non-hosted testnet publishes nothing
// (routed through Traefik instead).
function publishedHostPorts(spec: NetworkSpec): number[] {
  if (spec.type === 'standalone') {
    return [...Object.values(hostPorts(spec)), explorerHostPort(spec)];
  }
  if (isHosted(spec)) return [ports(spec, 0).peer];
  return [];
}

// A network's published host ports must be disjoint from every other
// network's under outDir so they can run side by side.
async function assertPortsFree(spec: NetworkSpec, outDir: string) {
  const mine = new Set(publishedHostPorts(spec));
  let names: string[] = [];
  try {
    names = await readdir(outDir);
  } catch {
    return;
  }
  for (const name of names) {
    let other: NetworkSpec;
    try {
      other = JSON.parse(
        await readFile(join(outDir, name, 'network.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    const clash = publishedHostPorts(other).filter((p) => mine.has(p));
    if (clash.length > 0) {
      throw new Error(
        `host port(s) ${clash.join(', ')} already used by network "${other.name}"; pick a different --port-offset (standalone) or non-overlapping --hosts (hosted testnet)`,
      );
    }
  }
}
