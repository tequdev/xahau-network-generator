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
const MAX_XRP_AMOUNT = Number(process.env.MAX_XRP_AMOUNT ?? '10000');
if (!Number.isFinite(MAX_XRP_AMOUNT) || MAX_XRP_AMOUNT <= 0) {
  console.error('[faucet] MAX_XRP_AMOUNT must be a positive number');
  process.exit(1);
}
// A flood would otherwise queue requests that each time out after 60 s.
// ponytail: global counter; per-IP limits if abuse ever matters.
const MAX_IN_FLIGHT = 20;
let inFlight = 0;

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

// No constructor parameter properties: node strips types, it doesn't compile them.
class FundError extends Error {
  status: number;
  destination?: string;
  secret?: string;
  constructor(
    status: number,
    message: string,
    destination?: string,
    secret?: string,
  ) {
    super(message);
    this.status = status;
    this.destination = destination;
    this.secret = secret;
  }
}

// Shared by /accounts and /newcreds. `secret` is set only when the wallet was
// generated here. Throws FundError (400 validation, 500 payment).
async function fund(
  dest?: unknown,
  xrpAmount?: unknown,
): Promise<{
  destination: string;
  secret?: string;
  amount: string;
  balance: number;
  hash: string;
  code: string;
}> {
  let generatedSecret: string | undefined;
  let destination: unknown;
  if (dest) {
    destination = dest;
  } else {
    const generated = Wallet.generate();
    destination = generated.classicAddress;
    generatedSecret = generated.seed;
  }
  if (typeof destination !== 'string' || !isValidClassicAddress(destination)) {
    throw new FundError(400, 'invalid destination');
  }
  const to: string = destination;

  const amount = String(xrpAmount ?? DEFAULT_XRP_AMOUNT);
  let drops: string;
  try {
    drops = xahToDrops(amount);
  } catch (err) {
    throw new FundError(400, `invalid xrpAmount: ${(err as Error).message}`);
  }
  if (
    BigInt(drops) <= 0n ||
    BigInt(drops) > BigInt(MAX_XRP_AMOUNT) * 1_000_000n
  ) {
    throw new FundError(400, `xrpAmount must be in (0, ${MAX_XRP_AMOUNT}]`);
  }

  const next = submitQueue.then(async () => {
    const tx = {
      TransactionType: 'Payment' as const,
      Account: wallet.classicAddress,
      Destination: to,
      Amount: drops,
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
    const balance = await client.getXrpBalance(to);
    return { hash: submitResult.result.hash, balance, code: engineResult };
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
  let result: Awaited<typeof next>;
  try {
    result = await guarded;
  } catch (err) {
    // The payment may still complete (timeout, node restart mid-flight), so a
    // generated wallet's secret goes back with the error.
    throw new FundError(500, (err as Error).message, to, generatedSecret);
  }

  console.log(`[faucet] funded ${to} with ${amount} XRP (hash ${result.hash})`);
  return {
    destination: to,
    secret: generatedSecret,
    amount,
    balance: Number(result.balance),
    hash: result.hash,
    code: result.code,
  };
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
  try {
    const r = await fund(body.destination, body.xrpAmount);
    sendJson(res, 200, {
      account: {
        classicAddress: r.destination,
        address: r.destination,
        ...(r.secret ? { secret: r.secret } : {}),
      },
      amount: Number(r.amount),
      balance: r.balance,
      hash: r.hash,
    });
  } catch (err) {
    if (!(err instanceof FundError)) throw err;
    if (err.status === 500) {
      console.error(`[faucet] /accounts error: ${err.message}`);
    }
    sendJson(res, err.status, {
      error: err.message,
      ...(err.secret
        ? {
            account: {
              classicAddress: err.destination,
              address: err.destination,
              secret: err.secret,
            },
          }
        : {}),
    });
  }
}

// Testnet-faucet-compatible (xahau-test.net): parameters in the query string.
async function handleNewcreds(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  req.resume();
  try {
    const r = await fund(url.searchParams.get('account') ?? undefined);
    sendJson(res, 200, {
      address: r.destination,
      ...(r.secret ? { secret: r.secret } : {}),
      xrp: Number(r.amount),
      hash: r.hash,
      code: r.code,
    });
  } catch (err) {
    if (!(err instanceof FundError)) throw err;
    if (err.status === 500) {
      console.error(`[faucet] /newcreds error: ${err.message}`);
    }
    sendJson(res, err.status, {
      error: err.message,
      ...(err.secret ? { address: err.destination, secret: err.secret } : {}),
    });
  }
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

  // URL.parse returns null instead of throwing, so a malformed request
  // target can't take the process down.
  const url = URL.parse(req.url ?? '/', 'http://localhost');
  if (!url) {
    sendJson(res, 400, { error: 'bad url' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
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

  const { pathname } = url;
  if (
    req.method === 'POST' &&
    (pathname === '/accounts' || pathname === '/newcreds')
  ) {
    if (!funded) {
      sendJson(res, 503, { error: 'faucet not ready' });
      return;
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      sendJson(res, 503, { error: 'faucet busy, retry later' });
      return;
    }
    inFlight++;
    (pathname === '/accounts'
      ? handleAccounts(req, res)
      : handleNewcreds(req, res, url)
    )
      .catch((err) => {
        console.error(`[faucet] ${pathname} error: ${(err as Error).message}`);
        sendJson(res, 500, { error: (err as Error).message });
      })
      .finally(() => {
        inFlight--;
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
