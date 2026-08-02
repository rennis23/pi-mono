# Design: Migrate pi-agent sandbox from smolvm to lima

Date: 2026-08-02
Status: approved
Supersedes: `docs/smolvm-sandbox.md` (removed by this change)

## Goal

Replace the smolvm-based pi-coding-agent sandbox (`sandbox/`) with an equivalent
built on [lima](https://github.com/lima-vm/lima) (installed via Homebrew, v2.2.0
verified on the host). The agent still runs hardware-isolated on macOS (vz /
Virtualization.framework, own kernel), but day-to-day operation becomes a
persistent named VM instead of ephemeral microVMs.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Egress allowlist gap (lima has no `--allow-host`) | **Option D: accept full network access now.** Restore filtering later via option C (DNS filtering + in-guest nftables) — tracked in `TODO.md`. |
| Ephemeral vs persistent | **Persistent default**, one named instance (`pi-agent`), plus `--fresh` to stop/delete/recreate for a clean slate. |
| Replace vs side-by-side | **Hard rip-out with renames.** All smolvm assets deleted; scripts renamed freely; single backend. |
| Instance sizing | `vmType: vz`, `cpus: 2`, `memory: 2GiB`, `disk: 10GiB`. |

## Verified lima facts (v2.2.0)

- `ssh.forwardAgent: true` (instance YAML) forwards the host SSH agent natively —
  replaces smolvm's `--ssh-agent`.
- `limactl shell --preserve-env` propagates host env to the guest session. The
  default blocklist (`pkg/envutil`) blocks `SSH_*`, `PATH`, `HOME`, `USER`,
  shell/system vars — **not** `*_API_KEY`, `AWS_*`, or `GH_TOKEN`, so secrets
  pass through without `LIMA_SHELLENV_ALLOW`. `SSH_AUTH_SOCK` is blocked, which
  is fine (agent forwarding covers git).
- Provision modes: `system` (root, once), `user` (default user, once), `boot`
  (root, every boot), `always`, `dependency`.
- `limactl create/start --set '<yq expr>'` (repeatable) modifies instance YAML
  in place — used to inject mounts and the offline param.
- Mounts are directories only (single files must be staged, same as smolvm's
  virtiofs limitation). Guest home on Linux guests is `/home/<user>.linux`.
- No native egress filtering (the core trade-off of this migration).
- Alpine templates ship with lima: `template://alpine-3.23`
  (`/opt/homebrew/share/lima/templates/alpine-3.23.yaml`).

## File layout

**Removed**

- `sandbox/agent.smolfile`
- `sandbox/scripts/install-smolvm.sh` (lima already brew-installed; `doctor.sh` checks)
- `sandbox/scripts/build-image.sh`, `sandbox/images/` (`Dockerfile.agent`, `pi-agent.tar`)
- `docs/smolvm-sandbox.md`

**Added**

- `sandbox/agent.lima.yaml` — base instance config (see below)
- `sandbox/scripts/launch.sh` — replaces `run-agent.sh`
- `docs/lima-sandbox.md` — new design/rationale doc (replaces the smolvm one)

**Modified**

- `sandbox/scripts/doctor.sh` — lima checks
- `sandbox/Makefile` — targets re-pointed
- `sandbox/README.md` — rewritten
- `TODO.md` — option-C follow-up (updated as part of this change)

## `sandbox/agent.lima.yaml`

```yaml
base: template://alpine-3.23   # matches current node:22-alpine guest; cached by lima

vmType: vz
cpus: 2
memory: 2GiB
disk: 10GiB

ssh:
  forwardAgent: true           # host SSH agent; private keys never enter the VM

param:
  OFFLINE: "false"             # flipped per-run via --set + restart

provision:
  # root, once at create — replaces images/Dockerfile.agent
  - mode: system
    script: |
      #!/bin/sh
      apk add --no-cache bash bat ca-certificates curl fd git github-cli \
        openssh-client ripgrep nodejs npm nftables
      npm install -g @earendil-works/pi-coding-agent
      mkdir -p /workspace && chown it to the lima default user
      # remove the passwordless-sudo grant created by lima provisioning
      # (parity with smolvm's unprivileged agent user; also a prerequisite
      # for the TODO option-C egress rules to hold)

  # default user, once — pi home wiring + extension pre-cache
  - mode: user
    script: |
      #!/bin/sh
      mkdir -p ~/.pi/agent
      ln -sfn /opt/pi-skills ~/.pi/agent/skills
      ln -sfn /opt/pi-extensions ~/.pi/agent/extensions
      ln -sfn /opt/pi-global/settings.json ~/.pi/agent/settings.json
      # pre-cache packages[] from settings.json (same as the old Dockerfile step)

  # root, every boot — offline preset
  - mode: boot
    script: |
      #!/bin/sh
      if [ "$OFFLINE" = "true" ]; then
        # idempotent nftables block-all egress (loopback exempt)
      fi

mounts: []   # injected at create time by launch.sh via --set
```

Exact script bodies are finalized at implementation time; the above fixes
responsibilities and ordering. Node comes from `apk` (Alpine 3.23 ships a
Node ≥ 22 — verify at build; fall back to the official tarball if older).

## `sandbox/scripts/launch.sh`

Replaces `run-agent.sh`. Flags: `--workspace DIR` (default `$PWD`),
`--allowlist NAME` (default `default`), `--name NAME` (default `pi-agent`),
`--fresh`, `--shell`, `--skill PATH` / `--extension PATH` / `--config PATH:NAME`
(repeatable), `--no-global-skills`, `--no-global-extensions`, `-- pi-args…`.
Removed: `--persistent` (persistent is now the only mode).

