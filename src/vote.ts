import { composeOutput } from './docker.ts';
import { nodeName } from './types.ts';
import type { NetworkSpec } from './types.ts';

// Fields beyond name/enabled/supported (vetoed, count, threshold, ...) only
// appear while an amendment is still unenabled, so they're left loose.
export type FeatureStatus = {
  hash: string;
  name?: string;
  enabled?: boolean;
  [key: string]: unknown;
};

// `xahaud --conf xahaud.cfg feature <x> accept|reject` prints
// {"result":{"<hash>":{name,enabled,vetoed,count,threshold,...},"status":"success"}}
// or {"result":{"error":..., "error_message":..., "status":"error"}}.
export function parseFeatureOutput(stdout: string): FeatureStatus {
  let parsed: {
    result?: Record<string, unknown> & { error_message?: string };
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not parse feature output as JSON: ${stdout}`);
  }
  const result = parsed.result;
  if (!result) throw new Error(`unexpected feature output: ${stdout}`);
  if (result.error_message) throw new Error(String(result.error_message));
  const entry = Object.entries(result).find(([k]) => k !== 'status');
  if (!entry) throw new Error(`unexpected feature output: ${stdout}`);
  return { hash: entry[0], ...(entry[1] as Omit<FeatureStatus, 'hash'>) };
}

// Validators publish no ports, so each is told to vote by running the xahaud
// client inside its own container (cwd /node via compose's working_dir).
export function voteAmendment(
  spec: NetworkSpec,
  amendment: string,
  vote: 'accept' | 'reject',
): void {
  for (let i = 1; i <= spec.validators; i++) {
    const service = nodeName(spec, i);
    const stdout = composeOutput(spec.name, [
      'exec',
      '-T',
      service,
      'xahaud',
      '--conf',
      'xahaud.cfg',
      'feature',
      amendment,
      vote,
    ]);
    const { hash, name, ...rest } = parseFeatureOutput(stdout);
    console.log(`${service}: ${name ?? hash} ${JSON.stringify(rest)}`);
  }
}
