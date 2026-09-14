import { stringify } from 'yaml';
import {
  VL_HOST,
  explorerHostPort,
  faucetHostPort,
  hostPorts,
  nodeName,
  ports,
} from './types.ts';
import type { NetworkSpec } from './types.ts';

export function renderCompose(spec: NetworkSpec): string {
  // biome-ignore lint/suspicious/noExplicitAny: compose.yml service shape has no fixed schema here
  const services: Record<string, any> = {};

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
        : [
            'xahaud',
            '--conf',
            'xahaud.cfg',
            '--ledgerfile',
            'genesis.json',
            `--quorum=${spec.quorum}`,
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
        './bin/xahaud:/usr/local/bin/xahaud:ro',
        `./nodes/${nodeDir}:/node`,
      ],
    };
    // Only `node` (index 0) is reachable from the host; validators are
    // container-to-container only and publish no ports.
    if (i === 0) {
      const host = hostPorts(spec);
      services[serviceName].ports = [
        `${host.rpcAdmin}:5005`,
        `${host.rpcPublic}:5007`,
        `${host.wsAdmin}:6006`,
        `${host.wsPublic}:6008`,
        `${host.peer}:51235`,
      ];
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
        XAHAU_WS_URL: `ws://${nodeName(spec, 0)}:${ports(spec, 0).wsPublic}`,
        PORT: '8080',
        FAUCET_KEY_FILE: '/run/faucet.json',
      },
      volumes: ['./keys/faucet.json:/run/faucet.json:ro'],
      ports: [`${faucetHostPort(spec)}:8080`],
      depends_on: [nodeName(spec, 0)],
    };
  }

  const primaryHost = hostPorts(spec);
  services.explorer = {
    image: 'transia/explorer:latest',
    platform: 'linux/amd64',
    environment: {
      PORT: '4000',
      VUE_APP_WSS_ENDPOINT: `ws://localhost:${primaryHost.wsPublic}`,
    },
    ports: [`${explorerHostPort(spec)}:4000`],
  };

  // Fixed names (`testnet-3-explorer`) instead of compose's `-1` suffix.
  for (const [serviceName, service] of Object.entries(services)) {
    service.container_name = `${spec.name}-${serviceName}`;
  }

  return stringify({ name: spec.name, services });
}