Flow:

1. **Allowlist resolution** — only the name `offline` is special: it sets
   `OFFLINE=true` and exports `PI_OFFLINE=1`. Any other preset name prints a
   one-line warning that egress filtering is not yet implemented (see
   `TODO.md`) and continues with full network. `allowlists/*.txt` are retained
   for option C but are no longer read by `launch.sh`.
2. **Create** (instance missing, or `--fresh` after `limactl stop`/`delete`):
   - Build a mounts JSON array:
     - `$WORKSPACE` rw → `/workspace`
     - `sandbox/skills` ro → `/opt/pi-skills` (unless `--no-global-skills`)
     - `sandbox/extensions` ro → `/opt/pi-extensions` (unless `--no-global-extensions`)
     - `sandbox/pi-global` ro → `/opt/pi-global` (settings.json)
     - ad-hoc `--skill`/`--extension` dirs ro → `/opt/adhoc/<kind>/<name>`;
       single files staged (copied) into mktemp dirs and mounted ro, same as
       today (host edits to single files mid-run are not reflected)
     - `--config PATH:NAME` rw → `/home/<user>.linux/.pi/agent/<NAME>`
   - `limactl create --name="$NAME" --tty=false \
       --set '.mounts = <json>' [--set '.param.OFFLINE="true"'] \
       "$SANDBOX_DIR/agent.lima.yaml"`
   - First create runs full provisioning (~1–3 min; image cached afterwards).
3. **Existing-instance guards**
   - Requested `--workspace` ≠ the workspace mounted at create → error:
     lima cannot hot-mount; suggest `--fresh` or `--name`.
   - Requested offline state ≠ instance's `param.OFFLINE` → `limactl stop`,
     then `limactl start --set '.param.OFFLINE=…'` (boot script applies it).
   - Ad-hoc `--skill/--extension/--config` given for an already-created
     instance → warn they only apply at create time (same caveat as smolvm's
     persistent mode).
4. **Start** if stopped (seconds), then:
   `exec limactl shell --preserve-env --workdir /workspace "$NAME" <pi|bash> [args]`
   TTY allocation is automatic. Secrets flow from host env (verified not
   blocklisted); note `--preserve-env` forwards *all* non-blocklisted host env
   into the session — wrap in `env -i` if a minimal environment is wanted.

## `sandbox/scripts/doctor.sh`

Checks: macOS arm64 · `limactl` ≥ 2.0 (shellenv/param support) · macOS ≥ 13
(vz + virtiofs) · `template://alpine-3.23` resolvable · `SSH_AUTH_SOCK` set with
≥1 identity · ≥1 LLM credential in env (same key set and whitespace warnings as
today). podman/docker check dropped — nothing is built anymore.

## `sandbox/Makefile`

Targets: `doctor`, `pi`, `pi-offline`, `pi-fresh`, `shell`, `stop`, `delete`,
`clean` (instance only). Removed: `build`, `pi-persist`, `shell-persist`.
`SKILLS` / `EXTS` / `CONFIGS` / `PI_ARGS` / `ARGS` passthrough kept.

## Docs

- `sandbox/README.md` — rewritten: quick start, flag table, providers section
  (secrets flow automatically via `--preserve-env`; Copilot OAuth and Bedrock
  notes carry over; opencode-go unchanged), persistent lifecycle incl.
  `--fresh`, the workspace-baked-at-create caveat, egress parity note.
- `docs/lima-sandbox.md` — threat-model deltas vs smolvm: still
  hardware-isolated (vz, own kernel, not a container); **egress is open**
  (option D; restore = TODO option C); persistent-by-default; secrets live only
  in the session env (never written to image, instance YAML, or repo); guest
  user has no sudo.

## Known regressions vs smolvm (accepted)

1. **No egress filtering** — full guest network access. Restore via option C
   (`TODO.md`): filtering resolver + nftables + no sudo (sudo removal already
   included here as groundwork).
2. **Workspace fixed at create time** — changing `--workspace` requires
   `--fresh` or a different `--name` (lima has no hot-mount). Mitigated by the
   guard error message in `launch.sh`.
3. **No ephemeral mode** — hygiene is on-demand via `--fresh` instead of
   automatic per-session teardown.

## Verification (manual — same bar as smolvm phase 1)

- `doctor.sh` passes on the host.
- `launch.sh` → pi session works; exit; second run starts in seconds.
- `--fresh` recreates cleanly; `--shell` gives bash.
- `--allowlist offline`: `curl https://api.anthropic.com` fails in-guest,
  `PI_OFFLINE=1` is set, pi runs without catalog warnings.
- Workspace writes in-guest appear on the host; files outside the workspace are
  not visible.
- `git push` works via the forwarded SSH agent.
- Global + ad-hoc skill/extension mounts load; no pi trust prompt
  (`defaultProjectTrust: always` via mounted settings).
- No TS source touched → `npm run check` / `npm test` unaffected (still run
  them per DOD-AGENT.md).

## Implementation phases

1. **Phase 1 — core:** `agent.lima.yaml`, `launch.sh` (create/start/shell,
   workspace mount, secrets, `--fresh`, `--shell`), `doctor.sh` rewrite, delete
   smolvm assets. Manually verify end-to-end.
2. **Phase 2 — parity:** global + ad-hoc skill/extension/config mounts,
   `--config` rw mounts, offline preset (param + boot nftables + restart
   logic), workspace guard, Makefile, `sandbox/README.md`,
   `docs/lima-sandbox.md`.
3. **Phase 3 — (deferred, tracked in `TODO.md`):** egress filtering option C.
