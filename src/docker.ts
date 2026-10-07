import { execFile, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Child `xng` invocations (the panel's job runner, `xng apply`) run the CLI
// itself rather than a second implementation of each command.
export const TSX_BIN = fileURLToPath(
  new URL('../node_modules/.bin/tsx', import.meta.url),
);
export const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));

const TRAEFIK_COMPOSE = fileURLToPath(
  new URL('../traefik/compose.yml', import.meta.url),
);
const TRAEFIK_ACME_COMPOSE = fileURLToPath(
  new URL('../traefik/compose.acme.yml', import.meta.url),
);
export const TRAEFIK_ACME_ENV = fileURLToPath(
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
      // A hung docker call must not defeat the caller's own deadline.
      timeout: 120_000,
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
function ensureProxyNetwork(): void {
  const inspect = spawnSync('docker', ['network', 'inspect', 'proxy'], {
    stdio: 'ignore',
  });
  if (inspect.status !== 0) run(['network', 'create', 'proxy']);
}

// xahaud's pwa `secure_gateway` must name the proxy's address, and Traefik's
// container IP is dynamic, so the network's subnet(s) are used instead.
export function proxySubnets(): string[] {
  ensureProxyNetwork();
  const out = spawnSync(
    'docker',
    [
      'network',
      'inspect',
      'proxy',
      '--format',
      '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
    ],
    { encoding: 'utf8' },
  );
  const subnets = (out.stdout ?? '').split(/\s+/).filter(Boolean);
  if (out.status !== 0 || subnets.length === 0) {
    throw new Error('could not read the subnets of the docker network "proxy"');
  }
  return subnets;
}

export function ensureProxy(): void {
  ensureProxyNetwork();
  run(['compose', ...traefikArgs(), 'up', '-d']);
}

export function proxyDown(): void {
  run(['compose', ...traefikArgs(), 'down']);
}

export type Container = { service: string; state: string; status: string };

// One `docker ps` for every network rather than a `compose ps` per network:
// the panel's status path is polled every few seconds and must never wait on
// compose. Rows are grouped by the compose project label (= network name).
// Throws when docker is unreachable: `xng apply` must not mistake a stopped
// daemon for "nothing is running" (the panel catches and shows an empty list).
export async function listContainers(): Promise<Map<string, Container[]>> {
  const byProject = new Map<string, Container[]>();
  const { stdout } = await execFileAsync(
    'docker',
    [
      'ps',
      '-a',
      '--format',
      'json',
      '--filter',
      'label=com.docker.compose.project',
    ],
    { timeout: 5000 },
  );
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let row: { Labels: string; State: string; Status: string };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const labels = new Map(
      row.Labels.split(',').map((kv) => kv.split('=', 2) as [string, string]),
    );
    const project = labels.get('com.docker.compose.project');
    const service = labels.get('com.docker.compose.service');
    if (!project || !service) continue;
    const list = byProject.get(project) ?? [];
    list.push({ service, state: row.State, status: row.Status });
    byProject.set(project, list);
  }
  return byProject;
}

// Pure part of staleProjects: a project is stale when one of its containers
// runs an image ID other than the local ID of the same reference. A reference
// with no local image (absent from localIds) is not stale.
export function staleFromInspect(
  rows: { project: string; image: string; imageId: string }[],
  localIds: Map<string, string>,
): Set<string> {
  const stale = new Set<string>();
  for (const { project, image, imageId } of rows) {
    const local = localIds.get(image);
    if (project && local && local !== imageId) stale.add(project);
  }
  return stale;
}

// Compose projects (= network names) with a container older than the image now
// present locally (e.g. after `docker pull` of a floating tag). Throws like
// listContainers: `xng apply` must not read a docker error as "nothing stale".
export async function staleProjects(): Promise<Set<string>> {
  const docker = async (args: string[]) =>
    (await execFileAsync('docker', args, { timeout: 5000 })).stdout;
  const ids = (
    await docker([
      'ps',
      '-a',
      '-q',
      '--filter',
      'label=com.docker.compose.project',
    ])
  )
    .split('\n')
    .filter(Boolean);
  if (ids.length === 0) return new Set();

  const rows = (
    await docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "com.docker.compose.project"}}\t{{.Config.Image}}\t{{.Image}}',
      ...ids,
    ])
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [project = '', image = '', imageId = ''] = line.split('\t');
      return { project, image, imageId };
    });

  const refs = [...new Set(rows.map((r) => r.image))];
  const localIds = new Map<string, string>();
  const inspect = (list: string[]) =>
    docker(['image', 'inspect', '--format', '{{.Id}}', ...list]);
  try {
    (await inspect(refs))
      .split('\n')
      .filter(Boolean)
      .forEach((id, i) => localIds.set(refs[i] as string, id));
  } catch {
    // A ref gone locally fails the batch; retry one by one, skipping only
    // those (any other docker error still aborts apply).
    for (const ref of refs) {
      try {
        localIds.set(ref, (await inspect([ref])).trim());
      } catch (err) {
        if (
          !String((err as { stderr?: string }).stderr).includes('No such image')
        )
          throw err;
      }
    }
  }
  return staleFromInspect(rows, localIds);
}
