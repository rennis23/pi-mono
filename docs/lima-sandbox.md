# Design: pi-coding-agent sandbox on lima

The pi-agent sandbox (`sandbox/`) runs
[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) with full
autonomy inside a hardware-isolated Linux VM on macOS using
[lima](https://github.com/lima-vm/lima) (installed via Homebrew). This document
supersedes `docs/smolvm-sandbox.md`; the migration spec is
[`docs/specs/2026-08-02-lima-sandbox-design.md`](specs/2026-08-02-lima-sandbox-design.md).

## Why lima (delta vs smolvm)

smolvm ran the agent in ephemeral microVMs (libkrun) with default-deny,
DNS-filtered egress (`--allow-host`). lima has no egress filtering, so the
migration traded that control away (**option D**: accept full network now) in
exchange for a maintained tool with native macOS `vz` support, declarative
instance YAML, first-boot provisioning (no local image build), and a persistent
named instance with fast restarts. Egress filtering returns via "option C"
(filtering resolver + in-guest nftables) — tracked in `TODO.md`; the `offline`
preset (block-all) works today.

## Threat model

- Agent runs `bash`, edits files, installs packages — must not touch host files
  outside the mounted workspace. Still **hardware-isolated**: `vmType: vz`
  (Virtualization.framework), own kernel, not a container.
- **Filesystem:** only `/workspace` (rw), curated `sandbox/skills` /
  `sandbox/extensions` / `sandbox/pi-global` (ro), and explicit ad-hoc mounts are
  visible. The host home directory is *not* mounted — see "Base template" below.
- **Network:** open egress (accepted regression, option D). The `offline`
  preset applies in-guest nftables block-all (loopback and host-initiated SSH
  exempt, so `limactl shell` keeps working); filtering per `allowlists/*.txt`
  returns with option C.
- **Secrets:** live only in the session environment. `limactl shell
  --preserve-env` forwards host env; lima's default blocklist does not cover
  `*_API_KEY` / `AWS_*` / `GH_TOKEN`, so keys flow without being written to the
  image, the instance YAML, or the repo. Nothing secret is provisioned into the
  disk.
- **Git:** `ssh.forwardAgent: true` forwards the host SSH agent; private keys
  never enter the VM. (`SSH_AUTH_SOCK` itself is blocklisted from env
  passthrough — agent forwarding covers it.)
- **Guest user has no sudo** — parity with smolvm's unprivileged agent user, and
  a prerequisite for the option-C egress rules to hold. See "sudo" below.
- **Persistent by default:** one named instance (`pi-agent`); hygiene is
  on-demand via `--fresh` (stop/delete/recreate) instead of per-session
  teardown.

## Components

- `sandbox/agent.lima.yaml` — instance config: `vmType: vz`, 2 CPU / 2 GiB / 10
  GiB, Alpine 3.23 cloud image, `ssh.forwardAgent`, the `OFFLINE` param, and
  three provision scripts (see below). `mounts: []` — injected at create time by
  `launch.sh` via `limactl create --set '.mounts = [...]'`.
- `sandbox/scripts/launch.sh` — create/start/shell orchestration, mount
  assembly, offline reconciliation, existing-instance guards.
- `sandbox/scripts/doctor.sh` — host preflight checks.

### Provisioning (replaces the old Dockerfile)

- `mode: system` (root, once at create): `apk add` the toolset (bash, git,
  github-cli, ripgrep, …, nodejs ≥ 22 verified, npm, nftables),
  `npm install -g @earendil-works/pi-coding-agent`, reclaim the pi home from
  root-owned mount parents, drop the sudo grant.
- `mode: user` (default user, once): symlink the `/opt` mounts into
  `~/.pi/agent`, pre-cache `packages[]` from `settings.json` (`pi install`).
- `mode: boot` (root, every boot): when the `OFFLINE` param renders `true`,
  apply an idempotent nftables table (`pi_offline`) dropping all output except
  loopback and established/related flows.

## Implementation notes (deviations from the spec, and why)

These were discovered while building against lima v2.2.0; the spec's script
bodies were explicitly "finalized at implementation time".

- **Base template is `template:_images/alpine-3.23`, not
  `template://alpine-3.23`.** Lima *combines* base-template slices with the
  instance's — `mounts` cannot be overridden or emptied from the instance side
  (verified: `mounts: []` still resolved to mounting `/Users/<you>`). The full
  alpine template includes `_default/mounts`, which mounts the **host home
  directory** into the guest — a sandbox violation. Embedding only the `_images`
  partial keeps the same cached image without the home mount. (Also: the
  `template://` locator form is deprecated since lima v2.0.)
- **Instances are always created online.** The spec sketched setting
  `OFFLINE=true` at create when requested — but the boot script applies nftables
  on *every* boot including the first, and provisioning needs network
  (`apk`/`npm`). `launch.sh` therefore always creates with `OFFLINE=false`,
  provisions, then flips the param with one restart when offline was requested.
- **The offline chain allows `ct state established,related`.** A pure drop
  killed sshd's return traffic (lima SSH goes over a host-forwarded TCP port,
  not vsock), hanging `limactl start` readiness. Established/related keeps
  host-initiated SSH alive while the guest can no longer *initiate* anything —
  no DNS, no outbound connections.
