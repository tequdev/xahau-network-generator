import assert from 'node:assert/strict';
import {
  certHosts,
  cfConfigFromEnv,
  cfRunner,
  ensureCertificate,
  listCertificatePacks,
  removeCertificate,
} from '../src/cloudflare.ts';
import type { CfRunner } from '../src/cloudflare.ts';
import { DEFAULT_IMPORT_VL_KEYS } from '../src/types.ts';
import type { NetworkSpec } from '../src/types.ts';

// Live check of the Cloudflare edge-certificate flow: orders one advanced
// certificate pack for a throwaway network name on XNG_CF_ZONE, waits for it
// to go active, then deletes it. Auth is cf's own (CLOUDFLARE_API_TOKEN or
// `cf auth login`).
const log = (line: string) => console.log(`[e2e:cf] ${line}`);

async function main() {
  const cfg = cfConfigFromEnv();
  if (!cfg) throw new Error('XNG_CF_ZONE is not set');
  const cf = cfRunner();

  const who = (await cf(['auth', 'whoami'])) as { authenticated?: boolean };
  if (who?.authenticated !== true) {
    throw new Error(
      `cf is not authenticated (set CLOUDFLARE_API_TOKEN or run \`cf auth login\`): ${JSON.stringify(who)}`,
    );
  }
  log(
    `quota: ${JSON.stringify(await cf(['ssl', 'certificate-packs', 'quota', 'get', '--zone', cfg.zone]))}`,
  );

  const spec: NetworkSpec = {
    name: `e2e-cf-${Date.now().toString(36)}`,
    type: 'testnet',
    version: 'x',
    validators: 1,
    quorum: 1,
    networkId: 21339,
    domain: cfg.zone,
    tls: true,
    portOffset: 0,
    importVlKeys: DEFAULT_IMPORT_VL_KEYS,
  };
  const hosts = certHosts(spec, cfg.zone);
  assert.ok(hosts);

  const verbs: Record<string, number> = {};
  const run: CfRunner = (args) => {
    verbs[args[2] as string] = (verbs[args[2] as string] ?? 0) + 1;
    return cf(args);
  };
  const opts = { run, log };
  const live = async () =>
    (await listCertificatePacks(run, cfg.zone)).filter((p) =>
      p.hosts?.includes(hosts[1] as string),
    );

  try {
    const t0 = Date.now();
    await ensureCertificate(spec, cfg, opts);
    log(`certificate active after ${Math.round((Date.now() - t0) / 1000)}s`);
    assert.equal(verbs.create, 1, 'expected exactly one create');
    assert.ok(
      (await live()).some(
        (p) =>
          p.type === 'advanced' &&
          p.status === 'active' &&
          JSON.stringify(p.hosts) === JSON.stringify(hosts),
      ),
      `no active advanced pack with hosts ${hosts.join(', ')}`,
    );

    await ensureCertificate(spec, cfg, opts);
    assert.equal(verbs.create, 1, 'second ensureCertificate ordered again');

    await removeCertificate(spec, cfg, opts);
    assert.equal(verbs.delete, 1, 'expected exactly one delete');
    const left = (await live()).filter(
      (p) => p.status !== 'deleted' && p.status !== 'pending_deletion',
    );
    assert.equal(
      left.length,
      0,
      `packs left after remove: ${JSON.stringify(left)}`,
    );
  } finally {
    // No-op after a successful run; cleans up after a failed one.
    await removeCertificate(spec, cfg, opts).catch((err) =>
      log(`cleanup failed, delete the pack for ${hosts[1]} by hand: ${err}`),
    );
  }
  log('ok');
}

main().catch((err) => {
  console.error('[e2e:cf] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
