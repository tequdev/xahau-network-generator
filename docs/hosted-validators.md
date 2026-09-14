# Hosted validators (1 LXC/VM = 1 validator) — design

Goal: run each testnet validator on its own Proxmox LXC (or VM) while keeping
`xng` and the diff small.

## Shape

- **Validators**: one unprivileged Ubuntu LXC each, xahaud runs natively under
  systemd. No Docker inside the LXC (xahaud is a single static binary; the
  compose service today is just `ubuntu:noble` + bind mounts).
- **Everything else** (`node`, `vl`, `faucet`, `explorer`, Traefik): unchanged,
  on one Docker host (a VM/LXC with `nesting=1`, or a Mac on the same LAN).
  `xng` runs there. Explorer is Docker-only, which decides this.
- **Proxmox is not driven by xng.** Creating the LXCs is a documented
  `pct create` loop; xng only needs `ssh root@<ip>`. This keeps the feature
  usable on any host (VM, bare metal, cloud) and avoids `pct push`/REST glue.

## Spec

```ts
// types.ts
hosts?: Record<string, string>; // testnet only; e.g. { v1: '10.0.0.11', v2: '10.0.0.12' }
```

Set at create time: `xng create --name t1 --validators 3 --hosts v1=10.0.0.11,v2=10.0.0.12,v3=10.0.0.13`.
`start/stop/reset/remove/upgrade` branch on `spec.hosts`; no new `deploy`
command. Static IPs (compose `extra_hosts` can't resolve names, so the spec is
the single source of truth).

## Name resolution (the deciding risk)

Peers stay `<name>-<svc>` hostnames in `[ips_fixed]` (config.ts unchanged).

- node → validator: `extra_hosts: ["t1-v1:10.0.0.11", ...]` on `node` in
  compose.yml; validator services are skipped from compose when hosted.
- validator → node: append `/etc/hosts` lines for every `t1-*` name on each
  LXC (`t1-node` = the Docker host IP), and **publish `node`'s peer port**
  (`51235:51235`; testnet publishes nothing today). Both sides must dial each
  other or a validator restarted by `upgrade` stays unpeered for minutes
  (see network.ts comment) and `upgrade`'s re-peer post-condition times out.

## VL

`http://t1-vl/vl.json` is only reachable on the compose network, so hosted
mode emits a static `[validators]` list in `validators.txt` for **all**
nodes (one branch, not two). `renderValidatorsTxt` gets a
`validators?: string[]` option. The `vl` nginx service is kept as-is.

## Per-validator deploy (ssh)

```
tar c nodes/v1 bin/v1 | ssh root@10.0.0.11 tar x -C /opt/xng/t1
ssh ... 'cat >> /etc/hosts' ; write /etc/systemd/system/xahaud.service ; systemctl restart xahaud
```

`tar` not `rsync` (Ubuntu LXC template lacks rsync). Unit runs as root inside
the unprivileged LXC (already unprivileged on the host); `LimitNOFILE=65536`;
`WorkingDirectory=/opt/xng/t1/nodes/v1`.

## Things in the code that bite

1. **First-boot logic** (`compose.ts` `if [ -d db ] --load else --ledgerfile`)
   must be byte-identical in `ExecStart`. Extract one `xahaudCommand(spec)`
   used by compose and the unit; a drifted copy = validator forks at seq 1.
2. **server_info for validators** (`upgrade.ts`): `docker compose exec` →
   `ssh host 'cd <dir> && xahaud --conf xahaud.cfg server_info'`. Output
   parsing (`parseServerInfoOutput`) and the wait loop are reusable.
3. **Binary swap on upgrade**: scp to `xahaud.tmp`, `mv` over (rename, never
   overwrite in place — ETXTBSY), then `systemctl restart`.
   `--force-recreate` → `restart`.
4. **reset** only wipes local `nodes/*/db`; hosted reset must
   `systemctl stop && rm -rf .../db` on every host, or `node` is at genesis
   while validators keep the old chain.
5. `admin = 0.0.0.0` in xahaud.cfg exposes admin RPC on the LAN. Fine for a
   homelab; document it.

## Proxmox side (README snippet, not code)

```sh
for i in 1 2 3; do
  pct create $((200+i)) local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
    --hostname t1-v$i --unprivileged 1 --cores 2 --memory 4096 --rootfs local-lvm:16 \
    --net0 name=eth0,bridge=vmbr0,ip=10.0.0.1$i/24,gw=10.0.0.1 \
    --ssh-public-keys ~/.ssh/id_ed25519.pub --start 1
done
```

Unprivileged LXC is fine for xahaud: NuDB is plain file I/O, lxcfs
virtualizes `/proc/meminfo` so `node_size medium` sizing works. 4 GB / 2
cores each for a fresh testnet.

## Not doing (yet)

- `xng pve create` wrapper, Terraform/OpenTofu, Ansible: add when the
  `pct` loop is typed more than twice.
- Docker-in-LXC per validator: needs nesting and buys nothing over systemd.
- `node` itself on a separate host: would need the faucet/explorer to reach it
  over the LAN; keep it on the Docker host until there's a reason.
