# Design: Single-source extension pre-cache for the pi-agent sandbox

## Goal

Add a pi.dev extension to the sandbox image by editing **only**
`sandbox/pi-global/settings.json`. `sandbox/images/Dockerfile.agent` derives its
build-time install list from that file, so the two files never drift.

## Current state

Adding a pre-cached extension currently requires editing two files:

- `sandbox/images/Dockerfile.agent`
  ```dockerfile
  RUN pi install npm:pi-subagents
  ```
- `sandbox/pi-global/settings.json`
  ```json
  {
    "$schema": "https://pi.dev/schemas/settings.json",
    "defaultProjectTrust": "always",
    "packages": ["npm:pi-subagents"]
  }
  ```

This duplication is error-prone: it is easy to add an extension to the runtime
settings but forget to pre-cache it in the image (or vice versa).

## Proposed change

Use `sandbox/pi-global/settings.json` as the single source of truth. The
Dockerfile copies it during the build and installs every package listed in the
`packages` array.

### `sandbox/pi-global/settings.json`

Remains the committed runtime settings file:

```json
{
  "$schema": "https://pi.dev/schemas/settings.json",
  "defaultProjectTrust": "always",
  "packages": ["npm:pi-subagents"]
}
```

### `sandbox/images/Dockerfile.agent`

Replace the hard-coded `RUN pi install npm:pi-subagents` with a dynamic step
that extracts `packages` from `settings.json`:

```dockerfile
COPY pi-global/settings.json /tmp/pi-settings.json
RUN node -e ' \
  const { execFileSync } = require("child_process"); \
  const settings = require("/tmp/pi-settings.json"); \
  for (const pkg of settings.packages || []) { \
    execFileSync("pi", ["install", pkg], { stdio: "inherit" }); \
  } \
'
```

The `COPY` is relative to the build context `sandbox/`, which already contains
`pi-global/settings.json`.

### Runtime behavior

`sandbox/scripts/run-agent.sh` mounts `sandbox/pi-global` read-only into the
guest and symlinks it to `/home/agent/.pi/agent/settings.json`. Because the
same file drives both build-time pre-caching and runtime loading, the guest pi
sees the exact same package list.

## Data flow

1. Developer edits `sandbox/pi-global/settings.json` and adds an entry to
   `packages`.
2. `sandbox/scripts/build-image.sh` runs `docker/podman build` with the
   `sandbox/` context.
3. The Dockerfile copies `pi-global/settings.json` and runs the Node.js
   extraction loop, invoking `pi install <pkg>` for each package.
4. At runtime, the same `settings.json` is mounted into the guest, and pi loads
   the same `packages`.

## Error handling

- Missing `pi-global/settings.json` → build fails at `COPY`.
- Invalid JSON in `settings.json` → build fails at `JSON.parse`.
- Missing `packages` key → treated as an empty array; build succeeds with no
  additional installs.
- Any `pi install` failure → build fails immediately (fail-fast).

## Testing

- Run `sandbox/scripts/build-image.sh` after the change and confirm the image
  builds successfully.
- Add a sample package to `packages`, rebuild, and launch pi in a VM to verify
  the package is available.
- Keep `npm run check` and `npm test` passing (no TypeScript source changes are
  expected).

## Scope

This change affects only:

- `sandbox/images/Dockerfile.agent`
- This design document

`sandbox/pi-global/settings.json` is edited by users when they add extensions,
but its schema and location do not change.
