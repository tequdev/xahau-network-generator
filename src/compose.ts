import { stringify } from 'yaml';
import {
  VL_HOST,
  containerName,
  endpoints,
  explorerHostPort,
  hostBase,
  hostPorts,
  nodeName,
  ports,
} from './types.ts';
import type { NetworkSpec } from './types.ts';

// nginx:alpine advertises its version in the Server header and on its error
// pages (the VL host's / is a 403). conf.d/*.conf is included at http level,
// so one dropped-in line turns that off without shipping a config file.
const NGINX_COMMAND = [
  'sh',
  '-c',
  "echo 'server_tokens off;' > /etc/nginx/conf.d/zz-tokens.conf && exec nginx -g 'daemon off;'",
];

// Every routed service is enrolled on both the default (inter-container)
// network and the shared external `proxy` network Traefik watches, and
// carries the traefik.* labels for its router(s). `name`/`domain` are baked
// into literal hostnames (xng renders one compose.yml per network, so no
// ${COMPOSE_PROJECT_NAME} interpolation is needed like in xahau-devnets).
function traefikRoute(
  spec: NetworkSpec,
  router: string,
  host: string,
  port: number,
  extraRule = '',
): string[] {
  const routerName = `${spec.name}-${router}`;
  return [
    `traefik.http.routers.${routerName}.rule=Host(\`${host}\`)${extraRule}`,
    `traefik.http.routers.${routerName}.entrypoints=web,websecure`,
    `traefik.http.routers.${routerName}.service=${routerName}`,
    `traefik.http.services.${routerName}.loadbalancer.server.port=${port}`,
  ];
}

