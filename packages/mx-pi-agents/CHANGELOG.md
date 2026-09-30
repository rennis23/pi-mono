# Changelog

All notable changes to `@rennis23/mx-pi-agents` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Child telemetry on the shared extension event bus: each in-process child run
  loads one in-process inline extension that re-publishes its lifecycle events
  (`session_start`, `context`, `before_provider_request`, `message_end`,
  `tool_execution_start/end`, …) on the `mx-pi-agents:child-telemetry` channel,
  keyed by `delegationId` / `runId` / `agent` with the parent session id. This
  lets a parent tracing extension (e.g. pi-phoenix) see delegated runs that are
  otherwise invisible because children load no extensions. Publishing is
  best-effort and never disturbs a child; the subprocess runner publishes
  nothing.
- Live agent progress widget above the editor for every delegation (directives
  and `mx_pi_agent` calls): a spinner header plus one row per stage with
  `running` / `waiting` / `done` / `failed` / `cancelled` glyphs. Escape cancels
  an in-flight run through the existing abort signal.
- Direct `#` invocation from the interactive prompt: `#agent <prompt>` runs one
  agent and `#[a > b, c] <prompt>` runs a pipeline with cascade `{previous}`
  substitution and parallel groups. Directives reuse the tool's trust gate, hash
  re-verification, budgets and path scope, start a main-model turn, and get live
  `#` autocomplete of the pinned roster.
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
- Per-run path scope: the config `scope` ceiling and the definition `scope`
  field, reported by `/mx-pi-agents status`. Every granted file tool is confined
  to the run scope (invariant 11).
- `SECURITY.md` with the threat model, an enforced/not-enforced table, the
  decisions log and residual risk.

### Changed

- Verified against pi 0.99.1 and bumped the dev dependencies
  (`@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` to `^0.99.1`,
  `typebox` to `^1.3.27`). The peer range stays `>=0.80.0`. No source change was
  needed for 0.99: the extension uses no API removed between 0.82 and 0.99.
- `mx_pi_agent` now carries 0.99 tool metadata: a `namespace` and
  `annotations` (`readOnlyHint: false`, `destructiveHint: true`,
  `idempotentHint: false`, `openWorldHint: true`) so permission extensions can
  gate delegated runs.

### Security

- Child telemetry broadcasts the child's raw extension events — including
  provider request payloads and assistant messages — to every extension loaded
  in the parent session. Extensions already run arbitrary in-process code, so
  this is not an escalation, but it widens the audience for prompt/tool data
  from the parent extension alone to all loaded extensions. It is opt-in per
  consumer (nothing is captured unless something subscribes) and the payload is
  never written to disk.
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
- A granted file tool (`read`, `write`, `edit`, `grep`, `find`, `ls`) can no
  longer touch a path outside the run scope. The default scope is the run's cwd;
  an absent, malformed or unresolvable scope is a refusal, never "unrestricted".
- A vector that cannot be path-confined — `bash` with `sandbox: none`, or
  `isolation: subprocess` — is refused (`scope-unenforceable`) unless the config
  ceiling is an explicit `scope: ["/"]`. `builder` now sets `sandbox: os` so the
  default roster keeps working.
- The `sandbox: os` seatbelt profile no longer allows a bare host-wide
  `(allow file-read*)`, and the `bwrap` argv no longer binds `/` read-only. Reads
  are limited to the run scope plus an immutable OS runtime allowance.
