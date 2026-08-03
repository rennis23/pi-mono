# Always-loaded skills (curated)

Everything in this directory is mounted read-only into the sandbox guest at
`~/.pi/agent/skills/` (via /opt/pi-skills), so pi auto-discovers it on every run.

Add one subdirectory per skill, each containing a `SKILL.md`:

```
skills/
└── my-skill/
    └── SKILL.md
```

This is a **curated, reviewed** copy — intentionally not a symlink to your
host `~/.pi/agent/skills`, so the VM only sees what you explicitly place here.

Skip the mount at instance creation with `launch.sh --no-global-skills`.
For ad-hoc, per-run skills use `launch.sh --skill <host-path>`.
