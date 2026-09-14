import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TRAEFIK_COMPOSE = fileURLToPath(
  new URL('../traefik/compose.yml', import.meta.url),
);

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
      `docker compose ${args.join(' ')} exited with code ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
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
  run(['compose', '-f', TRAEFIK_COMPOSE, 'up', '-d']);
}

export function proxyDown(): void {
  run(['compose', '-f', TRAEFIK_COMPOSE, 'down']);
}
