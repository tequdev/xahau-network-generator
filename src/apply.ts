import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderCompose } from './compose.ts';
import { compose, enableAcme, ensureProxy } from './docker.ts';
import { createNetwork } from './network.ts';
import { diffSpec, specFor } from './state.ts';
import type { State } from './state.ts';
import type { NetworkSpec } from './types.ts';
import { upgradeNetwork } from './upgrade.ts';
import { waitForNetwork } from './wait.ts';

// One network's reconciliation, in execution order. `refuse` carries the
// reason and means nothing at all is done for that network.
export type Plan = {
  name: string;
  desired?: NetworkSpec;
  actual?: NetworkSpec;
  actions: (
    | 'create'
    | 'reroute'
    | 'up'
    | 'upgrade'
    | 'down'
    | 'remove'
    | 'refuse'
  )[];
  reason?: string;
};

async function actualSpecs(
  workspace: string,
): Promise<Map<string, NetworkSpec>> {
  const specs = new Map<string, NetworkSpec>();
  for (const name of await readdir(workspace).catch(() => [] as string[])) {
    try {
      specs.set(
        name,
        JSON.parse(
          await readFile(join(workspace, name, 'network.json'), 'utf8'),
        ),
      );
    } catch {}
  }
  return specs;
}

// Pure given the workspace: what applyState would do, network by network.
// Never plans a reset: a network is either converged in place (rolling
// upgrade, compose re-render, up/down) or, if a create-time field changed,
// refused - dropping and recreating it is the operator's explicit call
// (delete it from xng.toml, apply, add it back).
export async function planState(
  state: State,
  workspace = 'workspace',
  only?: string,
): Promise<Plan[]> {
  const actual = await actualSpecs(workspace);
  const declared = state.networks ?? {};
  const names = new Set([...Object.keys(declared), ...actual.keys()]);
  const plans: Plan[] = [];
  for (const name of [...names].sort()) {
    if (only && name !== only) continue;
    const decl = declared[name];
    const have = actual.get(name);
    if (!decl) {
      plans.push({ name, actual: have, actions: ['remove'] });
      continue;
    }
    const desired = specFor(name, decl, state);
    const enabled = decl.enabled ?? true;
    const plan: Plan = { name, desired, actual: have, actions: [] };
    if (!have) {
      plan.actions.push('create');
      if (enabled) plan.actions.push('up');
    } else {
      const diff = diffSpec(desired, have);
      if (diff.incompatible.length > 0) {
        plan.actions.push('refuse');
        plan.reason = `${diff.incompatible.join(', ')} changed; these are fixed at create time - remove the network from xng.toml, apply, then add it back`;
      } else {
        if (diff.routing) plan.actions.push('reroute');
        if (enabled) {
          plan.actions.push('up');
          if (diff.version) plan.actions.push('upgrade');
        } else if (diff.version) {
          plan.actions.push('refuse');
          plan.reason =
            'version changed on a disabled network; enable it first (a rolling upgrade needs it running)';
        } else {
          plan.actions.push('down');
        }
      }
    }
    plans.push(plan);
  }
  return plans;
}

export function describePlan(plans: Plan[]): string {
  return plans
    .map((p) => {
      const what = p.actions.join(' + ');
      const ver =
        p.desired && p.actual && p.desired.version !== p.actual.version
          ? ` (${p.actual.version} -> ${p.desired.version})`
          : '';
      return `${p.name}: ${what}${ver}${p.reason ? ` - ${p.reason}` : ''}`;
    })
    .join('\n');
}

// Always against ./workspace: compose()/upgradeNetwork() hardcode it too.
export async function applyState(
  state: State,
  opts: { only?: string; timeoutMs?: number } = {},
): Promise<void> {
  const workspace = 'workspace';
  const timeoutMs = opts.timeoutMs ?? 600_000;
  if (state.acme_email) enableAcme(state.acme_email);
  const plans = await planState(state, workspace, opts.only);
  const failures: string[] = [];
  for (const plan of plans) {
    const spec = plan.desired;
    const dir = join(workspace, plan.name);
    console.log(`[apply] ${describePlan([plan])}`);
    try {
      for (const action of plan.actions) {
        switch (action) {
          case 'refuse':
            throw new Error(plan.reason);
          case 'create':
            if (!spec) throw new Error('no spec');
            await createNetwork(spec, workspace);
            break;
          case 'reroute':
            // Hostnames/URLs live only in network.json and compose.yml; the
            // following `up` recreates the containers with the new labels
            // over the same bind-mounted ledger data.
            if (!spec) throw new Error('no spec');
            // Keep the *running* version here: upgradeNetwork persists the
            // new one only once the rolling upgrade actually succeeded, so
            // an interrupted upgrade is retried by the next apply.
            await writeFile(
              join(dir, 'network.json'),
              JSON.stringify(
                { ...spec, version: plan.actual?.version ?? spec.version },
                null,
                2,
              ),
            );
            await writeFile(join(dir, 'compose.yml'), renderCompose(spec));
            break;
          case 'up':
            if (!spec) throw new Error('no spec');
            if (spec.type === 'testnet') ensureProxy();
            compose(plan.name, ['up', '-d', '--build']);
            break;
          case 'upgrade': {
            if (!spec) throw new Error('no spec');
            // Rolling upgrade needs `node` synced, which `up` does not wait for.
            await waitForNetwork(spec, timeoutMs);
            await upgradeNetwork(spec, spec.version, timeoutMs);
            break;
          }
          case 'down':
            compose(plan.name, ['down']);
            break;
          case 'remove':
            try {
              compose(plan.name, ['down', '-v']);
            } catch (err) {
              // A half-created network has no compose.yml; still remove it.
              console.warn(err instanceof Error ? err.message : err);
            }
            await rm(dir, { recursive: true, force: true });
            break;
        }
      }
    } catch (err) {
      failures.push(`${plan.name}: ${(err as Error).message}`);
      console.error(`[apply] ${plan.name}: ${(err as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`apply finished with failures:\n${failures.join('\n')}`);
  }
}
