import { stringify } from 'yaml';
import {
  VL_HOST,
  containerName,
  endpoints,
  explorerHostPort,
  hostPorts,
  nodeName,
  ports,
} from './types.ts';
import type { NetworkSpec } from './types.ts';

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
): string[] {
  const routerName = `${spec.name}-${router}`;
  return [
    `traefik.http.routers.${routerName}.rule=Host(\`${host}\`)`,
    `traefik.http.routers.${routerName}.entrypoints=web,websecure`,
    `traefik.http.routers.${routerName}.service=${routerName}`,
    `traefik.http.services.${routerName}.loadbalancer.server.port=${port}`,
  ];
}

export function renderCompose(spec: NetworkSpec): string {
  // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
  const services: Record<string, any> = {};
  const { name, domain } = spec;
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

    const command =
      spec.type === 'standalone'
        ? [
            'xahaud',
            '-a',
            '--conf',
            'xahaud.cfg',
            '--ledgerfile',
            'genesis.json',
          ]
        : // First boot (no db/ yet) seeds the chain from genesis.json; any
          // later boot (`xng start` after `stop`, or a container recreated by
          // `xng upgrade`) must continue from the ledger already in db/ via
          // --load. Restarting from genesis.json with an existing network
          // would start a validator at seq 1, and a lone validator then
          // forks a fresh chain instead of rejoining the real one.
          [
            'sh',
            '-c',
            `if [ -d db ]; then exec xahaud --conf xahaud.cfg --quorum=${spec.quorum} --load; else exec xahaud --conf xahaud.cfg --quorum=${spec.quorum} --ledgerfile genesis.json; fi`,
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
    };
    // Only `node` (index 0) is reachable from outside the compose network:
    // on testnet, routed through Traefik; on standalone, published directly
    // on the host via --port-offset, exactly as before Traefik existed.
    // Validators are always container-to-container only. On testnet the
    // peer port is never routed (xahaud peer TLS sends no SNI, so Traefik
    // can't dispatch it).
    if (i === 0) {
      if (spec.type === 'testnet') {
        services[serviceName].networks = ['default', 'proxy'];
        services[serviceName].labels = [
          'traefik.enable=true',
          'traefik.docker.network=proxy',
          ...traefikRoute(
            spec,
            'ws',
            `${name}.${domain}`,
            containerPorts.wsPublic,
          ),
          ...traefikRoute(
            spec,
            'rpc',
            `rpc.${name}.${domain}`,
            containerPorts.rpcPublic,
          ),
        ];
      } else {
        const host = hostPorts(spec);
        services[serviceName].ports = [
          `${host.rpcAdmin}:${containerPorts.rpcAdmin}`,
          `${host.rpcPublic}:${containerPorts.rpcPublic}`,
          `${host.wsAdmin}:${containerPorts.wsAdmin}`,
          `${host.wsPublic}:${containerPorts.wsPublic}`,
          `${host.peer}:${containerPorts.peer}`,
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
      volumes: ['./vl:/usr/share/nginx/html:ro'],
      networks: ['default', 'proxy'],
      labels: [
        'traefik.enable=true',
        'traefik.docker.network=proxy',
        ...traefikRoute(spec, 'vl', `vl.${name}.${domain}`, 80),
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

    services.faucet = {
      build: './faucet',
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
        ...traefikRoute(spec, 'faucet', `faucet.${name}.${domain}`, 8080),
      ],
      depends_on: [nodeName(spec, 0)],
    };
  }

  const explorerBase = {
    image: 'transia/explorer:latest',
    platform: 'linux/amd64',
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
            ...traefikRoute(
              spec,
              'explorer',
              `explorer.${name}.${domain}`,
              4000,
            ),
          ],
        }
      : { ...explorerBase, ports: [`${explorerHostPort(spec)}:4000`] };

  // Fixed names (`testnet-3-explorer`) instead of compose's `-1` suffix.
  for (const [serviceName, service] of Object.entries(services)) {
    service.container_name = containerName(spec, serviceName);
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
