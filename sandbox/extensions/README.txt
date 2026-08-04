# Always-loaded extensions (curated)

Everything in this directory is mounted read-only into the sandbox guest at
`~/.pi/agent/extensions/` (via /opt/pi-extensions), so pi auto-discovers it on
every run.

Accepted layouts (pi auto-discovery):

```
extensions/
├── my-extension.ts            # single file
└── my-extension/              # directory form
    └── index.ts
```

This is a **curated, reviewed** copy — intentionally not a symlink to your
host `~/.pi/agent/extensions`, so the VM only sees what you explicitly place
here. Note the mount is read-only: `/reload` can re-read edits made on the
host between runs, but the guest cannot modify these files.

Skip the mount at instance creation with `launch.sh --no-global-extensions`.
For ad-hoc extensions use `launch.sh --extension <host-path>` (create-time only;
use `--fresh` or another `--name` to change them).
