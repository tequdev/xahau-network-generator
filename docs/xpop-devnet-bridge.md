# Proposal: XPOP (Burn2Mint) between xng devnets

Status: design proposal, nothing implemented yet. Everything stated about
xahaud below was read from the `dev` branch of Xahau/xahaud on 2026-10-08
(`src/xrpld/app/tx/detail/Import.cpp`, `include/xrpl/protocol/Import.h`,
`src/xrpld/app/tx/detail/Transactor.cpp`, `src/xrpld/core/detail/Config.cpp`,
`include/xrpl/protocol/detail/features.macro`) and from the official
collector, Xahau/Validation-Ledger-Tx-Store-to-xPOP (npm `xpopgen`).

## 1. What XPOP is

XPOP ("proof of payment") is a self-contained JSON document that proves a
transaction was included in a validated ledger of some *source* network:

```
{
  "ledger":      { index, coins, phash, txroot, acroot, pclose, close, cres, flags },
  "transaction": { blob, meta, proof },          // signed tx, its metadata, SHAMap proof to txroot
  "validation":  { data: { <nodepub>: <hex STValidation>, ... },
                   unl:  { public_key, manifest, blob, signature, version } }   // the source VL as published
}
```

The hex of that JSON text is the `Blob` of a Xahau `Import` transaction.
The *destination* xahaud verifies, with no network access and no trust in
the submitter:

1. the VL (`validation.unl`) is signed by a publisher it recognises,
2. at least `floor(0.8 * validators-in-VL)` (minimum 1) of those validators
   signed a validation for the ledger hash recomputed from `ledger` + the
   proof, with the signing keys listed in the VL,
3. the inner tx is in that ledger (proof), was signed by the same key as the
   `Import` itself, and carries `OperationLimit == this node's network_id`.

Effects on success ("Burn2Mint"): the account is created if missing
(starting balance `ReserveBase + 5 * ReserveIncrement`, 2 XAH with xng's
reserves), the inner tx's `Fee` is minted 1:1 for the first 2M ledgers
(unless the `ZeroB2M` amendment is enabled, then 0), and a `SetRegularKey` /
`SignerListSet` inner tx is replayed on the destination account (key sync).
Replay protection: `ImportSequence` on the AccountRoot must grow strictly,
and `ImportVLSequence` per publisher key must not go backwards.

Production use: XRPL mainnet/testnet -> Xahau mainnet/testnet. The source is
always a network whose txs carry **no** `NetworkID` field.

## 2. Can two Xahau devnets do this? Yes, with two hard constraints

### 2.1 The source devnet must have `networkId <= 1024`

