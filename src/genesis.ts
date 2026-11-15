import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeAccountID } from 'xahau-address-codec';

const GENESIS_PATH = fileURLToPath(
  new URL('../assets/genesis.xahau.json', import.meta.url),
);
const GENESIS_ACCOUNT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

// Ledger index of an AccountRoot: sha512Half(0x0061 || accountID).
export function accountRootIndex(address: string): string {
  return createHash('sha512')
    .update(
      Buffer.concat([Buffer.from([0x00, 0x61]), decodeAccountID(address)]),
    )
    .digest('hex')
    .slice(0, 64)
    .toUpperCase();
}

// `accounts` are funded out of the genesis account's balance, so total_coins
// stays true.
export function buildGenesis(
  hashes: string[],
  accounts: { address: string; drops: string }[] = [],
  // biome-ignore lint/suspicious/noExplicitAny: genesis ledger dump has no fixed schema here
): any {
  const template = JSON.parse(readFileSync(GENESIS_PATH, 'utf8'));
  const state = template.ledger.accountState;
  const isAmendments = (e: { LedgerEntryType: string }) =>
    e.LedgerEntryType === 'Amendments';
  const entry = state.find(isAmendments);
  if (!entry) throw new Error('genesis template has no Amendments entry');
  entry.Amendments = hashes;
  const root = state.find(
    (e: { Account?: string; LedgerEntryType: string }) =>
      e.LedgerEntryType === 'AccountRoot' && e.Account === GENESIS_ACCOUNT,
  );
  if (!root) throw new Error('genesis template has no genesis account');
  for (const { address, drops } of accounts) {
    root.Balance = String(BigInt(root.Balance) - BigInt(drops));
    state.push({
      Account: address,
      Balance: drops,
      Flags: 0,
      LedgerEntryType: 'AccountRoot',
      OwnerCount: 0,
      PreviousTxnID: '0'.repeat(64),
      PreviousTxnLgrSeq: 0,
      Sequence: 1,
      index: accountRootIndex(address),
    });
  }
  return template;
}
