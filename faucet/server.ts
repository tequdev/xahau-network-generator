import { readFileSync } from 'node:fs';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import xahau from 'xahau';

const { Client, ECDSA, Wallet, isValidClassicAddress, xahToDrops } = xahau;

const WS_URL = process.env.XAHAU_WS_URL ?? 'ws://localhost:6006';
const PORT = Number(process.env.PORT ?? 8080);
const DEFAULT_XRP_AMOUNT = process.env.DEFAULT_XRP_AMOUNT ?? '1000';

const FAUCET_KEY_FILE = process.env.FAUCET_KEY_FILE;
if (!FAUCET_KEY_FILE) {
  console.error('[faucet] FAUCET_KEY_FILE env var is required');
  process.exit(1);
}

let faucetSeed: string;
try {
  const raw = readFileSync(FAUCET_KEY_FILE, 'utf8');
  const parsed = JSON.parse(raw) as { seed?: string };
  if (!parsed.seed) throw new Error('key file has no "seed" field');
  faucetSeed = parsed.seed;
} catch (err) {
  console.error(
    `[faucet] failed to read FAUCET_KEY_FILE ${FAUCET_KEY_FILE}: ${(err as Error).message}`,
  );
  process.exit(1);
}

// An `sEd...` seed auto-selects ed25519; no algorithm option needed.
const wallet = Wallet.fromSeed(faucetSeed);

// Used only to sweep the network's funds out of the well-known genesis
// account into the faucet wallet on startup; never used to fund users.
const GENESIS_SEED = 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb';
const genesisWallet = Wallet.fromSeed(GENESIS_SEED, {
  algorithm: ECDSA.secp256k1,
});

const client = new Client(WS_URL);
client.apiVersion = 1;

// Set once the startup sweep has run (or been skipped); gates /accounts and
// /health so users can't be funded from a not-yet-swept faucet wallet.
let funded = false;
// The most recent sweep failure, if any, surfaced on /health so a stuck
// sweep (e.g. the node still starting) is diagnosable from the outside.
let lastSweepError: string | null = null;

const SWEEP_THRESHOLD_DROPS = 1_000_000_000n; // 1,000 XAH
const SWEEP_RESERVE_DROPS = 100_000_000n; // 100 XAH left behind for reserve/fees

async function sweepGenesis(): Promise<void> {
  try {
    const info = await client.request({
      command: 'account_info',
      account: genesisWallet.classicAddress,
      ledger_index: 'validated',
    });
    const balance = BigInt(info.result.account_data.Balance);
    if (balance > SWEEP_THRESHOLD_DROPS) {
      const amount = balance - SWEEP_RESERVE_DROPS;
      const tx = {
        TransactionType: 'Payment' as const,
        Account: genesisWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: amount.toString(),
      };
      const result = await client.submitAndWait(tx, {
        wallet: genesisWallet,
        autofill: true,
      });
      const engineResult =
        result.result.meta && typeof result.result.meta === 'object'
          ? (result.result.meta as { TransactionResult?: string })
              .TransactionResult
          : undefined;
      if (engineResult !== 'tesSUCCESS') {
        throw new Error(`sweep payment failed: ${engineResult ?? 'unknown'}`);
      }
      console.log(
        `[faucet] swept ${Number(amount) / 1_000_000} XAH from genesis to ${wallet.classicAddress}`,
      );
    } else {
      console.log(
        `[faucet] genesis balance (${balance} drops) already below sweep threshold, skipping`,
      );
    }
    funded = true;
    lastSweepError = null;
  } catch (err) {
    lastSweepError = (err as Error).message;
    console.error(`[faucet] sweep failed: ${lastSweepError}, retrying in 5s`);
    setTimeout(sweepGenesis, 5000);
  }
}

function connectWithRetry(): void {
  client
    .connect()
    .then(() => {
      sweepGenesis();
    })
    .catch((err) => {
      console.error(
        `[faucet] connect failed: ${(err as Error).message}, retrying in 3s`,
      );
      setTimeout(connectWithRetry, 3000);
    });
}
// xrpl.js reconnects on its own after an unexpected close; a second
// reconnect loop here would race it.
connectWithRetry();

// ponytail: single promise chain serializes submissions to avoid Sequence
// clashes; upgrade to per-account queues if concurrent throughput matters.
let submitQueue: Promise<unknown> = Promise.resolve();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function handleAccounts(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let body: { destination?: string; xrpAmount?: string | number } = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
  }

  let generatedSecret: string | undefined;
  let destination: string;
  if (body.destination) {
    destination = body.destination;
  } else {
    const generated = Wallet.generate();
    destination = generated.classicAddress;
    generatedSecret = generated.seed;
  }
  if (typeof destination !== 'string' || !isValidClassicAddress(destination)) {
    sendJson(res, 400, { error: 'invalid destination' });
    return;
  }

  const amount = String(body.xrpAmount ?? DEFAULT_XRP_AMOUNT);

  const next = submitQueue.then(async () => {
    const tx = {
      TransactionType: 'Payment' as const,
      Account: wallet.classicAddress,
      Destination: destination,
      Amount: xahToDrops(amount),
    };
    const submitResult = await client.submitAndWait(tx, {
      wallet,
      autofill: true,
    });
    const engineResult =
      submitResult.result.meta && typeof submitResult.result.meta === 'object'
        ? (submitResult.result.meta as { TransactionResult?: string })
            .TransactionResult
        : undefined;
    if (engineResult !== 'tesSUCCESS') {
      throw new Error(`payment failed: ${engineResult ?? 'unknown'}`);
    }
    const balance = await client.getXrpBalance(destination);
    return { hash: submitResult.result.hash, balance };
  });
  // The 60s race is only to bound the HTTP response; the queue itself
  // always chains off `next` (not the raced `guarded`) so a payment that
  // times out here can still finish in the background before the next
  // queued payment submits — otherwise both could share a Sequence.
  submitQueue = next.catch(() => undefined);
  const guarded = Promise.race([
    next,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('payment timed out')), 60_000).unref(),
    ),
  ]);
  const result = await guarded;

  console.log(
    `[faucet] funded ${destination} with ${amount} XRP (hash ${result.hash})`,
  );

  sendJson(res, 200, {
    account: {
      classicAddress: destination,
      address: destination,
      ...(generatedSecret ? { secret: generatedSecret } : {}),
    },
    amount: Number(amount),
    balance: Number(result.balance),
    hash: result.hash,
  });
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    const connected = client.isConnected();
    const ready = funded && connected;
    sendJson(res, ready ? 200 : 503, {
      ok: ready,
      connected,
      funded,
      address: wallet.classicAddress,
      lastError: lastSweepError,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/accounts') {
    if (!funded) {
      sendJson(res, 503, { error: 'faucet not ready' });
      return;
    }
    handleAccounts(req, res).catch((err) => {
      console.error(`[faucet] /accounts error: ${(err as Error).message}`);
      sendJson(res, 500, { error: (err as Error).message });
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(
    `[faucet] listening on :${PORT}, wallet ${wallet.classicAddress}`,
  );
});

// node runs as PID 1 in the container, and PID 1 ignores signals it has no
// handler for; without this `docker stop` waits out its 10s grace period and
// SIGKILLs.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => process.exit(0));
}
