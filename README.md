# xahau-network-generator

CLI that generates and runs disposable Xahau `testnet` (N validators) or
`standalone` networks for a given `xahaud` release, via Docker Compose.

## Usage

```sh
pnpm install

# create a network (downloads/caches the xahaud binary, derives amendments,
# generates keys/genesis/config into workspace/<name>/)
pnpm xng create --name t1 --type testnet --validators 3
pnpm xng create --name s1 --type standalone

# start it (docker compose up -d), optionally waiting for readiness
pnpm xng start --name t1 --wait

# stop / reset (wipe ledger data, restart from genesis) / remove
pnpm xng stop --name t1
pnpm xng reset --name t1 --wait
pnpm xng remove --name t1

# rolling upgrade of the xahaud binary on a running testnet, no downtime
pnpm xng upgrade --name t1 --version 2026.9.9-dev+3667
```

`reset` = stop, wipe ledger data, start again from genesis.

`upgrade` (testnet only) replaces the xahaud binary one node at a time —
`node` first, then each validator in order — waiting for each to rejoin
consensus on the new version before moving to the next, so the network is
never fully stopped. The default quorum is capped at `validators - 1` (see
below), so one validator can be mid-restart and consensus still keeps going;
pass `--quorum` yourself to raise it if you want stricter safety instead.

`--version` defaults to the latest release on build.xahau.tech. Binaries and
parsed amendment sources are cached under `~/.cache/xahau-network-generator`.
The testnet faucet's own key is generated per-network at `workspace/<name>/keys/faucet.json`.

### Networking

**testnet** networks publish nothing on a host port (not even the peer port —
xahaud's peer TLS sends no SNI, so it can't be proxied). Instead, `xng start`
and `xng reset` bring up a single shared Traefik instance (`xng proxy up` /
`xng proxy down` to manage it directly) that every testnet joins via the
external `proxy` Docker network, and routes each service by subdomain, e.g.
for a network named `t1`:

```
http://explorer.t1.127.0.0.1.nip.io
http://rpc.t1.127.0.0.1.nip.io
ws://t1.127.0.0.1.nip.io
http://faucet.t1.127.0.0.1.nip.io
```

The default domain, `127.0.0.1.nip.io`, resolves any subdomain to
`127.0.0.1` so this works out of the box on plain HTTP. To expose a testnet
on a real host, pass `--domain your.domain --tls`, point wildcard DNS
(`*.your.domain`) at the machine, and uncomment the ACME lines in
`traefik/compose.yml`.

Container-to-container references (xahaud's peer list, the validator list
URL, the faucet's websocket URL) use container names (`<name>-<service>`,
e.g. `t1-node`) rather than bare service names (`node`) — since every
testnet's services join the same shared `proxy` network, a bare service name
would be ambiguous between testnets running side by side.

**standalone** networks are unaffected by Traefik: they publish their ports
directly on `localhost` exactly as before (rpc admin 5005, rpc public 5007,
ws admin 6006, ws public 6008, peer 51235, explorer 4000). `--port-offset N`
shifts every one of those ports so several standalone networks can run side
by side.

## Development

```sh
pnpm lint     # biome check
pnpm format   # biome format --write
pnpm test     # node:test over src/**/*.test.ts
pnpm e2e      # end-to-end check against a running network
```
