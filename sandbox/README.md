# pi-agent sandbox (smolvm)

Run [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) inside a
hardware-isolated Linux microVM on macOS. Full design rationale:
[`docs/smolvm-sandbox.md`](../docs/smolvm-sandbox.md).

## Security properties

- **Hardware isolation** — own kernel via Hypervisor.framework (libkrun), not a container.
- **Filesystem** — only the dir you mount at `/workspace` is visible; everything else is
  discarded on exit (ephemeral mode).
- **Network** — default-deny. `--allow-host` entries enable egress *and* DNS filtering;
  the `offline` preset disables networking entirely.
- **API keys** — smolvm secret refs (`[secrets]` in `agent.smolfile`), resolved at launch,
  never persisted in the VM record or image.
- **Git/SSH** — host SSH agent forwarding; private keys never enter the VM.

## Quick start

```bash
sandbox/scripts/doctor.sh                    # preflight checks
sandbox/scripts/install-smolvm.sh            # if smolvm is missing
sandbox/scripts/build-image.sh               # build images/pi-agent.tar (podman/docker)
cd /path/to/your/project
/path/to/pi-mono/sandbox/scripts/run-agent.sh            # pi, ephemeral VM
/path/to/pi-mono/sandbox/scripts/run-agent.sh --shell    # bash in the VM instead
```

## Usage

```
run-agent.sh [--workspace DIR] [--allowlist NAME] [--persistent [--name NAME]]
             [--shell] [-- extra-pi-args...]
```

| Option | Description |
|---|---|
| `--workspace DIR` | host dir mounted at `/workspace` (default: `$PWD`) |
| `--allowlist NAME` | egress preset from `allowlists/NAME.txt` (default: `default`; `offline` = no network) |
| `--persistent` | named machine; package installs survive across sessions |
| `--name NAME` | persistent machine name (default: `pi-agent`) |
| `--shell` | open `bash` in the VM instead of launching pi |

## Providers

- **opencode-go** — pi's built-in [OpenCode Go](https://opencode.ai/zen/go/v1) provider
  (kimi, glm, deepseek, qwen3, mimo, minimax, grok…). Export `OPENCODE_API_KEY` on the
  host before launching; it is forwarded as a smolvm secret ref. Select with
  `/model opencode-go/<id>` inside pi.

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GH_TOKEN` are forwarded the same way when set.

Two built-in pi providers also work in the sandbox:

- **GitHub Copilot** — run `/login github-copilot` inside pi (device OAuth flow). Use
  `--persistent` mode: the OAuth tokens live in `~/.pi/agent/auth.json`, which survives
  only in a persistent machine's overlay. Egress to `api.githubcopilot.com` and
  `copilot-proxy.githubusercontent.com` is in the default allowlist.
- **AWS Bedrock** — export `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+
  `AWS_SESSION_TOKEN`), or `AWS_BEARER_TOKEN_BEDROCK`, and optionally `AWS_REGION`
  (default `us-east-1`; the default allowlist covers `us-east-1`/`us-west-2` runtime
  endpoints — add `bedrock-runtime.<region>.amazonaws.com` to the allowlist for others).
  Then e.g. `pi --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0`.
  Note: `AWS_PROFILE` (shared `~/.aws` files) is intentionally not supported — the host
  AWS config stays outside the VM.

## Egress presets

Edit or add files in `allowlists/` (one hostname per line). The default preset covers
Anthropic/OpenAI/opencode APIs, the npm registry, and GitHub.

## Persistent machine lifecycle

```bash
run-agent.sh --persistent                 # creates + starts 'pi-agent', runs pi
smolvm machine stop --name pi-agent
smolvm machine delete --name pi-agent     # wipe overlay + storage
```

## Troubleshooting

- `SSH_AUTH_SOCK not set` — start `ssh-agent` / use a shell that inherits it.
- Git push fails — `ssh-add -l` on the host must list an identity.
- pi has no provider — export `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`/`OPENCODE_API_KEY`) before launching;
  keys are forwarded via secret refs, never written into the image.
