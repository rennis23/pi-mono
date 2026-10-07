# Changelog

All notable changes to `@rennis23/mx-pi-agents` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** `#name <task>` is now a main-session switch for switchable
  definitions instead of a child delegation. The frontmatter vocabulary changed:
  `system_prompt: replace|append` (default `append`) selects how the body
  mutates the system prompt, and the booleans `sub_agent_only` / `main_agent_only`
  restrict where a definition may run. A definition with neither flag defaults to
  being usable in both places, so `#explorer <task>` switches the main
  session. Delegation to the same agents remains available through
  `#[explorer] <task>` and the `mx_pi_agent` tool. Definitions that should keep
  delegating from a bare name must declare `sub_agent_only: true`.
- `#none` is now reserved and resets the main session to plain pi. A definition
  named `none` is dropped at discovery with a diagnostic.
- **Breaking:** the bundled `productbuilder` orchestrator is renamed to
  `product-builder`. The old name no longer resolves and `#productbuilder` is
  now an unknown agent.
- **Breaking:** a definition file must be named `<name>.md` to match its
  frontmatter `name` field. A mismatch is dropped at discovery with a warning
  diagnostic. This applies to every source: bundled, global, config and project.
- The `sandbox: os` seatbelt profile now also allows reading the resolved
  JavaScript toolchain directories, so a sandboxed `bash` can exec `node`, `npm`
  and `npx` on installs where the toolchain is not under `/usr`, `/bin` or
  `/sbin` (Homebrew, nvm, fnm, volta). It also allows reading the package
  manager's library directories (`opt`/`Cellar` under the derived prefix),
  because the runtime's dynamic dependencies must load before `node` can start:
  without them `node` aborts under dyld with `Library not loaded ... (blocked by
  sandbox)` and exit 134. It also allows reading the prefix's `etc` directory,
  because node reads its own configuration there — on Homebrew
  `/opt/homebrew/etc/openssl@3/openssl.cnf` — and aborts at OpenSSL
  initialisation without it (`node --version` succeeds while every script
  fails). This is a deliberate widening of the sandboxed read
  allowance. `SEATBELT_SYSTEM_READ_ROOTS` is now derived at runtime from
  `process.execPath` and `PATH` rather than hardcoded; see `SECURITY.md` for the
  documented residual. It now also grants a global metadata-only read,
  `(allow file-read-metadata)`, required because path resolution must stat every
  ancestor of every path: a `(subpath X)` rule covers X and its descendants but
  not X's ancestors, so `npx`, `npm` and `node <file>` failed with
  `EPERM: operation not permitted, lstat '/opt'` (or `lstat '/Users'`) before the
  script ran, while inline `node -e` worked. Content reads stay per-root and there
  is still no bare `(allow file-read*)`. The system temp directory (resolved
  through realpath) is now readable and writable so a test runner has scratch
  space, and the npm cache (`~/.npm`, or `npm_config_cache`) is now readable but
  deliberately not writable, so a sandboxed child cannot poison a cache the host
  later reads. Writes remain otherwise limited to the run scope.
- Verified against pi 1.0.3 and bumped the dev dependencies
  (`@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` to `^1.0.3`).
  The peer range stays `>=0.80.0`. No source change was needed for 1.0: the
  extension uses no API removed between 0.82 and 1.0.
- `mx_pi_agent` now carries 0.99 tool metadata: a `namespace` and
  `annotations` (`readOnlyHint: false`, `destructiveHint: true`,
  `idempotentHint: false`, `openWorldHint: true`) so permission extensions can
  gate delegated runs.

### Added

- Bundled `verifier` agent: a read-only-with-evidence runner (`read`, `grep`,
  `find`, `ls`, `bash` under `sandbox: os`) that runs the test suite, lint and
  typecheck and reports the raw output verbatim. It never edits and never claims
  a command passed without pasting the run that shows it.
- Bundled `security-reviewer` agent: audits a change against the extension's trust
  boundaries and the `SECURITY.md` invariants and returns severity-ranked,
  CWE-tagged findings. It is read-only by design — `read`, `grep`, `find`, `ls` and
  no `bash` — so it cannot execute repository-controlled code.
- `product-builder` now runs verification and security review as mandatory stages
  before it reports: it delegates to `verifier` and `security-reviewer`, and a
  Critical or High finding blocks the report until it is fixed and re-reviewed.
- Main-session delegation: a `delegate: true` frontmatter field on a
  main-session definition keeps the `mx_pi_agent` tool active across a
  main-session switch. The flag unions `mx_pi_agent` into the applied tool
  preset (the declared `tools`, or the current active set when `tools` is
  absent) and refuses the switch if the tool does not resolve. It is a
  main-session verb only: child runs ignore it, so a child can never delegate.
  `/mx-pi-agents list` marks delegating definitions with a `⇄ delegate` token.
- Bundled `product-builder` orchestrator: an append-mode agent with
  `delegate: true` and read-only tools that runs the
  explorer → planner → builder → reviewer pipeline and ends with a commit
  message plus a PR title and description (it does not open the PR).
- Main-session resource allow-lists: `skills` and `context_files` frontmatter
  fields on a main-session definition narrow the prompt sections pi's
  resource loader renders (skills and project context) while the switch is
  active. List semantics mirror `tools`: absent = inherit the loaded set,
  `[]` = none, `[a, b]` = only those entries. pi has no unload call, so a
  definition can only narrow; unknown entries match nothing. The bundled
  `socrates` agent now declares `skills: []` and `context_files: []` on top of
  `tools: []`.
- Prompt modes and visibility flags: an optional `system_prompt` frontmatter
  field (`replace`, or `append` by default). A switchable definition can be
  applied to the main session with `#name`: `replace` replaces the system prompt
  prefix (the `--system-prompt` code path) and `append` appends to the system
  prompt (the `--append-system-prompt` code path). The booleans `sub_agent_only`
  and `main_agent_only` restrict a definition to one session; setting both drops
  the definition as invalid. A switch also applies the definition's
  `tools`, `model` and `thinking` as a preset, fail-closed, and records a
  session-scoped custom entry so it survives a resume. `#none` restores the
  exact pre-switch baseline; sub-agent-only definitions keep delegating. The
  active switch is shown in the footer and the roster/autocomplete show mode
  badges.
- Registers the `defaultPersona` setting with `@rennis23/mx-pi-settings`; it is
  applied at session start when no switch was rehydrated from the branch.
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
  `builder` agent, and the bundled `socrates` main-only `replace` agent (no tools)
  that interrogates a problem with a chosen number of Socratic questions.
- `mx_pi_agent` tool, `/mx-pi-agents list|approve|status|refresh` command, and
  `--mx-pi-agents-list` / `--mx-pi-agents-disable` flags.
- Per-run path scope: the config `scope` ceiling and the definition `scope`
  field, reported by `/mx-pi-agents status`. Every granted file tool is confined
  to the run scope (invariant 11).
- `SECURITY.md` with the threat model, an enforced/not-enforced table, the
  decisions log and residual risk.

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
