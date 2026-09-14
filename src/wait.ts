import { endpoints } from './types.ts';
import type { NetworkSpec } from './types.ts';

export async function rpc(
  url: string,
  method: string,
  params?: object,
  timeoutMs = 10_000,
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC result shape varies by method
): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: params ? [params] : undefined }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${method} to ${url} failed: ${res.status}`);
  const json = (await res.json()) as { result: unknown };
  return json.result;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function urlOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Like urlOk, but on a non-ok response returns the body text too, so a
// stuck faucet sweep is diagnosable from the wait loop's own log output.
async function checkUrl(url: string): Promise<{ ok: boolean; body?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return { ok: true };
    return { ok: false, body: await res.text() };
  } catch (err) {
    return { ok: false, body: (err as Error).message };
  }
}

export async function waitForNetwork(
  spec: NetworkSpec,
  timeoutMs: number,
): Promise<void> {
  // `node` (index 0) is the only node routed through Traefik, for both
  // network types.
  const ep = endpoints(spec);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for network "${spec.name}" to become ready (node rpc at ${ep.rpc})`,
      );
    }
    try {
      const result = await rpc(ep.rpc, 'server_info', { api_version: 1 });
      const info = result?.info;
      const seq = info?.validated_ledger?.seq;
      console.log(
        `[${spec.name}] server_state=${info?.server_state ?? 'unknown'} seq=${seq ?? '-'} peers=${info?.peers ?? '-'}`,
      );
      const ready =
        // `full` matters on a restart: with --load a node reports its old
        // validated seq immediately while still `syncing`, and submits made
        // in that window fail.
        // `peers`: when every node starts at once (first boot, reset, host
        // reboot) two nodes dialling each other simultaneously can drop both
        // connections, and xahaud only retries a fixed peer a minute later;
        // `node` can be `full` via the remaining validators long before that.
        spec.type === 'testnet'
          ? info?.server_state === 'full' &&
            typeof seq === 'number' &&
            seq >= 3 &&
            (info?.peers ?? 0) >= spec.validators
          : info?.validated_ledger != null;
      if (ready) break;
    } catch (err) {
      console.log(
        `[${spec.name}] waiting for node rpc... (${(err as Error).message})`,
      );
    }
    await sleep(2000);
  }

  if (spec.type === 'testnet' && ep.faucet) {
    const faucetUrl = `${ep.faucet}/health`;
    for (;;) {
      const check = await checkUrl(faucetUrl);
      if (check.ok) break;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for faucet to become ready (${faucetUrl})`,
        );
      }
      console.log(`[${spec.name}] waiting for faucet... ${check.body ?? ''}`);
      await sleep(2000);
    }
  }

  const explorerUrl = `${ep.explorer}/`;
  while (!(await urlOk(explorerUrl))) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for explorer to become ready (${explorerUrl})`,
      );
    }
    console.log(`[${spec.name}] waiting for explorer...`);
    await sleep(2000);
  }

  console.log(`[${spec.name}] network is ready`);
}
