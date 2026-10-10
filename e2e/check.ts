import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deriveAddress, deriveKeypair, generateSeed } from 'xahau-keypairs';
import { composeOutput } from '../src/docker.ts';
import { endpoints, nodeName } from '../src/types.ts';
import type { NetworkSpec } from '../src/types.ts';
import { parseServerInfoOutput } from '../src/upgrade.ts';
import { rpc } from '../src/wait.ts';
import {
  TRACE_HOOK_MESSAGE,
  TRACE_HOOK_ON,
  TRACE_HOOK_WASM_HEX,
  signTx,
} from './trace-hook.ts';

const GENESIS_SECRET = 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb';
const GENESIS_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `node` is the only node routed through Traefik (for both network types)
// and the only one users/faucet/explorer ever talk to.
// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC result shape varies by method
async function checkCommon(spec: NetworkSpec): Promise<any> {
  const ep = endpoints(spec);
  const info = await rpc(ep.rpc, 'server_info');
  assert.equal(info.info.network_id, spec.networkId, 'network_id mismatch');
  console.log(
    `[e2e] server_info: build_version=${info.info.build_version} server_state=${info.info.server_state} validated_ledger.seq=${info.info.validated_ledger?.seq}`,
  );

  const explorerRes = await fetch(`${ep.explorer}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(explorerRes.status, 200, 'explorer did not return 200');

  return info;
}

// After an `xng upgrade`, checks that every node (node + all validators) is
// running the new binary and that the ledger kept advancing rather than
// being reset (i.e. the upgrade didn't wipe node data).
function checkVersion(
  spec: NetworkSpec,
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC result shape varies by method
  nodeInfo: any,
  expectVersion: string,
): void {
  assert.equal(
    nodeInfo.build_version,
    expectVersion,
    `node build_version ${nodeInfo.build_version} !== ${expectVersion}`,
  );
  const seq = nodeInfo.validated_ledger?.seq;
  assert.ok(
    typeof seq === 'number' && seq >= 10,
    `node validated_ledger.seq ${seq} not >= 10 (ledger may have been reset by the upgrade)`,
  );

  for (let i = 1; i <= spec.validators; i++) {
    const service = nodeName(spec, i);
    const stdout = composeOutput(spec.name, [
      'exec',
      '-T',
      service,
      'xahaud',
      '--conf',
      'xahaud.cfg',
      'server_info',
    ]);
    const info = parseServerInfoOutput(stdout);
    assert.equal(
      info.build_version,
      expectVersion,
      `${service} build_version ${info.build_version} !== ${expectVersion}`,
    );
    console.log(
      `[e2e] ${service}: build_version=${info.build_version} server_state=${info.server_state}`,
    );
  }
  console.log(
    `[e2e] version check passed: all nodes on ${expectVersion}, node seq=${seq}`,
  );
}

// A root network serves the landing page on the bare domain, next to its
// wss endpoint (Traefik splits them by the Upgrade header).
async function checkLanding(spec: NetworkSpec): Promise<void> {
  const http = spec.tls ? 'https' : 'http';
  const page = await fetch(`${http}://${spec.domain}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(page.status, 200, 'landing page did not return 200');
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const index = await fetch(`${http}://${spec.domain}/networks.json`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(index.status, 200, 'networks.json did not return 200');
  const names = (
    (await index.json()) as { networks: { name: string }[] }
  ).networks.map((n) => n.name);
  assert.ok(names.includes(spec.name), `networks.json lacks ${spec.name}`);

  const ws = new WebSocket(endpoints(spec).ws);
  const result = await new Promise<{ info?: unknown }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ws server_info timed out after 15s')),
      15_000,
    );
    ws.onopen = () => ws.send(JSON.stringify({ command: 'server_info' }));
    ws.onerror = () => reject(new Error('ws connection failed'));
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(e.data)).result);
    };
  }).finally(() => ws.close());
  assert.ok(result?.info, 'ws server_info returned no result.info');
  console.log('[e2e] landing page, networks.json and ws upgrade ok');
}

