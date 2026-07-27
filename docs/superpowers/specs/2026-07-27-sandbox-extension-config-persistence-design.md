# Design: Persistent extension configs in the pi-agent sandbox

## Goal

Allow pi extensions that store configuration under `~/.pi/agent/<name>/` (e.g.
Langfuse) to keep that configuration across sandbox VM runs, without baking
credentials into the image or committing them to the repository.

## Background

Some pi extensions require runtime configuration that is written once and then
reused. Langfuse, for example, stores API credentials in
`~/.pi/agent/pi-langfuse/config.json`.

In the default ephemeral sandbox, the entire guest home directory is discarded
when the VM exits. Credentials must not be placed in the Docker image or in the
committed `sandbox/` files. The existing secret-forwarding mechanism (`--secret-env`)
uses environment variables, which can leak into LLM prompts and process listings.

## Proposed change

Add a `--config PATH:NAME` flag to `sandbox/scripts/run-agent.sh` that mounts a
host config directory read-write into the guest at `~/.pi/agent/NAME/`.

### Usage

```bash
run-agent.sh --config ~/.pi/agent/pi-langfuse:pi-langfuse
```

Multiple configs can be mounted:

```bash
run-agent.sh \
  --config ~/.pi/agent/pi-langfuse:pi-langfuse \
  --config ~/.pi/agent/my-extension:my-extension
```

### Implementation

`sandbox/scripts/run-agent.sh`:

- Accepts `--config PATH:NAME` (repeatable).
- Validates that `PATH` is an existing directory.
- Adds a virtiofs volume: `-v "PATH:/home/agent/.pi/agent/NAME:rw"`.
- Warns in `--persistent` mode if the machine already exists, because the mount
  is only applied at machine creation time.

`sandbox/Makefile`:

- Adds a `CONFIGS` variable that maps to repeated `--config` flags, analogous to
  `SKILLS` and `EXTS`.

```makefile
make pi CONFIGS='~/.pi/agent/pi-langfuse:pi-langfuse'
```

`sandbox/README.md`:

- Documents the new `--config` flag in the options table.
- Explains the Langfuse use case in the skills & extensions section.

## Data flow

1. The developer keeps the extension config on the host (e.g.
   `~/.pi/agent/pi-langfuse/config.json`).
2. At launch, `run-agent.sh` mounts the host directory into the guest.
3. The extension reads and writes its config at the same relative path inside
   the guest.
4. Because the mount is read-write, changes are persisted back to the host
   directory and survive VM restarts.

## Error handling

- Missing host directory → script exits with an error before launching the VM.
- Missing `:NAME` suffix → script exits with an error explaining the required
  `PATH:NAME` format.
- In `--persistent` mode with an already-created machine, a warning is printed
  because the new mount cannot be applied to an existing machine.

## Security

- Credentials stay out of the repository and the Docker image.
- Credentials are not passed via environment variables, so they do not appear in
  `ps`, `/proc/*/environ`, or LLM prompts.
- The host config directory is mounted read-write, so a compromised guest can
  modify it. This is acceptable for personal development configs and consistent
  with the existing threat model (the VM is the trust boundary for the agent).

## Testing

- Run `bash -n sandbox/scripts/run-agent.sh` to verify syntax.
- Run `sandbox/scripts/run-agent.sh --config ~/.pi/agent/pi-langfuse:pi-langfuse
  --shell -- -c "ls -la ~/.pi/agent/pi-langfuse/"` and confirm the config file
  is present.
- Run `npm run check` and `npm test`.

## Scope

This change affects:

- `sandbox/scripts/run-agent.sh`
- `sandbox/Makefile`
- `sandbox/README.md`
- This design document

It does not change the Docker image, the guest settings, or the way credentials
are stored on the host.
