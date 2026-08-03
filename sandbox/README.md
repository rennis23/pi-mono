# pi-agent sandbox (lima)

Run [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) inside a
hardware-isolated Linux VM on macOS, backed by [lima](https://github.com/lima-vm/lima)
(vmType `vz` / Virtualization.framework — own kernel, not a container). Full design
rationale: [`docs/lima-sandbox.md`](../docs/lima-sandbox.md).

## Security properties

- **Hardware isolation** — own kernel via Virtualization.framework, not a container.
- **Filesystem** — only the dir mounted at `/workspace` (plus explicitly mounted
  skills/extensions/configs) is visible. The host home directory is *not* mounted.
- **Network** — full guest egress by default (see the egress note below); the
  `offline` preset blocks all outbound traffic with in-guest nftables.
- **API keys** — never written to the image, instance YAML, or repo; they live only
  in the session environment, forwarded from the host at launch.
- **Git/SSH** — host SSH agent forwarding (`ssh.forwardAgent`); private keys never
  enter the VM.
- **No sudo** — the guest user has no sudo grant.

> **Egress parity note:** the previous smolvm sandbox enforced default-deny egress
> with DNS-filtered allowlists. lima has no equivalent, so egress is currently
> **open** (migration decision "option D"). Filtering returns via DNS filtering +
> in-guest nftables — tracked in [`TODO.md`](../TODO.md). The `offline` preset
> (block-all) works today.

## Quick start

```bash
brew install lima                              # one-time; limactl >= 2.0
sandbox/scripts/doctor.sh                      # preflight checks
cd /path/to/your/project
/path/to/pi-mono/sandbox/scripts/launch.sh            # pi in the VM (creates it on first run)
/path/to/pi-mono/sandbox/scripts/launch.sh --shell    # bash in the VM instead
```

First launch creates the persistent `pi-agent` instance and provisions it
(Alpine packages + Node + pi, ~1–3 min; the VM image is cached afterwards).
Later launches start in seconds. Nothing is built locally — no image build step.

## Usage

```
launch.sh [--workspace DIR] [--allowlist NAME] [--name NAME] [--fresh]
          [--shell] [--skill PATH] [--extension PATH] [--config PATH:NAME]
          [--no-global-skills] [--no-global-extensions] [-- extra-pi-args...]
```

| Option | Description |
|---|---|
| `--workspace DIR` | host dir mounted at `/workspace` (default: `$PWD`) |
| `--allowlist NAME` | egress preset; only `offline` has an effect (block-all + `PI_OFFLINE=1`). Any other name warns and runs with full network |
| `--name NAME` | lima instance name (default: `pi-agent`) |
| `--fresh` | stop/delete/recreate the instance for a clean slate |
| `--shell` | open `bash` in the VM instead of launching pi |
| `--skill PATH` | mount a host skill file or skills directory read-only and load it (repeatable) |
| `--extension PATH` | mount a host extension file/dir read-only and load it (repeatable) |
| `--config PATH:NAME` | mount a host config directory read-write into `~/.pi/agent/NAME/` (repeatable) |
| `--no-global-skills` | skip the always-on `sandbox/skills` mount (create time only) |
| `--no-global-extensions` | skip the always-on `sandbox/extensions` mount (create time only) |

`make` wrappers (`sandbox/Makefile`): `doctor`, `pi`, `pi-offline`, `pi-fresh`,
`shell`, `stop`, `delete`, `clean`. Pass-through: `make NAME=mybox pi
SKILLS=/path EXTS=/path CONFIGS='~/.pi/agent/pi-langfuse:pi-langfuse'
ARGS='--pi-flag'`, or arbitrary launch.sh flags via `PI_ARGS`. The `NAME`
variable is used for launch and lifecycle targets; an explicit `--name` in
`PI_ARGS` appears later and overrides it. When overriding the name, use the
same name with `NAME` for subsequent `stop`/`delete` commands.

## Persistent instance lifecycle

The instance is persistent: package installs, `~/.pi/agent` state (auth.json,
sessions), and caches survive across sessions — there is no ephemeral mode.

```bash
launch.sh                 # creates + starts 'pi-agent' on first run, then just starts it
launch.sh --fresh         # stop/delete/recreate for a clean slate
limactl stop pi-agent     # or: make -C sandbox stop
limactl delete pi-agent   # or: make -C sandbox delete
```

**The workspace is baked in at create time.** lima cannot hot-mount, so launching
with a `--workspace` different from the one the instance was created with is an
error — use `--fresh` to recreate, `--name` for a separate per-project instance,
or run from the original workspace. The same applies to `--skill` / `--extension`
/ `--config` / `--no-global-*`: they only take effect at create time (a warning
is printed when they are given for an existing instance).

## Providers

Secrets flow automatically: `limactl shell --preserve-env` forwards the host
environment into the guest session, and lima's default blocklist does **not**
cover `*_API_KEY`, `AWS_*`, or `GH_TOKEN`. Export keys on the host before
launching; nothing is persisted in the VM. (`SSH_AUTH_SOCK` is blocklisted from
env passthrough, but agent forwarding covers git.) Note that `--preserve-env`
forwards *all* non-blocklisted host env — wrap the launch in `env -i` if you want
a minimal environment.

- **opencode-go** — pi's built-in [OpenCode Go](https://opencode.ai/zen/go/v1)
  provider (kimi, glm, deepseek, qwen3, mimo, minimax, grok…). Export
  `OPENCODE_API_KEY` on the host; select with `/model opencode-go/<id>` inside pi.
- **Anthropic / OpenAI** — export `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
- **GitHub Copilot** — run `/login github-copilot` inside pi (device OAuth flow).
  The OAuth tokens live in `~/.pi/agent/auth.json` on the instance disk, which
  survives restarts (but not `--fresh`).
- **AWS Bedrock** — export `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
  (+ `AWS_SESSION_TOKEN`), or `AWS_BEARER_TOKEN_BEDROCK`, and optionally
  `AWS_REGION` (default `us-east-1`). Then e.g.
  `pi --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0`.
  `AWS_PROFILE` (shared `~/.aws` files) is intentionally not supported — the host
  AWS config stays outside the VM.

## Skills & extensions

Two loading modes:

**1. Always loaded (curated global set)** — `sandbox/skills/` and
`sandbox/extensions/` are mounted read-only under `/opt` and symlinked to
`~/.pi/agent/skills` and `~/.pi/agent/extensions`, so pi auto-discovers them on
every run. (The mounts live under `/opt` because lima creates mount-point parents
as root; mounting under the pi home directly would leave it unwritable.) These
are curated copies, *not* symlinks to your host pi config — the VM only sees what
you explicitly place there. `sandbox/pi-global/settings.json` is mounted (as a
directory at `/opt/pi-global`, symlinked into the pi home — virtiofs cannot mount
single files) as the guest pi settings; it sets `defaultProjectTrust: "always"`
(the VM is the trust boundary, so the interactive trust prompt is skipped).
Skip these mounts at create time with `--no-global-skills` / `--no-global-extensions`.

**2. Scoped / ad hoc:**
- *Per-directory* — a project mounted at `/workspace` that contains `.pi/skills/`
  or `.pi/extensions/` gets them auto-loaded only for that project (no trust
  prompt, thanks to the guest settings above).
- *Ad hoc at create* — repeatable flags. Directories are mounted read-only under
  `/opt/adhoc/...` (live view of the host); single files cannot be mounted
  (virtiofs limitation) and are staged (copied) under
  `$LIMA_HOME/<instance>/adhoc-files/`, so the mounted paths survive launcher
  exits and VM restarts. Host edits to a single file after creation are not
  reflected until `--fresh` (or another instance name):

  ```bash
  launch.sh --fresh --skill ~/.agents/skills \
            --extension ./packages/pi-hello/index.ts
  ```

  For extensions that keep credentials under `~/.pi/agent/<name>/`, mount the
  host config directory read-write so state persists across VM runs (and across
  `--fresh`):

  ```bash
  launch.sh --config ~/.pi/agent/pi-langfuse:pi-langfuse
  ```

## Offline mode

`launch.sh --allowlist offline` flips the instance's `OFFLINE` param and restarts
it; a boot script then reconciles an nftables block-all egress rule (loopback
and host-initiated SSH exempt — `limactl shell` keeps working). Online launches
remove that table, so switching modes repeatedly converges correctly.
`PI_OFFLINE=1` is set in the session so pi skips model-catalog network access
entirely. Instances are always *created* online — provisioning needs network —
and flipped afterwards.

The `allowlists/*.txt` files are retained for the upcoming egress-filtering work
(`TODO.md`) but are not read by `launch.sh`.

## Troubleshooting

- `SSH_AUTH_SOCK not set` — start `ssh-agent` / use a shell that inherits it.
- Git push fails — `ssh-add -l` on the host must list an identity.
- pi has no provider — export `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`/`OPENCODE_API_KEY`)
  before launching; keys enter the session env only, never the image or instance config.
- Instance fails to start — see `~/.lima/<name>/ha.stderr.log`; `launch.sh --fresh`
  recreates from scratch. `limactl stop --force <name>` unsticks a hung VM.
- Provisioning failures — instance cloud-init logs: `limactl shell <name> cat /var/log/cloud-init-output.log`.
