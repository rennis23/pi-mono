# Changelog

All notable changes to `@rennis23/mx-pi-agents` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial secure agent registry: strict frontmatter parsing, fail-closed capability
  grants, approval-gated project agents, and definition hash pinning.
- Subagent delegation in single, parallel and chain modes with mandatory turn,
  wall-clock, token and optional cost budgets.
- In-process runner (in-memory settings/session, all resource discovery off) and
  subprocess runner (task over stdin, hardened argv).
- Optional OS-level bash sandbox (`sandbox: os`) for platforms with a supported
  backend.
- Bundled read-only `explorer`, `planner` and `reviewer` agents plus the writing
  `builder` agent.
- `mx_pi_agent` tool, `/mx-pi-agents list|approve|status|refresh` command, and
  `--mx-pi-agents-list` / `--mx-pi-agents-disable` flags.
- `SECURITY.md` with the threat model, an enforced/not-enforced table, the
  decisions log and residual risk.

### Security

- Child sessions cannot read project-scoped settings: the settings manager is
  built from `<agentDir>/settings.json` read directly, so no code path can
  observe `<cwd>/.pi/settings.json` (fixes the piolium P-01 class of finding).
- Child resource discovery is disabled entirely, so repository skills and
  context files cannot reach the child system prompt (fixes the P-02 class).
- The child settings manager and resource loader refuse an empty agent dir
  instead of resolving it against `process.cwd()`, which would have read the
  target repository's settings.
- Grants are total: `tools: []` and absent `tools` mean *no tools*, never "all".
- Spawn-capable tools are refused as explicit grants and excluded from
  inheritance, so children cannot spawn children.
- Definitions are pinned and re-hashed at spawn; a changed file refuses the run.
- An already-aborted signal refuses the run before any session or process is
  created.
