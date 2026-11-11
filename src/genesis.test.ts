import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountRootIndex, buildGenesis } from './genesis.ts';

const GENESIS = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

test('accountRootIndex matches the genesis account index in the template', () => {
  assert.equal(
    accountRootIndex(GENESIS),
    '2B6AC232AA4C4BE41BF49D2459FA4A0347E1B543A4C92FCEE0821C0201E2E9A8',
  );
});

test('buildGenesis: funds extra accounts out of the genesis balance', () => {
  const plain = buildGenesis([]);
  const other = 'rrrrrrrrrrrrrrrrrrrrBZbvji';
  const g = buildGenesis([], [{ address: other, drops: '100000000' }]);
  // biome-ignore lint/suspicious/noExplicitAny: genesis ledger dump has no fixed schema here
  const roots = (x: any) =>
    x.ledger.accountState.filter(
      (e: { LedgerEntryType: string }) => e.LedgerEntryType === 'AccountRoot',
    );
  assert.equal(roots(plain).length + 1, roots(g).length);
  const added = roots(g).find((e: { Account: string }) => e.Account === other);
  assert.equal(added.Balance, '100000000');
  assert.equal(added.index, accountRootIndex(other));
  const sum = (x: { Balance: string }[]) =>
    x.reduce((n, e) => n + BigInt(e.Balance), 0n);
  assert.equal(sum(roots(g)), sum(roots(plain)));
  assert.equal(
    BigInt(plain.ledger.accountState[0].Balance) -
      BigInt(g.ledger.accountState[0].Balance),
    100000000n,
  );
});