// Signs `tx` with `seed` (adds Sequence, NetworkID, LastLedgerSequence), submits it
// to the public RPC and waits until it is validated.
async function submitAndValidate(
  spec: NetworkSpec,
  rpcUrl: string,
  seed: string,
  tx: Record<string, unknown>,
): Promise<void> {
  const acct = await rpc(rpcUrl, 'account_info', {
    account: tx.Account,
    ledger_index: 'current',
  });
  const { tx_blob } = signTx(
    {
      ...tx,
      NetworkID: spec.networkId,
      Sequence: acct.account_data.Sequence,
      LastLedgerSequence: acct.ledger_current_index + 20,
    },
    seed,
  );
  const submitted = await rpc(rpcUrl, 'submit', { tx_blob });
  assert.equal(
    submitted.engine_result,
    'tesSUCCESS',
    `${tx.TransactionType} submit failed: ${submitted.engine_result} ${submitted.engine_result_message}`,
  );
  const hash = submitted.tx_json.hash;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await rpc(rpcUrl, 'tx', { transaction: hash }).catch(
      () => undefined,
    );
    if (res?.validated) {
      assert.equal(
        res.meta.TransactionResult,
        'tesSUCCESS',
        `${tx.TransactionType} ${hash} validated as ${res.meta.TransactionResult}`,
      );
      return;
    }
    assert.ok(
      Date.now() < deadline,
      `${tx.TransactionType} ${hash} not validated within 60s`,
    );
    await sleep(2000);
  }
}

// Installs a hook that calls trace() on `address`, triggers it with a Payment,
// and expects the trace line to arrive on the network's debug stream WebSocket.
async function checkDebugStream(
  spec: NetworkSpec,
  address: string,
  seed: string,
): Promise<void> {
  const ep = endpoints(spec);
  assert.ok(ep.debugstream, 'testnet spec missing debugstream endpoint');

  await submitAndValidate(spec, ep.rpc, seed, {
    TransactionType: 'SetHook',
    Account: address,
    Fee: '10000000',
    Hooks: [
      {
        Hook: {
          CreateCode: TRACE_HOOK_WASM_HEX,
          HookOn: TRACE_HOOK_ON,
          HookNamespace: '0'.repeat(64),
          HookApiVersion: 0,
          Flags: 1,
        },
      },
    ],
  });
  console.log(`[e2e] trace hook installed on ${address}`);

  const lines: string[] = [];
  const ws = new WebSocket(`${ep.debugstream}${address}`);
  ws.addEventListener('message', (e) => lines.push(String(e.data)));
  try {
    // A failed connect surfaces as the 15s timeout (EventTarget `once` has no
    // special 'error' handling), which is good enough for an e2e.
    await once(ws, 'open', { signal: AbortSignal.timeout(15_000) });

    await submitAndValidate(spec, ep.rpc, seed, {
      TransactionType: 'Payment',
      Account: address,
      Destination: GENESIS_ADDRESS,
      Amount: '1000000',
      Fee: '1000000',
    });

    const deadline = Date.now() + 60_000;
    const match = () =>
      lines.find(
        (l) =>
          l.includes(`HookTrace[${address}`) && l.includes(TRACE_HOOK_MESSAGE),
      );
    while (!match() && Date.now() < deadline) await sleep(500);
    const line = match();
    assert.ok(
      line,
      `no HookTrace line on debugstream within 60s; last lines: ${JSON.stringify(lines.slice(-5))}`,
    );
    console.log(`[e2e] debugstream delivered: ${line.trim()}`);
  } finally {
    ws.close();
  }
}