export function renderCompose(spec: NetworkSpec): string {
  // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
  const services: Record<string, any> = {};
  const base = hostBase(spec);
  const containerPorts = ports(spec, 0);

  // Index 0 is always the non-validating, user-facing `node`; testnet adds
  // v1..vN validators alongside it.
  const nodeIndices =
    spec.type === 'standalone'
      ? [0]
      : [0, ...Array.from({ length: spec.validators }, (_, i) => i + 1)];

  for (const i of nodeIndices) {
    const serviceName = nodeName(spec, i);
    const nodeDir = serviceName;

    // First boot (no db/ yet) seeds the chain from genesis.json; any later
    // boot (`xng start` after `stop`, a container restarted by Docker after
    // a daemon/host restart, or a container recreated by `xng upgrade`) must
    // continue from the ledger already in db/ via --load. Restarting from
    // genesis.json with an existing network would start a validator at seq
    // 1, and a lone validator then forks a fresh chain instead of rejoining
    // the real one (standalone: `-a --load` resumes xahaud stand-alone mode
    // from the last ledger saved in db/).
    const xahaud = `xahaud --conf xahaud.cfg${spec.type === 'standalone' ? ' -a' : ` --quorum=${spec.quorum}`}`;
    const command = [
      'sh',
      '-c',
      `if [ -d db ]; then exec ${xahaud} --load; else exec ${xahaud} --ledgerfile genesis.json; fi`,
    ];

    services[serviceName] = {
      image: 'ubuntu:noble',
      platform: 'linux/amd64',
      // Run as the host user so bind-mounted nodes/*/db isn't root-owned on
      // Linux (breaks `xng reset`/`remove` there; macOS's Docker VM hides
      // this). docker.ts passes XNG_UID/XNG_GID for compose to interpolate.
      user: '${XNG_UID:-0}:${XNG_GID:-0}',
      working_dir: '/node',
      command,
      volumes: [
        `./bin/${serviceName}/xahaud:/usr/local/bin/xahaud:ro`,
        `./nodes/${nodeDir}:/node`,
      ],
      // xahaud writes its log to stderr, and `node` logs the View partition
      // at trace, so docker's default unbounded json-file log would grow
      // without limit; 60 MB is plenty for `docker logs` debugging.
      // Validators get the same cap to keep the services uniform.
      logging: {
        driver: 'json-file',
        options: { 'max-size': '20m', 'max-file': '3' },
      },
    };
    // Only `node` (index 0) is reachable from outside the compose network:
    // on testnet, routed through Traefik; on standalone, published directly
    // on the host via --port-offset, on loopback only since the admin ports
    // trust every source.
    // Validators are always container-to-container only. On testnet the
    // peer port is never routed (xahaud peer TLS sends no SNI, so Traefik
    // can't dispatch it).
    if (i === 0) {
      if (spec.type === 'testnet') {
        services[serviceName].networks = ['default', 'proxy'];
        services[serviceName].labels = [
          'traefik.enable=true',
          'traefik.docker.network=proxy',
          // A root network shares the bare domain between wss and the landing
          // page: only WebSocket upgrades go to the node. Traefik ranks
          // routers by rule length, so this longer rule beats the site's; it
          // would also beat the debugstream one, hence the path exclusion.
          // A non-root ws router stays plain Host(): the debugstream rule is
          // longer and wins on its path by itself.
          ...traefikRoute(
            spec,
            'ws',
            base,
            containerPorts.wsPublic,
            spec.root
              ? ' && HeaderRegexp(`Upgrade`, `(?i)^websocket$$`) && !PathPrefix(`/debugstream/`)'
              : '',
          ),
          ...traefikRoute(spec, 'rpc', `rpc.${base}`, containerPorts.rpcPublic),
          ...(spec.pwa
            ? traefikRoute(spec, 'pwa', `pwa.${base}`, containerPorts.pwa)
            : []),
        ];
      } else {
        const host = hostPorts(spec);
        services[serviceName].ports = [
          `127.0.0.1:${host.rpcAdmin}:${containerPorts.rpcAdmin}`,
          `127.0.0.1:${host.rpcPublic}:${containerPorts.rpcPublic}`,
          `127.0.0.1:${host.wsAdmin}:${containerPorts.wsAdmin}`,
          `127.0.0.1:${host.wsPublic}:${containerPorts.wsPublic}`,
          `127.0.0.1:${host.peer}:${containerPorts.peer}`,
        ];
      }
    }
    if (spec.type === 'testnet') {
      services[serviceName].depends_on = {
        [VL_HOST]: { condition: 'service_healthy' },
      };
    }
  }

  if (spec.type === 'testnet') {
    services[VL_HOST] = {
      image: 'nginx:alpine',
      command: NGINX_COMMAND,
      volumes: ['./vl:/usr/share/nginx/html:ro'],
      networks: ['default', 'proxy'],
      labels: [
        'traefik.enable=true',
        'traefik.docker.network=proxy',
        ...traefikRoute(spec, 'vl', `vl.${base}`, 80),
      ],
      healthcheck: {
        test: [
          'CMD',
          'wget',
          '-q',
          '-O',
          '/dev/null',
          'http://localhost/vl.json',
        ],
        interval: '2s',
        timeout: '2s',
        retries: 15,
      },
    };

    if (spec.root) {
      // One directory mount: writeSiteIndex copies the repo's site/ next to
      // networks.json. A file mount would pin the inode (a rewritten
      // networks.json stays stale), and a second mount nested inside a
      // read-only one cannot be created by Docker.
      services.site = {
        image: 'nginx:alpine',
        command: NGINX_COMMAND,
        volumes: ['./site:/usr/share/nginx/html:ro'],
        networks: ['default', 'proxy'],
        labels: [
          'traefik.enable=true',
          'traefik.docker.network=proxy',
          ...traefikRoute(spec, 'site', base, 80),
        ],
      };
    }

    services.faucet = {
      // Resolved against the compose file's directory (workspace/<name>/), so a
      // faucet fix in the repo is built on the next start without copying.
      build: '../../faucet',
      environment: {
        XAHAU_WS_URL: `ws://${containerName(spec, nodeName(spec, 0))}:${ports(spec, 0).wsPublic}`,
        PORT: '8080',
        FAUCET_KEY_FILE: '/run/faucet.json',
      },
      volumes: ['./keys/faucet.json:/run/faucet.json:ro'],
      networks: ['default', 'proxy'],
      labels: [
        'traefik.enable=true',
        'traefik.docker.network=proxy',
        ...traefikRoute(spec, 'faucet', `faucet.${base}`, 8080),
      ],
      depends_on: [nodeName(spec, 0)],
    };

    services.debugstream = {
      // Built from the repo like faucet, so a fix is picked up on next start.
      build: '../../debugstream',
      environment: { LOG_FILE: '/log/debug.log', PORT: '8080' },
      // Hard ceiling for a sidecar that only tails a file; node itself is
      // ~40 MB RSS. Docker restarts it (unless-stopped) if it is ever hit.
      mem_limit: '128m',
      // Read-write: the service truncates the file once it grows past a cap
      // (10 MiB by default), so the log never accumulates on disk.
      volumes: [`./nodes/${nodeName(spec, 0)}/log:/log`],
      networks: ['default', 'proxy'],
      labels: [
        'traefik.enable=true',
        'traefik.docker.network=proxy',
        ...traefikRoute(
          spec,
          'debugstream',
          base,
          8080,
          ' && PathPrefix(`/debugstream/`)',
        ),
      ],
      depends_on: [nodeName(spec, 0)],
    };
  }

  // tequdev/XRPL-Technical-Explorer@xahau-devnet: transia/explorer with the
  // header fixed to "Xahau Devnet" on any domain.
  const explorerBase = {
    image: 'ghcr.io/tequdev/xrpl-technical-explorer:xahau-devnet',
    environment: {
      PORT: '4000',
      VUE_APP_WSS_ENDPOINT: endpoints(spec).ws,
    },
  };
  services.explorer =
    spec.type === 'testnet'
      ? {
          ...explorerBase,
          networks: ['default', 'proxy'],
          labels: [
            'traefik.enable=true',
            'traefik.docker.network=proxy',
            ...traefikRoute(spec, 'explorer', `explorer.${base}`, 4000),
          ],
        }
      : {
          ...explorerBase,
          ports: [`127.0.0.1:${explorerHostPort(spec)}:4000`],
        };

  // Fixed names (`testnet-3-explorer`) instead of compose's `-1` suffix.
  for (const [serviceName, service] of Object.entries(services)) {
    service.container_name = containerName(spec, serviceName);
    // dockerd restarts these itself after a daemon restart / host reboot;
    // `xng stop` is `compose down`, which removes the containers, so it's
    // unaffected by this policy.
    service.restart = 'unless-stopped';
  }

  // biome-ignore lint/suspicious/noExplicitAny: compose.yml document shape has no fixed schema here
  const doc: Record<string, any> = { name: spec.name, services };
  // Only testnet routes through the shared proxy network; standalone
  // publishes host ports directly and has no use for it.
  if (spec.type === 'testnet') {
    doc.networks = { proxy: { external: true } };
  }
  return stringify(doc);
}
