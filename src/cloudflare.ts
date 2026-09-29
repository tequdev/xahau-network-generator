import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostBase } from './types.ts';
import type { NetworkSpec } from './types.ts';

const execFileAsync = promisify(execFile);

// Serving through Cloudflare (proxied DNS / a Cloudflare Tunnel) instead of
// Traefik's own Let's Encrypt certificates. Cloudflare terminates TLS, and
// its free Universal certificate only covers `<zone>` and `*.<zone>`, so a
// network's nested hostnames (`explorer.<name>.<zone>`) need an Advanced
// Certificate Manager certificate for `*.<name>.<zone>`. No CA issues
// `*.*.<zone>`, and Total TLS skips Cloudflare Tunnel hostnames, so there is
// no way to set this up once for all future networks: xng orders one
// certificate pack per network through Cloudflare's `cf` CLI instead, and
// deletes it again on `xng remove`. Everything else (DNS wildcard, tunnel
// ingress) is one-time setup, see README.
//
// Enabled by XNG_CF_ZONE=<zone name>, e.g. `xahau-dev.net`; `cf` itself
// authenticates via `cf auth login` or CLOUDFLARE_API_TOKEN.

export const CERTIFICATE_AUTHORITIES = [
  'google',
  'lets_encrypt',
  'ssl_com',
] as const;
export type CertificateAuthority = (typeof CERTIFICATE_AUTHORITIES)[number];

export type CfConfig = {
  zone: string;
  ca: CertificateAuthority;
  timeoutMs: number;
};

export function cfConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CfConfig | undefined {
  const zone = env.XNG_CF_ZONE?.trim().toLowerCase();
  if (!zone) return undefined;
  const ca = (env.XNG_CF_CA?.trim() || 'google') as CertificateAuthority;
  if (!CERTIFICATE_AUTHORITIES.includes(ca)) {
    throw new Error(
      `XNG_CF_CA must be one of ${CERTIFICATE_AUTHORITIES.join(', ')}, got "${ca}"`,
    );
  }
  const timeoutSec = Number(env.XNG_CF_CERT_TIMEOUT ?? 900);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1) {
    throw new Error(
      `XNG_CF_CERT_TIMEOUT must be a positive integer (seconds), got "${env.XNG_CF_CERT_TIMEOUT}"`,
    );
  }
  return { zone, ca, timeoutMs: timeoutSec * 1000 };
}

// The hosts of the certificate pack this network needs, or undefined when
// the Universal certificate already covers every hostname it serves (a root
// network on the zone apex, a non-TLS or standalone network). Cloudflare
// requires the zone apex in every advanced pack.
export function certHosts(
  spec: NetworkSpec,
  zone: string,
): string[] | undefined {
  if (spec.type !== 'testnet' || !spec.tls) return undefined;
  const base = hostBase(spec);
  if (base !== zone && !base.endsWith(`.${zone}`)) {
    throw new Error(
      `XNG_CF_ZONE is "${zone}" but network "${spec.name}" is served under "${base}", which is outside that zone`,
    );
  }
  if (base === zone) return undefined;
  const hosts = [zone, `*.${base}`];
  // `<name>.<zone>` itself is covered by the Universal `*.<zone>`; only when
  // --domain is itself a subdomain of the zone is the base nested too.
  const label = base.slice(0, -(zone.length + 1));
  if (label.includes('.')) hosts.push(base);
  return hosts;
}

// Runs `cf <args>` and returns its parsed JSON output (cf prints JSON by
// default). Injected so tests can fake Cloudflare.
export type CfRunner = (args: string[]) => Promise<unknown>;

// The API wraps results as {success, errors, messages, result}; accept both
// that envelope and a bare result so a cf output change doesn't break us.
function unwrap(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    'result' in value &&
    'success' in value
  ) {
    return (value as { result: unknown }).result;
  }
  return value;
}

