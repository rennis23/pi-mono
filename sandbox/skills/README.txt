# Always-loaded skills (curated)

Everything in this directory is mounted read-only into the sandbox guest at
`/home/agent/.pi/agent/skills/`, so pi auto-discovers it on every run.

Add one subdirectory per skill, each containing a `SKILL.md`:

```
skills/
└── my-skill/
    └── SKILL.md
```

This is a **curated, reviewed** copy — intentionally not a symlink to your
host `~/.pi/agent/skills`, so the VM only sees what you explicitly place here.

Skip the mount for a single run with `run-agent.sh --no-global-skills`.
For ad-hoc, per-run skills use `run-agent.sh --skill <host-path>`.