- **Guest home is `/home/<user>.guest`.** The lima docs mention a `.linux`
  alias, but on the Alpine image it does not exist until something creates it —
  using it as a mount prefix made lima create a root-owned shadow dir detached
  from the real home. `--config` mounts target the real `.guest` home, and the
  system provision reclaims the pi-home parents that lima creates as root for
  mount points (`chown`), the same problem smolvm had.
- **sudo removal is provision-time, not declarative.** Lima has
  `user.passwordlessSudo: false`, but it is restricted to `plain: true`
  instances (no mounts), and it still leaves a generated password in
  `~/password` readable by the agent user. Instead the system provision removes
  `/etc/sudoers.d/90-cloud-init-users` (and any `~/password`).
- **There is no `always` provision mode** in lima 2.2.0 (spec listed one);
  `boot` (bootcmd, early, every boot) is what renders the `OFFLINE` param.
- **Params are templated, not env vars, for our use.** Scripts see params as
  `$PARAM_<KEY>` env vars *and* as `{{.Param.KEY}}` template values; the boot
  script uses the template form because it re-renders on every start — that is
  what makes `limactl start --set '.param.OFFLINE=…'` take effect without
  touching the instance YAML by hand. Lima validates that every param is
  referenced somewhere, which the template use satisfies.
- **Node comes from `apk`** (Alpine 3.23 ships Node 24); the system provision
  hard-fails if that ever regresses below 22, rather than silently installing a
  tarball fallback.

## Known regressions vs smolvm (accepted)

1. **No egress filtering** — full guest network access. Restore via option C
   (`TODO.md`): filtering resolver + nftables + no sudo (sudo removal already
   included here as groundwork).
2. **Workspace fixed at create time** — changing `--workspace` requires
   `--fresh` or a different `--name` (lima has no hot-mount). Mitigated by the
   guard error in `launch.sh`. The same applies to ad-hoc
   `--skill`/`--extension`/`--config`/`--no-global-*` mounts.
3. **No ephemeral mode** — hygiene is on-demand via `--fresh`.

## Verified on (host)

macOS arm64, limactl 2.2.0 (Homebrew), Alpine 3.23 nocloud image: create →
provision (~90 s) → restart (~50 s); workspace rw visible on host; ro mounts
ro; no host-home mount; offline blocks DNS+HTTPS and keeps `limactl shell`;
SSH agent forwarding presents a guest `SSH_AUTH_SOCK`; secrets pass via
`--preserve-env`; `pi --version` runs in-guest.