export function cfRunner(bin = process.env.XNG_CF_BIN || 'cf'): CfRunner {
  return async (args) => {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(bin, args, {
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      const e = err as { code?: unknown; stderr?: string; message: string };
      if (e.code === 'ENOENT') {
        throw new Error(
          `\`${bin}\` not found: install Cloudflare's CLI (npm i -g cf) or unset XNG_CF_ZONE`,
        );
      }
      throw new Error(
        `${bin} ${args.join(' ')} failed: ${e.stderr?.trim() || e.message}`,
      );
    }
    const text = stdout.trim();
    if (!text) return undefined;
    try {
      return unwrap(JSON.parse(text));
    } catch {
      throw new Error(
        `${bin} ${args.join(' ')} printed non-JSON output: ${text.slice(0, 500)}`,
      );
    }
  };
}

export type CertificatePack = {
  id: string;
  type?: string;
  status?: string;
  hosts?: string[];
};

// Terminal states: a pack in one of these will never become active (or no
// longer serves), so it doesn't count as covering the network.
const DEAD_STATUSES = new Set([
  'deleted',
  'pending_deletion',
  'deactivating',
  'inactive',
  'expired',
  'pending_expiration',
]);
function isDead(status: string | undefined): boolean {
  return (
    status !== undefined &&
    (DEAD_STATUSES.has(status) || status.endsWith('_timed_out'))
  );
}

function asPacks(value: unknown): CertificatePack[] {
  return Array.isArray(value)
    ? value.filter(
        (p): p is CertificatePack =>
          p !== null && typeof p === 'object' && typeof p.id === 'string',
      )
    : [];
}

const PER_PAGE = 50;

export async function listCertificatePacks(
  run: CfRunner,
  zone: string,
): Promise<CertificatePack[]> {
  const byId = new Map<string, CertificatePack>();
  for (let page = 1; page <= 20; page++) {
    const packs = asPacks(
      await run([
        'ssl',
        'certificate-packs',
        'list',
        '--zone',
        zone,
        '--status',
        'all',
        '--per-page',
        String(PER_PAGE),
        '--page',
        String(page),
      ]),
    );
    const before = byId.size;
    for (const p of packs) byId.set(p.id, p);
    // A short page is the last one; no new ids means cf already returned
    // every page itself (auto-pagination) and --page is being ignored.
    if (packs.length < PER_PAGE || byId.size === before) break;
  }
  return [...byId.values()];
}

// Packs xng ordered for this network: advanced, covering its wildcard, and
// with no hosts beyond the ones certHosts() asks for (so a hand-made pack
// that happens to include the wildcard is never deleted).
function ownPacks(
  packs: CertificatePack[],
  hosts: string[],
): CertificatePack[] {
  const wildcard = hosts[1];
  const allowed = new Set(hosts);
  return packs.filter(
    (p) =>
      p.type === 'advanced' &&
      p.hosts?.includes(wildcard as string) &&
      p.hosts.every((h) => allowed.has(h)),
  );
}

export type EnsureOptions = {
  run?: CfRunner;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
};

// Orders the network's certificate pack unless a live one exists, then
// waits until Cloudflare serves it (typically a few minutes: TXT validation
// is automatic on a full-setup zone). Idempotent, so `xng start` can call it
// to pick up networks created before Cloudflare mode was enabled.
export async function ensureCertificate(
  spec: NetworkSpec,
  cfg: CfConfig,
  opts: EnsureOptions = {},
): Promise<void> {
  const hosts = certHosts(spec, cfg.zone);
  if (!hosts) return;
  const run = opts.run ?? cfRunner();
  const log = opts.log ?? ((line: string) => console.log(line));
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 10_000;

  const existing = ownPacks(
    await listCertificatePacks(run, cfg.zone),
    hosts,
  ).find((p) => !isDead(p.status));
  let pack: CertificatePack;
  if (existing) {
    pack = existing;
  } else {
    log(`cloudflare: ordering certificate for ${hosts.join(', ')}`);
    const created = await run([
      'ssl',
      'certificate-packs',
      'create',
      '--zone',
      cfg.zone,
      '--type',
      'advanced',
      // One --hosts per host: cf's array flag does not split on commas.
      ...hosts.flatMap((h) => ['--hosts', h]),
      '--validation-method',
      'txt',
      '--validity-days',
      '90',
      '--certificate-authority',
      cfg.ca,
    ]);
    const id = (created as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string') {
      throw new Error(
        `cf ssl certificate-packs create returned no pack id: ${JSON.stringify(created)}`,
      );
    }
    pack = { ...(created as CertificatePack), id };
  }

  const deadline = now() + cfg.timeoutMs;
  let lastStatus: string | undefined;
  for (;;) {
    if (pack.status !== lastStatus) {
      log(`cloudflare: certificate ${pack.id} is ${pack.status ?? 'unknown'}`);
      lastStatus = pack.status;
    }
    if (pack.status === 'active') return;
    if (isDead(pack.status)) {
      throw new Error(
        `cloudflare certificate ${pack.id} for ${hosts[1]} ended in "${pack.status}"; delete it and run \`xng start --name ${spec.name}\` to order a new one`,
      );
    }
    if (now() >= deadline) {
      throw new Error(
        `cloudflare certificate ${pack.id} for ${hosts[1]} is still "${pack.status}" after ${cfg.timeoutMs / 1000}s; \`xng start --name ${spec.name}\` waits for it again`,
      );
    }
    await sleep(pollMs);
    const fetched = await run([
      'ssl',
      'certificate-packs',
      'get',
      pack.id,
      '--zone',
      cfg.zone,
    ]);
    pack = {
      ...pack,
      ...(fetched as CertificatePack | undefined),
      id: pack.id,
    };
  }
}

// Deletes the network's certificate pack(s). Called by `xng remove`.
export async function removeCertificate(
  spec: NetworkSpec,
  cfg: CfConfig,
  opts: Pick<EnsureOptions, 'run' | 'log'> = {},
): Promise<void> {
  const hosts = certHosts(spec, cfg.zone);
  if (!hosts) return;
  const run = opts.run ?? cfRunner();
  const log = opts.log ?? ((line: string) => console.log(line));
  const packs = ownPacks(
    await listCertificatePacks(run, cfg.zone),
    hosts,
  ).filter((p) => p.status !== 'deleted' && p.status !== 'pending_deletion');
  for (const pack of packs) {
    log(`cloudflare: deleting certificate ${pack.id} for ${hosts[1]}`);
    await run([
      'ssl',
      'certificate-packs',
      'delete',
      pack.id,
      '--zone',
      cfg.zone,
      '--force',
    ]);
  }
}
