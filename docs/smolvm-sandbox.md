# Plan: Secure pi-coding-agent sandbox with smolvm

## Goal

Run [pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
with full autonomy inside a hardware-isolated Linux microVM on macOS using
[smolvm](https://smolmachines.com/) (libkrun / Hypervisor.framework). The agent can execute
arbitrary commands without risking the host filesystem, credentials, or network.

## Threat model

- Agent runs `bash`, edits files, installs packages — must not touch host files outside the
  mounted workspace.
- Network egress: default-deny; allowlist only (npm registry, LLM API endpoints, GitHub).
  `--allow-host` also enables DNS filtering — only allowlisted hostnames resolve.
- API keys never persisted in the VM record, image, or repo — injected via smolvm secret
  refs (`--secret-env` / Smolfile `[secrets]`), resolved at launch.
- Git access via SSH agent forwarding (`--ssh-agent`): host agent signs challenges, private
  keys never enter the VM.
- Ephemeral by default: VM destroyed after session; only the mounted project dir persists.

## Directory structure

```
pi-mono/
├── packages/
│   ├── pi-hello/
│   └── pi-sandbox/                  # (Phase 3) pi extension: in-session sandbox control
├── sandbox/                         # sandbox runtime assets (not an npm package)
│   ├── README.md                    # setup & usage docs
│   ├── agent.smolfile               # declarative VM config (image, mounts, net, secrets)
│   ├── images/
│   │   └── Dockerfile.agent         # node:22 + git + pi-coding-agent
│   ├── scripts/
│   │   ├── doctor.sh                # preflight checks
│   │   ├── install-smolvm.sh        # install/verify smolvm
│   │   ├── build-image.sh           # podman build + save → agent.tar
│   │   └── run-agent.sh             # launch VM (ephemeral or persistent)
│   └── allowlists/
│       ├── default.txt              # registry.npmjs.org, api.anthropic.com, github.com...
│       └── offline.txt              # empty — fully air-gapped mode
└── docs/
    └── smolvm-sandbox.md            # this document
```

## Key design decisions (verified against smolvm AGENTS.md)

1. **Smolfile over custom config** — native TOML covers image, `[dev].volumes`,
   `[network].allow_hosts`, `[auth].ssh_agent`, `[secrets]`. No custom parser needed.
2. **Image build:** smolvm boots but does not build images. Build with podman, then
   `podman save` → `--image ./agent.tar`. Optionally `smolvm pack create` → `.smolmachine`
   for ~250ms cold starts.
3. **Secrets:** `--secret-env ANTHROPIC_API_KEY=ANTHROPIC_API_KEY` or Smolfile `[secrets]`.
   Defense-in-depth (guest root can read `/proc/*/environ`) — acceptable since the agent
   process itself needs the key.
4. **Git push:** `--ssh-agent` forwards the host SSH agent; keys cannot be extracted even
   by guest root. `GH_TOKEN` (for `gh` HTTPS flows) goes through `--secret-env`.
5. **Workspace:** `-v "$PWD:/workspace"` — host dir mounted live; all other VM state is
   discarded on exit (ephemeral) or kept in an overlay (persistent mode).
6. **Two modes:**
   - *ephemeral* — `smolvm machine run` (default, maximum hygiene)
   - *persistent* — `machine create --name pi-agent` + `start`/`exec` (package installs
     survive across sessions)

## Phases

- **Phase 1 — scripts only:** `doctor.sh` → `install-smolvm.sh` → `build-image.sh` →
  `run-agent.sh`; Smolfile + allowlists + Dockerfile. Manually verified end-to-end.
- **Phase 2 — modes & presets:** offline / default / permissive egress presets; packed
  `.smolmachine` artifact flow.
- **Phase 3 — `pi-sandbox` extension:** typed TS wrapper (`/sandbox status`,
  `/sandbox rebuild`, `/sandbox allow <host>`), optionally via `smolvm serve` HTTP API
  with SSE streaming exec; Vitest tests with mocked `child_process`.
- **Phase 4 (optional):** CI smoke test on a Linux KVM runner; publish `.smolmachine`
  to releases.

## Verified environment facts

- Host: macOS arm64 (Apple Silicon), smolvm at `~/.local/bin/smolvm`, podman available,
  `SSH_AUTH_SOCK` set.
- smolvm defaults: 2 vCPU, 4 GiB RAM (elastic), network off, 20 GiB storage.
