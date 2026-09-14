import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOSTED_DIR,
  containerName,
  hostedUnit,
  xahaudCommand,
} from './types.ts';
import type { NetworkSpec } from './types.ts';

const SSH_OPTS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
];

// Runs `command` on root@ip over ssh. `input` (a tar stream, a binary, or
// text like /etc/hosts lines) is piped to the remote command's stdin when
// given; stdout/stderr are otherwise inherited so remote output shows up
// live, matching docker.ts's compose().
function sshRun(ip: string, command: string, input?: Buffer | string): void {
  const result = spawnSync('ssh', [...SSH_OPTS, `root@${ip}`, command], {
    // Never inherit the CLI's own stdin: ssh with an interactive stdin can
    // hang or steal keystrokes from the running `xng` process.
    stdio: [input !== undefined ? 'pipe' : 'ignore', 'inherit', 'inherit'],
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `ssh root@${ip} '${command}' exited with code ${result.status}`,
    );
  }
}

// Like sshRun, but captures and returns stdout (for server_info).
function sshOutput(ip: string, command: string): string {
  const result = spawnSync('ssh', [...SSH_OPTS, `root@${ip}`, command], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `ssh root@${ip} '${command}' exited with code ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

function hostOf(spec: NetworkSpec, svc: string): string {
  const ip = spec.hosts?.[svc];
  if (!ip) {
    throw new Error(
      `no IP configured for "${svc}" in spec.hosts (network "${spec.name}")`,
    );
  }
  return ip;
}

// systemd unit for a hosted validator; ExecStart shares xahaudCommand(spec)
// with compose.ts's container command so first-boot logic never drifts
// between the two (see types.ts comment). No single quotes in the command
// today (asserted in hosted.test.ts) since it's wrapped in one.
export function renderUnit(spec: NetworkSpec, svc: string): string {
  const dir = HOSTED_DIR(spec);
  return `[Unit]
Description=xahaud ${spec.name} ${svc}
Wants=network-online.target
After=network-online.target
[Service]
WorkingDirectory=${dir}/nodes/${svc}
Environment=PATH=${dir}/bin/${svc}:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/sh -c '${xahaudCommand(spec)}'
Restart=on-failure
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
`;
}

// /etc/hosts lines for every name in spec.hosts (node included), so a
// validator can resolve `<name>-node` and every other `<name>-vN` the same
// way compose resolves them by container name. Marked with `# xng:<name>`
// so deployValidator/removeValidator can find and replace/delete just this
// network's lines idempotently.
export function renderHostsLines(spec: NetworkSpec): string {
  const hosts = spec.hosts ?? {};
  return `${Object.entries(hosts)
    .map(([svc, ip]) => `${ip} ${containerName(spec, svc)} # xng:${spec.name}`)
    .join('\n')}\n`;
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Parses `--hosts node=10.0.0.10,v1=10.0.0.11,...` into a Record, requiring
// keys to be exactly "node" plus "v1".."v<validators>" and values to look
// like IPv4 addresses.
export function parseHosts(
  value: string,
  validators: number,
): Record<string, string> {
  const hosts: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const [key, ip] = pair.split('=');
    if (!key || !ip) {
      throw new Error(`invalid --hosts entry "${pair}", expected key=ip`);
    }
    if (!IPV4_RE.test(ip)) {
      throw new Error(`invalid IPv4 address "${ip}" for "${key}"`);
    }
    hosts[key] = ip;
  }
  const expected = [
    'node',
    ...Array.from({ length: validators }, (_, i) => `v${i + 1}`),
  ];
  const missing = expected.filter((k) => !(k in hosts));
  const extra = Object.keys(hosts).filter((k) => !expected.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [
      `--hosts keys must be exactly ${expected.join(', ')}`,
    ];
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`extra: ${extra.join(', ')}`);
    throw new Error(parts.join('; '));
  }
  return hosts;
}

// Ships workspace/<name>/{nodes/<svc>,bin/<svc>} to the host and
// (re)installs it as a systemd service. Idempotent: safe to call again for
// an already-deployed validator (e.g. `xng reset`).
export function deployValidator(spec: NetworkSpec, svc: string): void {
  const ip = hostOf(spec, svc);
  const localDir = join('workspace', spec.name);
  const remoteDir = HOSTED_DIR(spec);

  const tar = spawnSync(
    'tar',
    ['-C', localDir, '-c', '-f', '-', `nodes/${svc}`, `bin/${svc}`],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  if (tar.error) throw tar.error;
  if (tar.status !== 0) {
    throw new Error(
      `tar -C ${localDir} -c nodes/${svc} bin/${svc} exited with code ${tar.status}: ${tar.stderr}`,
    );
  }
  // Relies on GNU tar unlinking each file before writing it (rather than
  // truncating in place): a running xahaud keeps its old binary/db files
  // open under their old inode until the unit is restarted. Busybox tar
  // truncates in place instead, which would corrupt a running process's
  // open files — this needs GNU tar on the remote host.
  sshRun(
    ip,
    `mkdir -p ${remoteDir} && tar -x -f - -C ${remoteDir}`,
    tar.stdout,
  );

  // Idempotent /etc/hosts update: drop this network's old lines (if any),
  // then append the current ones.
  sshRun(
    ip,
    `sed -i '/# xng:${spec.name}$/d' /etc/hosts && cat >> /etc/hosts`,
    renderHostsLines(spec),
  );

  const unit = hostedUnit(spec, svc);
  sshRun(
    ip,
    `cat > /etc/systemd/system/${unit}.service`,
    renderUnit(spec, svc),
  );

  // No unconditional restart: `enable --now` starts the unit if it's
  // stopped and is a no-op if it's already running, so calling
  // deployValidator against an already-running validator (e.g. `xng start`
  // on a network that's already up) never restarts it and can't drop
  // consensus below quorum. The files just shipped are only picked up on
  // the unit's next restart, which `xng upgrade` (upgradeValidator restarts
  // itself) and `xng reset` (resetValidator stops first, so this starts it
  // fresh) already trigger.
  sshRun(ip, `systemctl daemon-reload && systemctl enable --now ${unit}`);
}

export function stopValidator(spec: NetworkSpec, svc: string): void {
  const ip = hostOf(spec, svc);
  // disable, not just stop: deployValidator re-enables on the next
  // start/reset, so start/stop stay symmetric and an LXC reboot doesn't
  // resurrect a validator `xng stop` was told to shut down.
  sshRun(ip, `systemctl disable --now ${hostedUnit(spec, svc)} || true`);
}

// Stop + wipe ledger data, so the validator restarts from genesis on next
// deployValidator (mirrors resetNetworkData in network.ts).
export function resetValidator(spec: NetworkSpec, svc: string): void {
  stopValidator(spec, svc);
  const ip = hostOf(spec, svc);
  sshRun(ip, `rm -rf ${HOSTED_DIR(spec)}/nodes/${svc}/db`);
}

export function removeValidator(spec: NetworkSpec, svc: string): void {
  const ip = hostOf(spec, svc);
  const unit = hostedUnit(spec, svc);
  sshRun(
    ip,
    [
      `systemctl disable --now ${unit} || true`,
      `rm -f /etc/systemd/system/${unit}.service`,
      'systemctl daemon-reload',
      `rm -rf ${HOSTED_DIR(spec)}`,
      `sed -i '/# xng:${spec.name}$/d' /etc/hosts`,
    ].join('; '),
  );
}

// `xahaud ... server_info` run over ssh, same as `docker compose exec ...`
// for a compose service (see upgrade.ts's fetchInfo).
export function validatorServerInfo(spec: NetworkSpec, svc: string): string {
  const ip = hostOf(spec, svc);
  const dir = HOSTED_DIR(spec);
  return sshOutput(
    ip,
    `cd ${dir}/nodes/${svc} && ${dir}/bin/${svc}/xahaud --conf xahaud.cfg server_info`,
  );
}

// Streams a new binary to the host and swaps it in. Never overwrites the
// running binary in place (ETXTBSY): write alongside as xahaud.tmp, then
// rename over it, then restart.
export function upgradeValidator(
  spec: NetworkSpec,
  svc: string,
  localBinaryPath: string,
): void {
  const ip = hostOf(spec, svc);
  const binDir = `${HOSTED_DIR(spec)}/bin/${svc}`;
  const tmpPath = `${binDir}/xahaud.tmp`;
  const finalPath = `${binDir}/xahaud`;
  const binary = readFileSync(localBinaryPath);
  sshRun(ip, `cat > ${tmpPath}`, binary);
  sshRun(
    ip,
    `chmod 755 ${tmpPath} && mv -f ${tmpPath} ${finalPath} && systemctl restart ${hostedUnit(spec, svc)}`,
  );
}
