import { spawnSync } from 'node:child_process';

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
