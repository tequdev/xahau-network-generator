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

# make every validator vote for (or, with --reject, veto) an amendment
pnpm xng vote --name t1 --amendment fixSomething

# or declare the whole set of networks in xng.toml and converge to it
pnpm xng apply --dry-run
pnpm xng apply
```

`reset` = stop, wipe ledger data, start again from genesis.

`upgrade` (testnet only) replaces the xahaud binary one node at a time —
`node` first, then each validator in order — waiting for each to rejoin
consensus on the new version before moving to the next, so the network is
never fully stopped. The default quorum is capped at `validators - 1` (see
below), so one validator can be mid-restart and consensus still keeps going;
pass `--quorum` yourself to raise it if you want stricter safety instead.

`vote` (testnet only) runs `feature <amendment> accept|reject` on each
validator. Every generated node sets `[amendment_majority_time]` to
1 minute (xahaud's floor), so an amendment with a majority is enabled at the
next flag ledger (every 256 ledgers) at least a minute later.

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
`127.0.0.1` so this works out of the box on plain HTTP.

### Serving several devnets on a real domain

One machine can serve any number of testnets under one domain, one per
feature branch, e.g. with `--domain xahau-dev.net`:

```
xng create --name jshooks --version 2026.9.8-jshooks+3640 --domain xahau-dev.net --tls
  -> wss://jshooks.xahau-dev.net, https://explorer.jshooks.xahau-dev.net, https://faucet.jshooks.xahau-dev.net
xng create --name dev --root --version 2026.9.9-dev+3667 --domain xahau-dev.net --tls
  -> wss://xahau-dev.net, https://explorer.xahau-dev.net, https://faucet.xahau-dev.net
```

`--root` puts a network on the bare domain instead of `<name>.<domain>`;
only one root network per domain is allowed, and the names `explorer`,
`rpc`, `faucet`, `vl` are reserved so they can't shadow its subdomains.

Setup on the host:

1. DNS: `A` records for `<domain>` and `*.<domain>` pointing at the machine.
   A DNS wildcard matches nested labels too, so
   `explorer.jshooks.<domain>` resolves. Keep these records DNS-only if the
   domain is on Cloudflare: proxying a nested subdomain needs Cloudflare's
   Advanced Certificate Manager.
2. TLS: `pnpm xng proxy up --acme-email you@example.com` records the email
   in `traefik/acme.env` (gitignored) and from then on every `xng start`
   applies `traefik/compose.acme.yml`, so Traefik issues a Let's Encrypt
   certificate per hostname (HTTP-01 on port 80). Create networks with
   `--tls` so their advertised URLs are `https`/`wss`.

### Declarative: `xng.toml` + `xng apply`

The set of networks a machine should run can be declared in one file and
converged with `xng apply`, so moving the same layout to another host is
copying `xng.toml` (commit it wherever you keep your infra) and applying:

```toml
domain = "xahau-dev.net"
tls = true
acme_email = "you@example.com"   # optional; same as `xng proxy up --acme-email`

[networks.jshooks]
version = "2026.9.8-jshooks+3640"
validators = 3                    # optional: quorum, network_id, type, port_offset

[networks.dev]
version = "2026.9.9-dev+3667"
root = true

[networks.parked]
version = "2026.6.21-release+3350"
enabled = false                   # keep it and its ledger, but `compose down`
```

```sh
pnpm xng apply --dry-run     # print the plan
pnpm xng apply               # converge; --only <name> limits it to one network
```

For each declared network, apply does the least that makes reality match:
create it if missing, `compose up` it (a no-op when already running),
`compose down` it when `enabled = false`, run a rolling `xng upgrade` when
`version` changed, re-render compose.yml when `domain`/`tls`/`root` changed
(hostnames only, ledger untouched), and remove networks that are no longer
declared. **Apply never resets a network.** A change to something baked in
at create time (`validators`, `quorum`, `network_id`, `type`,
`port_offset`, or `version` on a standalone network) is refused with a
message, and nothing is done to that network until you either revert the
field or explicitly drop and re-add it (delete the section, apply, add it
back). `xng reset` stays a separate, deliberate command. Unknown keys are
errors rather than silently ignored, and `apply` refuses to run when the
file does not exist (an empty declaration would mean "remove everything").

Panel actions rewrite `xng.toml` through the TOML serializer, so comments
in a hand-edited file don't survive the next click; the page's raw editor
writes your text verbatim.

### Web control panel

`pnpm xng panel` serves a small page (`src/panel.html`) that lists every
network with its state, validated ledger index, uptime and peers, and can
create, start/stop/reset, remove, upgrade and vote for amendments. Every
change in the page is an edit to `xng.toml` followed by `xng apply --only
<name>` (the page also has a raw editor for the file with a plan preview),
so the file always reflects what is deployed. Only Reset and Vote are direct
commands. Jobs run one at a time with their log shown in the page.

```sh
XNG_ACCESS_TEAM=<team> XNG_ACCESS_AUD=<application audience tag> \
pnpm xng panel            # listens on 127.0.0.1:7777, edits ./xng.toml
```

Access control is Cloudflare Access: put the panel behind a
[cloudflared tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(`ingress: hostname: xng.<domain>, service: http://localhost:7777`) with an
Access application on that hostname, and pass the team name and the
application's audience (AUD) tag. The panel verifies the
`Cf-Access-Jwt-Assertion` token Cloudflare adds to every request, so it is
unusable without a valid login even if something else reaches the port. It
refuses to start without both values unless given `--insecure-no-auth`,
which serves loopback clients only (local development).

Run it as a service from the repo root, e.g. a systemd unit with
`WorkingDirectory=/path/to/xahau-network-generator`,
`ExecStart=/usr/bin/pnpm xng panel` and the environment above.

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
