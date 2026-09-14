import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
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
import { VL_HOST, allHostPorts, nodeName, ports } from './types.ts';

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
  await assertPortsFree(spec, outDir);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, 'network.json'), JSON.stringify(spec, null, 2));

  // 1. binary
  const { binaryPath, releaseinfo } = await fetchBinary(spec.version);
  await mkdir(join(dir, 'bin'), { recursive: true });
  await copyFile(binaryPath, join(dir, 'bin', 'xahaud'));
  await chmod(join(dir, 'bin', 'xahaud'), 0o755);

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
      const peers: string[] = [];
      for (let j = 1; j <= spec.validators; j++) {
        if (j !== i) peers.push(`${nodeName(spec, j)} ${ports(spec, j).peer}`);
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
        vlUrl: `http://${VL_HOST}/vl.json`,
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

    // Non-validating `node`: users, the faucet and the explorer talk to this
    // one, never to a validator. Same shape as a validator config, but no
    // token and peered to every validator (rather than the other way round).
    const primaryNodeDir = join(dir, 'nodes', nodeName(spec, 0));
    await mkdir(primaryNodeDir, { recursive: true });
    const primaryPeers = Array.from(
      { length: spec.validators },
      (_, idx) => `${nodeName(spec, idx + 1)} ${ports(spec, idx + 1).peer}`,
    );
    const primaryCfgOpts = {
      type: 'testnet',
      networkId: spec.networkId,
      ports: ports(spec, 0),
      peers: primaryPeers,
      vlKeyHex: publisher.master.publicKey,
      vlUrl: `http://${VL_HOST}/vl.json`,
      importVlKeys: spec.importVlKeys,
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

// Host ports of every network under outDir must be disjoint so they can run
// side by side; `--port-offset` is how the caller makes room.
async function assertPortsFree(spec: NetworkSpec, outDir: string) {
  const mine = new Set(allHostPorts(spec));
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
    const clash = allHostPorts(other).filter((p) => mine.has(p));
    if (clash.length > 0) {
      throw new Error(
        `host port(s) ${clash.join(', ')} already used by network "${other.name}"; pick a different --port-offset`,
      );
    }
  }
}
