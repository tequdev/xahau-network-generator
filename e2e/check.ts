import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deriveAddress, deriveKeypair, generateSeed } from 'xahau-keypairs';
import { explorerHostPort, faucetHostPort, hostPorts } from '../src/types.ts';
import type { NetworkSpec } from '../src/types.ts';
import { rpc } from '../src/wait.ts';

const GENESIS_SECRET = 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb';
const GENESIS_ADDRESS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

function rpcUrl(port: number): string {
  return `http://localhost:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `node` is the only node with a published host port (for both network
// types) and the only one users/faucet/explorer ever talk to.
// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC result shape varies by method
async function checkCommon(spec: NetworkSpec): Promise<any> {
  const host = hostPorts(spec);
  const info = await rpc(rpcUrl(host.rpcPublic), 'server_info');
  assert.equal(info.info.network_id, spec.networkId, 'network_id mismatch');
  console.log(
    `[e2e] server_info: build_version=${info.info.build_version} server_state=${info.info.server_state} validated_ledger.seq=${info.info.validated_ledger?.seq}`,
  );

  const explorerRes = await fetch(
    `http://localhost:${explorerHostPort(spec)}/`,
    { signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(explorerRes.status, 200, 'explorer did not return 200');

  return info;
}

async function checkTestnet(spec: NetworkSpec): Promise<void> {
  await checkCommon(spec);

  const faucetBase = `http://localhost:${faucetHostPort(spec)}`;

  const first = await fetch(`${faucetBase}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(
    first.status,
    200,
    'faucet /accounts (generated) did not return 200',
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
    'faucet /accounts (top-up) did not return 200',
  );
  const secondBody = await second.json();
  assert.ok(
    Number(secondBody.balance) > Number(firstBody.balance),
    `top-up balance ${secondBody.balance} did not grow from ${firstBody.balance}`,
  );
  console.log(
    `[e2e] faucet topped up ${firstBody.account.classicAddress} balance=${secondBody.balance}`,
  );

  // Validators publish no host ports, so they can only be checked indirectly
  // via `node`: it must be peered to every validator, and the ledger must
  // keep advancing (i.e. consensus is actually running among them).
  const nodeUrl = rpcUrl(hostPorts(spec).rpcPublic);
  const info1 = await rpc(nodeUrl, 'server_info');
  assert.ok(
    info1.info.peers >= spec.validators,
    `node has ${info1.info.peers} peers, expected >= ${spec.validators}`,
  );

  await sleep(4000);

  const info2 = await rpc(nodeUrl, 'server_info');
  assert.ok(
    info2.info.validated_ledger.seq > info1.info.validated_ledger.seq,
    `node validated_ledger.seq did not advance: ${info1.info.validated_ledger.seq} -> ${info2.info.validated_ledger.seq}`,
  );
  console.log(
    `[e2e] node server_info: peers=${info1.info.peers} validated_ledger.seq=${info1.info.validated_ledger.seq}->${info2.info.validated_ledger.seq}`,
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

  const host = hostPorts(spec);
  const adminUrl = rpcUrl(host.rpcAdmin);

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
  const { values } = parseArgs({ options: { name: { type: 'string' } } });
  const name = values.name;
  if (!name) {
    throw new Error('--name is required');
  }

  const specPath = path.resolve('workspace', name, 'network.json');
  const spec: NetworkSpec = JSON.parse(await readFile(specPath, 'utf8'));

  if (spec.type === 'testnet') {
    await checkTestnet(spec);
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