async function checkTestnet(
  spec: NetworkSpec,
  expectVersion?: string,
): Promise<void> {
  await checkCommon(spec);

  if (spec.root) await checkLanding(spec);

  const ep = endpoints(spec);
  assert.ok(ep.faucet, 'testnet spec missing faucet endpoint');
  const faucetBase = ep.faucet;

  const first = await fetch(`${faucetBase}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(
    first.status,
    200,
    `faucet /accounts (generated) did not return 200: ${await first.clone().text()}`,
  );
  const firstBody = await first.json();
  assert.ok(
    Number(firstBody.balance) >= Number(firstBody.amount),
    `faucet balance ${firstBody.balance} < amount ${firstBody.amount}`,
  );
  assert.ok(
    typeof firstBody.account.secret === 'string',
    'faucet did not return a secret for generated account',
  );
  console.log(
    `[e2e] faucet funded new account ${firstBody.account.classicAddress} balance=${firstBody.balance}`,
  );

  const second = await fetch(`${faucetBase}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      destination: firstBody.account.classicAddress,
      xrpAmount: 50,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(
    second.status,
    200,
    `faucet /accounts (top-up) did not return 200: ${await second.clone().text()}`,
  );
  const secondBody = await second.json();
  assert.ok(
    Number(secondBody.balance) > Number(firstBody.balance),
    `top-up balance ${secondBody.balance} did not grow from ${firstBody.balance}`,
  );
  console.log(
    `[e2e] faucet topped up ${firstBody.account.classicAddress} balance=${secondBody.balance}`,
  );

  const nc1 = await fetch(`${faucetBase}/newcreds`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(
    nc1.status,
    200,
    `faucet /newcreds (generated) did not return 200: ${await nc1.clone().text()}`,
  );
  const nc1Body = await nc1.json();
  assert.ok(typeof nc1Body.address === 'string', 'newcreds: no address');
  assert.ok(typeof nc1Body.secret === 'string', 'newcreds: no secret');
  assert.ok(typeof nc1Body.hash === 'string', 'newcreds: no hash');
  assert.equal(nc1Body.code, 'tesSUCCESS');
  assert.ok(Number(nc1Body.xrp) > 0, `newcreds: bad xrp ${nc1Body.xrp}`);
  console.log(
    `[e2e] faucet /newcreds created ${nc1Body.address} xrp=${nc1Body.xrp}`,
  );

  const nc2 = await fetch(`${faucetBase}/newcreds?account=${nc1Body.address}`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(
    nc2.status,
    200,
    `faucet /newcreds (account) did not return 200: ${await nc2.clone().text()}`,
  );
  const nc2Body = await nc2.json();
  assert.equal(nc2Body.address, nc1Body.address);
  assert.ok(
    !('secret' in nc2Body),
    'newcreds: secret returned for given account',
  );
  console.log(`[e2e] faucet /newcreds topped up ${nc2Body.address}`);

  const nc3 = await fetch(`${faucetBase}/newcreds?account=notanaddress`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(nc3.status, 400, 'newcreds: invalid account must be 400');
  assert.ok('error' in (await nc3.json()), 'newcreds: 400 body has no error');
  console.log('[e2e] faucet /newcreds rejected an invalid account');

  // Validators aren't routed through Traefik, so they can only be checked
  // indirectly via `node`: it must be peered to every validator, and the
  // ledger must keep advancing (i.e. consensus is actually running among
  // them).
  const nodeUrl = ep.rpc;
  const info1 = await rpc(nodeUrl, 'server_info');
  assert.ok(
    info1.info.peers >= spec.validators,
    `node has ${info1.info.peers} peers, expected >= ${spec.validators}`,
  );

  // With a single validator there are no other proposers, so an idle ledger
  // only closes on xahaud's idle interval (~15s); poll well past that rather
  // than sleeping a fixed few seconds.
  const advanceDeadline = Date.now() + 30_000;
  let info2 = info1;
  while (info2.info.validated_ledger.seq <= info1.info.validated_ledger.seq) {
    assert.ok(
      Date.now() < advanceDeadline,
      `node validated_ledger.seq did not advance within 30s: ${info1.info.validated_ledger.seq} -> ${info2.info.validated_ledger.seq}`,
    );
    await sleep(2000);
    info2 = await rpc(nodeUrl, 'server_info');
  }
  console.log(
    `[e2e] node server_info: peers=${info1.info.peers} validated_ledger.seq=${info1.info.validated_ledger.seq}->${info2.info.validated_ledger.seq}`,
  );

  if (expectVersion) checkVersion(spec, info2.info, expectVersion);

  await checkDebugStream(
    spec,
    firstBody.account.classicAddress,
    firstBody.account.secret,
  );

  const faucetKeysPath = path.resolve(
    'workspace',
    spec.name,
    'keys',
    'faucet.json',
  );
  const faucetKeys: { seed: string; address: string } = JSON.parse(
    await readFile(faucetKeysPath, 'utf8'),
  );
  const faucetInfo = await rpc(nodeUrl, 'account_info', {
    account: faucetKeys.address,
    ledger_index: 'validated',
  });
  const genesisInfo = await rpc(nodeUrl, 'account_info', {
    account: GENESIS_ADDRESS,
    ledger_index: 'validated',
  });
  const faucetBalance = BigInt(faucetInfo.account_data.Balance);
  const genesisBalance = BigInt(genesisInfo.account_data.Balance);
  assert.ok(
    genesisBalance <= 1_000_000_000n,
    `genesis balance ${genesisBalance} was not swept below 1,000 XAH`,
  );
  assert.ok(
    faucetBalance >= 1_000_000_000_000n,
    `faucet balance ${faucetBalance} below expected swept amount (1M XAH)`,
  );
  console.log(
    `[e2e] sweep: genesis balance=${genesisBalance} drops, faucet balance=${faucetBalance} drops`,
  );
}

async function checkStandalone(spec: NetworkSpec): Promise<void> {
  await checkCommon(spec);

  const ep = endpoints(spec);
  assert.ok(ep.rpcAdmin, 'standalone spec missing rpcAdmin endpoint');
  const adminUrl = ep.rpcAdmin;

  const accept1 = await rpc(adminUrl, 'ledger_accept');
  const accept2 = await rpc(adminUrl, 'ledger_accept');
  assert.ok(
    accept2.ledger_current_index > accept1.ledger_current_index,
    `ledger_current_index did not increment: ${accept1.ledger_current_index} -> ${accept2.ledger_current_index}`,
  );
  console.log(
    `[e2e] ledger_accept: ${accept1.ledger_current_index} -> ${accept2.ledger_current_index}`,
  );

  const genesisKeypair = deriveKeypair(GENESIS_SECRET);
  const genesisAddress = deriveAddress(genesisKeypair.publicKey);
  const destination = deriveAddress(deriveKeypair(generateSeed()).publicKey);
  const amountDrops = '10000000';

  const signed = await rpc(adminUrl, 'sign', {
    secret: GENESIS_SECRET,
    tx_json: {
      TransactionType: 'Payment',
      Account: genesisAddress,
      Destination: destination,
      Amount: amountDrops,
      NetworkID: spec.networkId,
    },
  });
  const submitted = await rpc(adminUrl, 'submit', { tx_blob: signed.tx_blob });
  assert.equal(
    submitted.engine_result,
    'tesSUCCESS',
    `submit failed: ${submitted.engine_result}`,
  );

  await rpc(adminUrl, 'ledger_accept');

  const accountInfo = await rpc(adminUrl, 'account_info', {
    account: destination,
  });
  assert.equal(
    accountInfo.account_data.Balance,
    amountDrops,
    `destination balance ${accountInfo.account_data.Balance} !== ${amountDrops}`,
  );
  console.log(
    `[e2e] standalone payment: ${destination} balance=${accountInfo.account_data.Balance}`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      'expect-version': { type: 'string' },
    },
  });
  const name = values.name;
  if (!name) {
    throw new Error('--name is required');
  }

  const specPath = path.resolve('workspace', name, 'network.json');
  const spec: NetworkSpec = JSON.parse(await readFile(specPath, 'utf8'));

  if (spec.type === 'testnet') {
    await checkTestnet(spec, values['expect-version']);
  } else {
    await checkStandalone(spec);
  }

  console.log(`[e2e] all checks passed for ${name}`);
}

main().catch((err) => {
  console.error('[e2e] FAILED');
  console.error(err);
  process.exit(1);
});
