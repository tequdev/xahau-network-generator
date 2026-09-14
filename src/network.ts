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
  RESERVED_NAMES,
  VL_HOST,
  containerName,
  explorerHostPort,
  hostPorts,
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
  // Testnet publishes nothing (routed through Traefik instead), so only
  // standalone networks can collide on host ports.
  if (spec.type === 'standalone') await assertPortsFree(spec, outDir);
  if (spec.type === 'testnet' && RESERVED_NAMES.has(spec.name)) {
    throw new Error(
      `"${spec.name}" is reserved (it is a service subdomain of a root network); pick another name`,
    );
  }
  if (spec.root) await assertRootFree(spec, outDir);
  await mkdir(dir, { recursive: true });

  // Anything failing past this point (binary 404, amendment source fetch,
  // ...) would otherwise leave a directory with only network.json in it,
  // which every later command then mistakes for an existing network.
  try {
    await populateNetwork(spec, dir);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

async function populateNetwork(spec: NetworkSpec, dir: string): Promise<void> {
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

async function otherSpecs(outDir: string): Promise<NetworkSpec[]> {
  let names: string[] = [];
  try {
    names = await readdir(outDir);
  } catch {
    return [];
  }
  const specs: NetworkSpec[] = [];
  for (const name of names) {
    try {
      specs.push(
        JSON.parse(await readFile(join(outDir, name, 'network.json'), 'utf8')),
      );
    } catch {}
  }
  return specs;
}

// A root network owns `<sub>.<domain>` outright, so two of them on one
// domain would register identical Traefik Host() rules.
async function assertRootFree(spec: NetworkSpec, outDir: string) {
  for (const other of await otherSpecs(outDir)) {
    if (other.root && other.domain === spec.domain) {
      throw new Error(
        `network "${other.name}" already serves the bare domain ${spec.domain}; remove it or drop --root`,
      );
    }
  }
}

// Host ports of every standalone network under outDir must be disjoint so
// they can run side by side; `--port-offset` is how the caller makes room.
// Testnet networks publish nothing (routed through Traefik) and are skipped.
async function assertPortsFree(spec: NetworkSpec, outDir: string) {
  const mine = new Set([
    ...Object.values(hostPorts(spec)),
    explorerHostPort(spec),
  ]);
  for (const other of await otherSpecs(outDir)) {
    if (other.type !== 'standalone') continue;
    const otherPorts = [
      ...Object.values(hostPorts(other)),
      explorerHostPort(other),
    ];
    const clash = otherPorts.filter((p) => mine.has(p));
    if (clash.length > 0) {
      throw new Error(
        `host port(s) ${clash.join(', ')} already used by network "${other.name}"; pick a different --port-offset`,
      );
    }
  }
}
