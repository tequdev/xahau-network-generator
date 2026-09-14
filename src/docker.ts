import { execFile, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TRAEFIK_COMPOSE = fileURLToPath(
  new URL('../traefik/compose.yml', import.meta.url),
);
const TRAEFIK_ACME_COMPOSE = fileURLToPath(
  new URL('../traefik/compose.acme.yml', import.meta.url),
);
const TRAEFIK_ACME_ENV = fileURLToPath(
  new URL('../traefik/acme.env', import.meta.url),
);

// `xng proxy up --acme-email` records the email in traefik/acme.env
// (gitignored); from then on every ensureProxy() applies the ACME overlay
// (Let's Encrypt for every routed hostname, see traefik/compose.acme.yml).
// Persisted in a file rather than read from the ambient environment on
// purpose: ensureProxy() also runs from `xng start`/`reset` (and from panel
// jobs), and a single invocation without the env var would `compose up`
// Traefik with fewer files, recreating it without the cert resolver and
// breaking HTTPS for every network at once.
export function enableAcme(email: string): void {
  writeFileSync(TRAEFIK_ACME_ENV, `XNG_ACME_EMAIL=${email}\n`);
}

function traefikArgs(): string[] {
  if (!existsSync(TRAEFIK_ACME_ENV)) return ['-f', TRAEFIK_COMPOSE];
  return [
    '--env-file',
    TRAEFIK_ACME_ENV,
    '-f',
    TRAEFIK_COMPOSE,
    '-f',
    TRAEFIK_ACME_COMPOSE,
  ];
}

export function compose(name: string, args: string[]): void {
  const result = spawnSync(
    'docker',
    ['compose', '-f', `workspace/${name}/compose.yml`, ...args],
    {
      stdio: 'inherit',
      // compose.yml interpolates these into each xahaud service's `user:`
      // so bind-mounted nodes/*/db ends up owned by the host user, not root.
      env: {
        ...process.env,
        XNG_UID: String(process.getuid?.() ?? 0),
        XNG_GID: String(process.getgid?.() ?? 0),
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} exited with code ${result.status}`,
    );
  }
}

// Like compose(), but captures stdout instead of inheriting it — for reading
// a command's output (e.g. `exec <service> ... server_info`) rather than
// just running it.
export function composeOutput(name: string, args: string[]): string {
  const result = spawnSync(
    'docker',
    ['compose', '-f', `workspace/${name}/compose.yml`, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        XNG_UID: String(process.getuid?.() ?? 0),
        XNG_GID: String(process.getgid?.() ?? 0),
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} exited with code ${result.status}: ${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

// Like composeOutput(), but non-blocking — for callers (the panel's HTTP
// server) that can't afford spawnSync's event-loop stall.
export async function composeOutputAsync(
  name: string,
  args: string[],
  timeoutMs?: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '-f', `workspace/${name}/compose.yml`, ...args],
      {
        env: {
          ...process.env,
          XNG_UID: String(process.getuid?.() ?? 0),
          XNG_GID: String(process.getgid?.() ?? 0),
        },
        timeout: timeoutMs,
      },
    );
    return stdout;
  } catch (err) {
    const e = err as { code?: number; stderr?: string; stdout?: string };
    throw new Error(
      `docker compose ${args.join(' ')} exited with code ${e.code}: ${e.stderr ?? ''}${e.stdout ?? ''}`,
    );
  }
}

function run(args: string[]): void {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} exited with code ${result.status}`,
    );
  }
}

// Creates the shared `proxy` network every generated network's routed
// services join, and starts the single Traefik instance (traefik/compose.yml)
// that routes them all by subdomain. Idempotent; called by `xng start`/`reset`.
export function ensureProxy(): void {
  const inspect = spawnSync('docker', ['network', 'inspect', 'proxy'], {
    stdio: 'ignore',
  });
  if (inspect.status !== 0) run(['network', 'create', 'proxy']);
  run(['compose', ...traefikArgs(), 'up', '-d']);
}

export function proxyDown(): void {
  run(['compose', ...traefikArgs(), 'down']);
}