`Import::preflight` rejects any inner tx that has an `sfNetworkID` field
(Import.cpp: "ensure inner txn is for networkid = 0 (network id must
therefore be missing)" -> `temMALFORMED`). At the same time
`Transactor::preflight0` makes every xahaud with `network_id > 1024` reject
txs *without* `NetworkID` (`telREQUIRES_NETWORK_ID`). So a burn made on a
network with id 21339 (xng's default) can never be imported anywhere, equal
ids or not. A burn made on a network with id <= 1024 can.

Consequence: a devnet that acts as a B2M **source** must be created with
`--network-id <= 1024` (e.g. 1 or 2, like XRPL testnet/devnet). Clients are
unaffected: xahau.js/xrpl.js autofill only adds `NetworkID` when
`server_info.network_id > 1024`. The **destination** can keep 21339.

### 2.2 `ZeroB2M` is enabled in every xng genesis today

xng enables every `Supported::yes` amendment at genesis
(`src/amendments.ts`), and `ZeroB2M` is `Supported::yes, DefaultNo` in
features.macro. With it enabled `Import` mints 0 drops: the account is
created with the 2 XAH bonus and keys are synced, but the burned amount is
not credited. An amendment enabled at genesis cannot be turned off later,
so a destination that should mint value must exclude `ZeroB2M` at create.

Everything else already matches what `Import` needs:

| requirement | xng today |
| --- | --- |
| VL in version-1 format, served over HTTP, signed by an ed25519 publisher | `vl/vl.json` served at `vl.<name>.<domain>` (`src/keys.ts signVl`) |
| validator signing keys must be secp256k1 (`STValidation` ctor) | `createValidatorKeys` uses secp256k1 signing keys |
| destination lists the publisher master key in `[import_vl_keys]` (read from the validators file) | `renderValidatorsTxt` writes that section; the key list is `spec.importVlKeys` (today a fixed default, `ED74D4...`, which is the key of Transia's xpop-toolkit burn chain and matches nothing xng creates) |
| `OperationLimit` on the burn = destination id; the source ignores the field (no transactor reads it) | any value is accepted on the source |
| the collector needs the `validations` stream and `ledger` RPC (binary + expanded) for recent ledgers | `node` keeps 10 000 ledgers |
| at least 2 validators in the source VL for the upstream collector (it ignores a 1-entry UNL) | default is 3; xahaud itself accepts 1 |

## 3. Proposed design

Two new spec keys plus one service; all testnet-only except where noted.

### 3.1 `xpop: true` - "this network can be a B2M source"

- Validation: `networkId <= 1024`, testnet only.
- Adds an `xpop` collector service to compose.yml, on the `proxy` network,
  routed at `xpop.<name>.<domain>` (name `xpop` becomes reserved, like
  `vl`). Configuration is derived entirely from the network:
  `NODES=ws://<name>-node:6008`, `UNLURL=http://<name>-vl/vl.json`,
  `UNLKEY=<keys/vl.json master.publicKey>`, `NETWORKID=<networkId>`,
  `URL_PREFIX=<endpoint>`.
- HTTP API kept identical to the upstream collector so the `xpop` npm
  client and existing tooling work unchanged: `GET /xpop/<txhash>` (hex
  blob, 404 until ready), `GET /health`.
- `endpoints()` gains `xpop`, printed by `create`, shown on the landing
  page and in `networks.json`.

Collector implementation, two options:

- **A. upstream image/repo.** `wietsewind/xpop:latest` on Docker Hub is
  arm64-only and from 2023-12; building the repo's Dockerfile needs node-gyp
  for a native `ed25519` module and a non-default `--dist-url`
  (nodejs-builds.xahau.tech). Also rejects a 1-validator UNL and keeps a
  30-day store with an hourly cleaner.
- **B. (recommended) vendor a small TypeScript service `xpop/`** in the
  style of `faucet/` and `debugstream/`: subscribe to `validations` +
  `ledger`, fetch the closed ledger (`ledger` RPC, binary + expand), keep
  the UNL validations per ledger in memory for a few hundred ledgers,
  build the SHAMap proof (the ~150-line tx-tree hashing from upstream's
  `lib/xpop/v1.mjs`, MIT, originally RichardAH/xpop-generator) and serve
  the hex. No native deps, no disk store, works with 1 validator, and the
  build is the same `node:24-slim` as the faucet. ~300 lines plus unit
  tests for the proof against a fixture from xahaud's `Import_test.cpp`.

### 3.2 `importFrom: [<network name>, ...]` - "accept B2M from these xng networks"

- Testnet or standalone. Each name must be a local testnet with
  `xpop: true`; its publisher key (`workspace/<src>/keys/vl.json`
  `master.publicKey`) goes into `[import_vl_keys]` of every node of the
  destination. `importVlKeys: [<hex>, ...]` stays available for raw keys
  (external sources, XRPL testnet).
- `ZeroB2M` is excluded from the genesis amendments of a network with
  `importFrom`, via a generic new key `disabledAmendments: [ZeroB2M]`
  (`--disable-amendment <name>`, repeatable) that is also useful on its
  own; `importFrom` implies it. The excluded name is reported by `create`.
- Changing either key is a `recreate` in `xng apply` (the config and
  genesis are written at create time, like `nodeConfig`). `apply` creates
  sources before destinations and refuses to remove a source that another
  network still imports from.
- Lifecycle notes: `reset` keeps keys, so a reset source keeps working.
  `remove` + `create` of a source makes a new publisher key, so every
  destination importing from it must be recreated too (apply detects this
  because the stored key differs from the source's current key).
- Because the publisher key is also voted on-ledger by the destination's
  validators (`UNLReport.ImportVLKeys`), the key must be in the
  **validators'** validators.txt, not only `node`'s; xng already writes
  the same section to every node.

### 3.3 `xng b2m` and an end-to-end test

```
xng b2m --from src --to dst --seed <s...> --amount 100 [--wait]
```

1. On `src`: submit `AccountSet { Fee: <amount in drops>, OperationLimit: <dst.networkId> }`
   signed with the seed (no `NetworkID`, since `src` is <= 1024), wait for
   validation.
2. Poll `xpop.src.<domain>/xpop/<hash>` until the blob exists.
3. On `dst`: submit `Import { Account, Blob, Sequence: 0, Fee: "0" }` when
   the account does not exist there yet (the first Import must be signed
   with the master key, or the created account has `lsfDisableMaster`), or
   `Sequence`/`Fee` autofilled otherwise, and wait for validation.
4. Print both hashes and the destination balance.

`pnpm e2e:xpop` creates `src` (`--network-id 1 --xpop`) and `dst`
(`--import-from src`), funds an account on `src` from its faucet, runs the
three steps above and asserts `dst` balance == 2 XAH bonus + burned amount,
then burns again and asserts `ImportSequence` ordering (a second import
with a lower inner sequence is `tefPAST_IMPORT_SEQ`). CI gets a matrix
entry for it (two testnets on one runner fit; validators=1 for both if
option B is chosen, else 3 for the source).

### 3.4 Optional later steps

- Landing page: a "Burn2Mint from <src>" form next to the faucet that
  does the three steps in the browser.
- A `[import_vl_keys]` default of `[]` instead of the current
  `ED74D4...` placeholder (keeps `apply` output unchanged since
  `importVlKeys` is not a compared key).
- Hooks testing: `xpop_slot` lets a hook on the destination read the inner
  tx; a devnet pair makes that testable without XRPL testnet.

## 4. Flow

```
  src devnet (networkId 1, xpop: true)              dst devnet (networkId 21339, importFrom: [src])
  ┌───────────┐  validations+ledger  ┌───────────┐          ┌──────────────────────────────┐
  │ v1 v2 v3  │ ───────────────────► │ xpop svc  │          │ validators.txt:              │
  │   node    │                      │ /xpop/<h> │          │   [import_vl_keys] <src key> │
  └───────────┘                      └───────────┘          │ genesis: ZeroB2M excluded    │
        ▲ 1. AccountSet Fee=X             │                 └──────────────────────────────┘
        │    OperationLimit=21339         │ 2. GET /xpop/<hash>          ▲
        │                                 ▼                              │ 3. Import { Blob }
      user ──────────────────────────────────────────────────────────────┘
```

## 5. Open questions

1. Is minting value the goal, or only account/key sync? If sync is enough,
   `ZeroB2M` can stay enabled and `disabledAmendments` is not needed.
2. Vendor the collector (option B) or depend on the upstream repo (A)?
3. Accept the rule "a B2M source has `networkId <= 1024`"? There is no way
   around it in xahaud; the alternative is a xahaud patch, out of scope.
4. Should `xng create --xpop` without `--network-id` pick 1 automatically,
   or fail and ask for an explicit id? (Proposal: fail, to keep ids
   explicit like `version` in `xng.yml`.)

## 6. Effort estimate

| step | size |
| --- | --- |
| `xpop`, `importFrom`, `disabledAmendments` in types/config/network/apply/cli + tests | 1 day |
| vendored collector service + proof unit test | 1-2 days |
| `xng b2m`, `e2e:xpop`, CI job | 1 day |

## 7. References (verified on 2026-10-08)

- Import.cpp `dev`: inner `sfNetworkID` rejected (preflight), `OperationLimit != NETWORK_ID -> telWRONG_NETWORK`, quorum `totalValidatorCount * 0.8` min 1, `[import_vl_keys]` or on-ledger `UNLReport` lookup (preclaim), `ZeroB2M -> creditDrops = 0`, starting bonus and `lsfDisableMaster` rule (doApply).
- Transactor.cpp `preflight0`: `network_id > 1024` requires `NetworkID`; `<= 1024` forbids it.
- Config.cpp: `[import_vl_keys]` is read from the validators file, one bare hex key per line.
- features.macro: `Import` DefaultYes, `ZeroB2M` Supported::yes DefaultNo.
- Validation-Ledger-Tx-Store-to-xPOP: `.env.sample` (`NODES`, `NETWORKID`, `UNLURL`, `UNLKEY`, `FIELDSREQUIRED`, `URL_PREFIX`), `lib/unlData.mjs` (ignores a UNL with <= 1 validator), `lib/onValidation.mjs` (UNL filter, `server_info.network_id == NETWORKID`), `lib/xpop/v1.mjs` (document shape, proof), Dockerfile (node-gyp, custom dist-url); Docker Hub `wietsewind/xpop:latest` arm64 only, 2023-12-29.
- Transia-RnD/xpop-toolkit: runs the upstream collector against a private burn chain with a custom VL, i.e. the same setup as 3.1.
