import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GENESIS_PATH = fileURLToPath(
  new URL('../assets/genesis.xahau.json', import.meta.url),
);

// biome-ignore lint/suspicious/noExplicitAny: genesis ledger dump has no fixed schema here
export function buildGenesis(hashes: string[]): any {
  const template = JSON.parse(readFileSync(GENESIS_PATH, 'utf8'));
  const isAmendments = (e: { LedgerEntryType: string }) =>
    e.LedgerEntryType === 'Amendments';
  const entry = template.ledger.accountState.find(isAmendments);
  if (!entry) throw new Error('genesis template has no Amendments entry');
  entry.Amendments = hashes;
  return template;
}
