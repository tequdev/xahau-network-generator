import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cfConfigFromEnv,
  cfRunner,
  listCertificatePacks,
} from './cloudflare.ts';
import { TRAEFIK_ACME_ENV } from './docker.ts';

// `xng doctor`: is everything xng shells out to (docker, docker compose,
// build.xahau.tech, and `cf` when Cloudflare mode is on) actually usable?
// `fail` is something xng cannot run without; `info` is an optional feature
// and its current state, never an error.

export type Check = {
  name: string;
  status: 'ok' | 'fail' | 'info';
  detail: string;
};

const TRAEFIK_COMPOSE = fileURLToPath(
  new URL('../traefik/compose.yml', import.meta.url),
);

// Trimmed stdout of a command, or undefined when it is missing or exits non-zero.
function output(bin: string, args: string[]): string | undefined {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return undefined;
  return r.stdout.trim();
}

function major(version: string): number {
  return Number(version.replace(/^v/, '').split('.')[0]);
}

export function checkNode(version: string): Check {
  const ok = major(version) >= 22;
  return {
    name: 'node',
    status: ok ? 'ok' : 'fail',
    detail: ok ? version : `${version} (xng needs Node 22+)`,
  };
}

export function checkCompose(version: string | undefined): Check {
  if (version === undefined) {
    return {
      name: 'docker compose',
      status: 'fail',
      detail: 'not found (install the Docker Compose v2 plugin)',
    };
  }
  const ok = major(version) >= 2;
  return {
    name: 'docker compose',
    status: ok ? 'ok' : 'fail',
    detail: ok ? `v${version}` : `v${version} (xng needs Compose v2)`,
  };
}

function checkDocker(): Check {
  const r = spawnSync(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  if (r.error) {
    return {
      name: 'docker',
      status: 'fail',
      detail: 'not found (install Docker)',
    };
  }
  if (r.status !== 0) {
    return {
      name: 'docker',
      status: 'fail',
      detail: `daemon not reachable: ${r.stderr.trim().split('\n')[0]}`,
    };
  }
  return { name: 'docker', status: 'ok', detail: `v${r.stdout.trim()}` };
}

async function checkBuildServer(): Promise<Check> {
  const name = 'build.xahau.tech';
  try {
    const res = await fetch('https://build.xahau.tech/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { name, status: 'fail', detail: `HTTP ${res.status}` };
    return { name, status: 'ok', detail: 'reachable' };
  } catch (err) {
    return {
      name,
      status: 'fail',
      detail: `unreachable (${err instanceof Error ? err.message : err}); xng create downloads xahaud from here`,
    };
  }
}

function checkProxy(): Check {
  const running = output('docker', [
    'compose',
    '-f',
    TRAEFIK_COMPOSE,
    'ps',
    '-q',
    '--status',
    'running',
  ]);
  return {
    name: 'traefik proxy',
    status: 'info',
    detail: running
      ? 'running'
      : 'not running (`xng start` brings it up for testnets; `xng proxy up` starts it now)',
  };
}

function checkAcme(): Check {
  const name = "let's encrypt";
  try {
    const email = readFileSync(TRAEFIK_ACME_ENV, 'utf8').match(
      /^XNG_ACME_EMAIL=(.*)$/m,
    )?.[1];
    return { name, status: 'info', detail: `on (${email ?? '?'})` };
  } catch {
    return {
      name,
      status: 'info',
      detail: 'off (`xng proxy up --acme-email <email>` to enable)',
    };
  }
}

async function checkCloudflare(): Promise<Check[]> {
  const name = 'cloudflare';
  let cfg: ReturnType<typeof cfConfigFromEnv>;
  try {
    cfg = cfConfigFromEnv();
  } catch (err) {
    return [{ name, status: 'fail', detail: (err as Error).message }];
  }
  if (!cfg) {
    return [
      {
        name,
        status: 'info',
        detail: 'off (set XNG_CF_ZONE to order edge certificates through `cf`)',
      },
    ];
  }
  // With the mode on, `cf` (found + authenticated for the zone) is required:
  // this is the first call `xng create` makes.
  const checks: Check[] = [];
  try {
    const packs = await listCertificatePacks(cfRunner(), cfg.zone);
    checks.push({
      name,
      status: 'ok',
      detail: `zone ${cfg.zone}, ${packs.length} certificate pack(s), ca ${cfg.ca}`,
    });
  } catch (err) {
    checks.push({ name, status: 'fail', detail: (err as Error).message });
  }
  checks.push({
    name: 'cloudflared',
    status: 'info',
    detail:
      output('cloudflared', ['--version']) ??
      'not found (only needed on the tunnel host)',
  });
  return checks;
}

function checkPanelAccess(): Check {
  const on = process.env.XNG_ACCESS_TEAM && process.env.XNG_ACCESS_AUD;
  return {
    name: 'panel access',
    status: 'info',
    detail: on
      ? `Cloudflare Access (${process.env.XNG_ACCESS_TEAM})`
      : 'off (set XNG_ACCESS_TEAM and XNG_ACCESS_AUD, or run `xng panel --insecure-no-auth`)',
  };
}

export async function runChecks(): Promise<Check[]> {
  return [
    checkNode(process.version),
    checkDocker(),
    checkCompose(output('docker', ['compose', 'version', '--short'])),
    await checkBuildServer(),
    checkProxy(),
    checkAcme(),
    ...(await checkCloudflare()),
    checkPanelAccess(),
  ];
}

const MARK = { ok: 'ok  ', fail: 'FAIL', info: '--  ' };

// Prints one line per check; returns false when a required one failed.
export function report(checks: Check[]): boolean {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${MARK[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
  }
  return !checks.some((c) => c.status === 'fail');
}
