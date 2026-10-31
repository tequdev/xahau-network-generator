import {
  chmod,
  copyFile,
  link,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { renderCompose } from './compose.ts';
import { compose, composeOutput } from './docker.ts';
import { createValidatorKeys, signVl } from './keys.ts';
import type { PublisherKeys } from './keys.ts';
import { vlEntries, writeNodeConfig } from './network.ts';
import {
  RELAY,
  defaultQuorum,
  endpoints,
  nodeName,
  validateSpec,
} from './types.ts';
import type { NetworkSpec } from './types.ts';
import { parseServerInfoOutput, upgradeNetwork } from './upgrade.ts';
import { rpc } from './wait.ts';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// `add`: a count (ids max+1..) or the explicit new ids.
export type RotateOpts = { add: number | number[]; remove: string[] };

// Pure part: the spec while old and new validators are all trusted (interim)
// and the one after the removed ones left (final).
export function planRotation(
  spec: NetworkSpec,
  opts: RotateOpts,
): {
  interim: NetworkSpec;
  final: NetworkSpec;
  added: string[];
  removed: string[];
} {
  if (spec.type !== 'testnet' || spec.external) {
    throw new Error('rotate is testnet only');
  }
  const { add, remove } = opts;
  const ids =
    spec.validatorIds ??
    Array.from({ length: spec.validators }, (_, i) => i + 1);
  const names = ids.map((id) => `v${id}`);
  for (const r of remove) {
    if (!names.includes(r)) {
      throw new Error(
        `cannot remove "${r}": not a validator of ${spec.name} (have ${names.join(', ')})`,
      );
    }
  }
  const explicit = Array.isArray(add);
  const addCount = explicit ? add.length : add;
  if (explicit) {
    if (
      !add.every((n) => Number.isInteger(n) && n >= 1) ||
      new Set(add).size !== add.length
    ) {
      throw new Error(
        `add ids must be distinct integers >= 1, got "${add.join(',')}"`,
      );
    }
    const clash = add.filter((n) => ids.includes(n));
    if (clash.length > 0) {
      throw new Error(
        `cannot add ${clash.map((n) => `v${n}`).join(', ')}: already a validator of ${spec.name}`,
      );
    }
  } else if (!Number.isInteger(add) || add < 0) {
    throw new Error(`add must be an integer >= 0, got "${add}"`);
  }
  if (addCount === 0 && remove.length === 0) {
    throw new Error('nothing to rotate: add and/or remove validators');
  }
  const newIds = explicit
    ? add
    : Array.from({ length: add }, (_, i) => Math.max(...ids) + 1 + i);
  const keptIds = ids.filter((id) => !remove.includes(`v${id}`));
  const count = keptIds.length + addCount;
  // --quorum is absolute for xahaud, so the interim (and new) validators
  // already start with the final one.
  const quorum = count === spec.validators ? spec.quorum : defaultQuorum(count);
  const interim: NetworkSpec = {
    ...spec,
    validatorIds: [...ids, ...newIds],
    validators: ids.length + addCount,
    quorum,
  };
  const final: NetworkSpec = {
    ...spec,
    validatorIds: [...keptIds, ...newIds],
    validators: count,
    quorum,
  };
  // Only `final` is validated: nothing is rolled while the interim set is
  // trusted unless the quorum changes, and it is never smaller than `spec`.
  validateSpec(final);
  return {
    interim,
    final,
    added: newIds.map((id) => `v${id}`),
    removed: names.filter((n) => remove.includes(n)),
  };
}

// `xahaud --conf xahaud.cfg validators` prints the same {"result":{...}}
// envelope as the JSON-RPC admin API; trusted_validator_keys are base58 node
// public keys (n...).
export function parseValidatorsOutput(stdout: string): { trusted: string[] } {
  let parsed: { result?: { trusted_validator_keys?: string[] } };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not parse validators output as JSON: ${stdout}`);
  }
  const trusted = parsed.result?.trusted_validator_keys;
  if (!Array.isArray(trusted)) {
    throw new Error(`unexpected validators output: ${stdout}`);
  }
  return { trusted };
}

const xahaudExec = (spec: NetworkSpec, service: string, cmd: string) =>
  composeOutput(spec.name, [
    'exec',
    '-T',
    service,
    'xahaud',
    '--conf',
    'xahaud.cfg',
    cmd,
  ]);

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Polls every 2s until `done` returns true or the shared deadline passes;
// a failing poll (container still booting) is logged and retried.
async function waitUntil(
  spec: NetworkSpec,
  what: string,
  deadline: number,
  done: () => Promise<boolean>,
): Promise<void> {
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`[${spec.name}] timed out waiting for ${what}`);
    }
    try {
      if (await done()) return;
    } catch (err) {
      console.log(`[${spec.name}] waiting... (${(err as Error).message})`);
    }
    await sleep(2000);
  }
}

// Every service of `target` must trust exactly the validators in `target`
// (and, if `proposing` names some, those must report server_state proposing).
async function waitTrusted(
  target: NetworkSpec,
  dir: string,
  deadline: number,
  proposing: string[] = [],
): Promise<void> {
  const want: string[] = [];
  for (let i = 1; i <= target.validators; i++) {
    want.push(
      (await readJson(join(dir, 'keys', `${nodeName(target, i)}.json`)))
        .nodePublic,
    );
  }
  want.sort();
  await waitUntil(
    target,
    'the validator list to propagate',
    deadline,
    async () => {
      let ok = true;
      const report: string[] = [];
      for (let i = 0; i <= target.validators; i++) {
        const service = nodeName(target, i);
        const trusted = parseValidatorsOutput(
          xahaudExec(target, service, 'validators'),
        ).trusted.sort();
        const state = proposing.includes(service)
          ? parseServerInfoOutput(xahaudExec(target, service, 'server_info'))
              .server_state
          : undefined;
        const match = JSON.stringify(trusted) === JSON.stringify(want);
        if (!match || (state !== undefined && state !== 'proposing')) {
          ok = false;
        }
        report.push(
          `${service}=${match ? 'ok' : `${trusted.length}/${want.length}`}${state ? ` ${state}` : ''}`,
        );
      }
      console.log(`[${target.name}] ${report.join(' ')}`);
      return ok;
    },
  );
}

// Replaces validators of a running testnet without stopping consensus: start
// the new ones, publish old+new as an interim validator list, wait until the
// new ones are trusted and proposing, publish the final list, wait until every
// remaining node trusts exactly it, then delete the removed ones. Returns the
// final spec (also written to network.json).
export async function rotateValidators(
  spec: NetworkSpec,
  opts: RotateOpts,
  timeoutMs: number,
): Promise<NetworkSpec> {
  const { interim, final, added, removed } = planRotation(spec, opts);
  const dir = join('workspace', spec.name);
  const log = (msg: string) => console.log(`[${spec.name}] ${msg}`);
  log(`rotating: +${added.join(',') || '-'} -${removed.join(',') || '-'}`);
  const deadline = Date.now() + timeoutMs;

  const publisher: PublisherKeys = await readJson(join(dir, 'keys', 'vl.json'));
  const vlPath = join(dir, 'vl', 'vl.json');
  const { blob } = await readJson(vlPath);
  const seq: number = JSON.parse(
    Buffer.from(blob, 'base64').toString(),
  ).sequence;
  const publish = async (target: NetworkSpec, sequence: number) =>
    writeFile(
      vlPath,
      JSON.stringify(
        signVl(publisher, await vlEntries(dir, target), { sequence }),
        null,
        2,
      ),
    );

  // New validators run the network's current binary.
  const nodeBin = join(dir, 'bin', nodeName(spec, 0), 'xahaud');
  for (const name of added) {
    const index =
      interim.validatorIds?.findIndex((id) => `v${id}` === name) ?? -1;
    await writeFile(
      join(dir, 'keys', `${name}.json`),
      JSON.stringify(createValidatorKeys(), null, 2),
      { mode: 0o600 },
    );
    await mkdir(join(dir, 'nodes', name), { recursive: true });
    await copyFile(
      join(dir, 'nodes', nodeName(spec, 0), 'genesis.json'),
      join(dir, 'nodes', name, 'genesis.json'),
    );
    const binPath = join(dir, 'bin', name, 'xahaud');
    await mkdir(join(dir, 'bin', name), { recursive: true });
    try {
      await link(nodeBin, binPath);
    } catch {
      await copyFile(nodeBin, binPath);
      await chmod(binPath, 0o755);
    }
    await writeNodeConfig(interim, dir, index + 1);
  }

  // Before the new containers start, so they fetch it at boot.
  await publish(interim, seq + 1);
  log(`published interim validator list (sequence ${seq + 1})`);
  await writeFile(join(dir, 'compose.yml'), renderCompose(interim));
  if (added.length > 0) compose(spec.name, ['up', '-d', '--no-deps', ...added]);
  // From here on disk matches what runs, so a failed rotation can still be
  // cleaned up (`xng remove`) or undone (`xng rotate --remove <added>`).
  await writeFile(join(dir, 'network.json'), JSON.stringify(interim, null, 2));
  await waitTrusted(interim, dir, deadline, added);
  log('new validators are trusted and proposing');

  if (final.quorum !== spec.quorum) {
    // node, the relay and the kept validators still run the old absolute
    // --quorum; roll them onto the new one while every old and new validator
    // is validating.
    const kept = Array.from({ length: interim.validators }, (_, i) =>
      nodeName(interim, i + 1),
    ).filter((n) => !added.includes(n) && !removed.includes(n));
    const services = [
      nodeName(interim, 0),
      ...(interim.relayConfig ? [RELAY] : []),
      ...kept,
    ];
    log(
      `quorum ${spec.quorum} -> ${final.quorum}: recreating ${services.join(', ')}`,
    );
    await upgradeNetwork(
      interim,
      spec.version,
      Math.max(deadline - Date.now(), 1000),
      { services },
    );
  }

  await publish(final, seq + 2);
  log(`published final validator list (sequence ${seq + 2})`);
  await waitTrusted(final, dir, deadline);
  const seqBefore =
    (await rpc(endpoints(final).rpc, 'server_info', { api_version: 1 })).info
      .validated_ledger?.seq ?? 0;

  if (removed.length > 0) {
    // compose.yml still lists them here.
    compose(spec.name, ['stop', ...removed]);
    compose(spec.name, ['rm', '-f', ...removed]);
    for (const r of removed) {
      await rm(join(dir, 'nodes', r), { recursive: true, force: true });
      await rm(join(dir, 'bin', r), { recursive: true, force: true });
      await rm(join(dir, 'keys', `${r}.json`), { force: true });
    }
    log(`removed ${removed.join(', ')}`);
  }

  await writeFile(join(dir, 'compose.yml'), renderCompose(final));
  // The running processes keep the old [ips_fixed]/quorum until their next
  // restart (e.g. `xng upgrade`).
  for (let i = 0; i <= final.validators; i++)
    await writeNodeConfig(final, dir, i);
  if (final.relayConfig) await writeNodeConfig(final, dir, RELAY);
  await writeFile(join(dir, 'network.json'), JSON.stringify(final, null, 2));
  log(
    'rewrote xahaud.cfg of every node; they apply it on their next restart (xng upgrade)',
  );

  await waitUntil(
    final,
    'node to see consensus continue with the new set',
    deadline,
    async () => {
      const info = (
        await rpc(endpoints(final).rpc, 'server_info', { api_version: 1 })
      ).info;
      const seq2: number = info.validated_ledger?.seq ?? 0;
      log(
        `node: server_state=${info.server_state} peers=${info.peers} seq=${seq2}`,
      );
      return (
        info.server_state === 'full' &&
        info.peers >= final.validators &&
        seq2 > seqBefore
      );
    },
  );
  return final;
}
