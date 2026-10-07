# Security — `@rennis23/mx-pi-agents`

This document states what the extension enforces, what it does **not** enforce,
and why. It is written in the same boundary language pi's own security
documentation uses: a boundary that is not enforced is named as such rather than
implied by omission.

Every claim below is backed by a test in `src/security.test.ts` (one test per
invariant) or by the unit suite for the relevant module.

---

## 1. Threat model

**Assets.** Operator host files, credentials, shell and `~/.pi/**`; provider
credentials and quota; integrity of delegated results; confidentiality of prompts
and transcripts.

**Adversary.**

1. Anyone who controls content in the target tree, including `.pi/**` and symlinks.
2. Content an agent reads (source, docs, web) attempting prompt injection.
3. Third-party agent and skill definitions.
4. Confused-deputy behaviour across the child↔parent boundary: argv exposure,
   transcripts, cross-session delivery, recursion.

**Non-goals.** The pi host platform; provider/LLM trust; OS-level isolation of
the whole pi process; **recursive delegation**. A child is always a leaf: it
cannot delegate, by design, and the `delegate` frontmatter flag does not change
that. Those first three are what containers and micro-VMs are for, per pi's own
security documentation; bounded recursion would be a separate design with its
own depth, scope and budget controls.

| # | Boundary | Attacker control | Control that holds |
| --- | --- | --- | --- |
| B1 | cloned repo → parent session | `.pi/settings.json`, `.pi/skills`, `.pi/agents`, symlinks | child sessions load **none** of it; project agents gated by approval + hash |
| B2 | parent session → child | agent definition, task text, grants | grants computed fail-closed; task via stdin; no shell anywhere |
| B3 | child → parent | child output, usage, errors | capped, parsed as data, returned only as a tool result; no auto-triggered turns |
| B4 | child → host OS | granted tools (`bash`, `write`, …) | file tools path-confined to the run scope (invariant 11); unsandboxed `bash`/subprocess refused unless the ceiling is `/`; optional `sandbox: os` for bash |
| B5 | definition file on disk → run | mid-session file edits | definitions pinned at `session_start`; hash re-verified at run time |

---

## 2. Enforced

### B1 — repository content cannot reach a child

- **Settings.** The child's `SettingsManager` is built in memory from
  `<agentDir>/settings.json` **read directly**. `SettingsManager.create(cwd, …)`
  is never called for a child, so no code path can observe a project settings
  file — this is the structural fix for the audited piolium P-01 finding, where
  a repo-controlled `shellCommandPrefix`/`shellPath` gave unconditional host code
  execution. `shellCommandPrefix`, `shellPath`, `packages`, `extensions`,
  `skills`, `prompts` and `themes` are stripped even from the global file.
- **Resources.** `DefaultResourceLoader` is constructed with `noExtensions`,
  `noSkills`, `noPromptTemplates`, `noThemes` and `noContextFiles` all `true`,
  and its `cwd` is the agent dir, not the target repository. A hostile
  `.pi/skills/**` or `AGENTS.md` cannot reach the child system prompt — the
  structural fix for P-02.
- **Sessions.** `SessionManager.inMemory()` — no session file, no transcript,
  nothing written under the target repository.
- **Project agents.** Gated behind explicit approval with per-file SHA-256.

### B2 — capability grants are computed, never inferred

The grant contract is total and non-additive:

| Declaration | Effective tools |
| --- | --- |
| `tools: [read, grep]` | `{read, grep}` exactly |
| `tools: []` | ∅ |
| `tools` absent + `tools_inheritance: none` (default) | ∅ |
| `tools` absent + `tools_inheritance: parent` | parent active tools minus spawn-capable names |

There is **no** `disallowed_tools` field: the allowlist is the entire contract,
so a deny list can never silently no-op. An empty grant set always becomes
`noTools: "all"`, so "no declaration" can never mean "everything".

Additional fail-closed rules:

- An explicit tool name that does not resolve in the child **refuses the run**.
- An inherited name that does not resolve is dropped with a diagnostic.
- A grant of any spawn-capable name (`mx_pi_agent`, `subagent`,
  `spawn_subagent`, `subagent_task`, `Task`) **refuses the run**. The
  main-session `delegate` flag never reaches this path, so it can never place a
  spawn-capable name in a child grant.
- An unknown frontmatter field **drops the whole definition**.
- Any parse error drops the definition. There is no branch that yields
  "unrestricted" as a fallback.

### B3 — child output is data

- `mx_pi_agent` results are returned as a tool result only, so a completed child
  cannot trigger a parent turn and cannot cross a session boundary.
- The one caller that does deliver a message is the user-initiated `#` directive.
  It runs through the same `planRun` path (trust gate, hash re-verification,
  budgets, path scope), and only `source: "interactive"` input is intercepted;
  RPC and extension-injected input can never reach it. A directive is a new
  caller of the existing run path, not a new capability.
- Output is capped per result (32 KiB) and in aggregate (128 KiB), with an
  explicit truncation marker.
- Output is redacted for credential-shaped values from the environment before it
  is returned.
- Child telemetry (see below) is a publish-only channel on `pi.events`; it is not
  a second delivery path. Envelopes are never appended to the parent transcript,
  never trigger a turn, and are dropped when nothing subscribes.

### Child telemetry

Delegated agents run in child sessions that load no extensions, so a parent
session tracer cannot observe them. To close that gap without weakening B1, each
child loads exactly one **inline** extension constructed in-process by the runner
(inline factories bypass `noExtensions`, but nothing here is discovered from
disk) that re-publishes the child's lifecycle events on `pi.events`. It
registers no tools, so the child's grant set is unchanged, and it is a pure
observer: it returns nothing and mutates nothing, so it cannot alter the child's
run.

Residual: the payload is the child's raw extension events, which include
provider request payloads and assistant messages. Any extension loaded in the
parent session can subscribe. Extensions already execute arbitrary in-process
code, so this is not an escalation, but the audience for prompt/tool data widens
from the parent extension alone to all loaded extensions. Nothing is captured
unless a consumer subscribes, and nothing is written to disk. The subprocess
runner is a separate process and publishes nothing.

### B4 — granted file tools are path-confined to the run scope

A granted file tool (`read`, `write`, `edit`, `grep`, `find`, `ls`) is built by
pi's own factory and wrapped so its path argument is checked against the run
scope before pi's implementation runs. An out-of-scope read, write or search is
refused; an absent or empty path means the run's cwd, never "unbounded".
`grep`/`find` confine the search *root* — their operations never see it, which is
why enforcement is at `ToolDefinition.execute` rather than the operations hook.

Scope model:

- Default scope is `[cwd]`. There is no implicit ancestor, `$HOME`, temp dir or
  agent dir.
- The config `scope` is a ceiling. A definition's `scope` tightens it, never
  loosens it. `scope: []` is a refusal, an ancestor of cwd is a refusal, and an
  entry outside the ceiling or one that does not resolve to a directory is a
  refusal.
- A vector that cannot be path-confined — unsandboxed `bash`, or
  `isolation: subprocess` — is refused (`scope-unenforceable`) unless the ceiling
  is an explicit `/`. That single typed declaration is the only way to license an
  unconfined run.
- Containment reuses `isPathContained` (`src/security.ts`), which resolves `..`,
  absolute escapes and symlink escapes through the nearest-existing realpath and
  fails closed on a missing root.

`sandbox: os` is an opt-in per-agent wrapper for the `bash` tool only:
`sandbox-exec` with a generated seatbelt profile on macOS, `bwrap` on Linux. It
reads only the run scope plus an immutable system runtime allowance — the system
runtime, the resolved JavaScript toolchain directories, and the library
directories (`bin`, `lib`, `opt`, `Cellar`, `etc`) of the package manager prefix
that installed the runtime (see Section 3) — and writes only under the run scope;
network is denied. If no backend is available the run is **refused**, never
silently unsandboxed.

### B5 — definitions are pinned

- Every definition is read and hashed at `session_start`; the pinned body is what
  the policy layer uses.
- At spawn the file is re-read and re-hashed. A missing file or a changed hash
  refuses the run ("definition changed since session start").
- Gated approvals store the exact approved hash. Any edit invalidates the
  approval and requires re-approval.

### B6 — main-session switches are pinned and fail-closed (invariants 12–18)

A main-session definition can mutate the **main** session's system prompt,
active tools, model and thinking level. The same pinning guarantees apply:

- **12 — override provenance.** A main-session prompt override comes only from
  the session's base options or from a pinned definition of a trusted or
  approved source. `before_agent_start` re-reads the pinned definition and
  re-hashes the file on every turn; a missing file or a changed hash
  deactivates the switch and the base prompt is used. There is no branch that
  keeps a stale override.
- **13 — exact restore.** `#none` restores the pre-switch baseline (tools,
  model, thinking) and the base prompt. A baseline value that no longer resolves
  is skipped with a warning; the rest is still restored and the base prompt is
  always reached.
- **14 — main-only definitions never become children.** `planRun` refuses a
  `main_agent_only: true` definition before any child session is created, so the
  tool, parallel, chain and pipeline paths all refuse alike.
- **15 — prompt-mode parsing is total.** Absent `system_prompt` means `append`;
  an unknown or non-string mode drops the definition with a diagnostic; a
  definition that sets both `sub_agent_only` and `main_agent_only` is dropped as
  mutually exclusive; the reserved name `none` drops the definition so the reset
  can never be shadowed.
- **16 — presentation.** Switch-derived UI text (status, notifications, roster,
  autocomplete badges) is control-character stripped like all other
  definition-derived text.
- **17 — no child capability change.** A switch mutates main-session runtime
  state only. Child grants continue to come from the unmodified `planRun`
  contract; a switch can never widen a child's tool set.
- **18 — `delegate` is a main-session verb.** A `delegate: true` definition
  keeps `mx_pi_agent` in the active main-session tool set, so an orchestrator
  can call specialists in sequence. It is read only by `planSwitch`, which runs
  only for main-session definitions in the main session. No code path
  lets `delegate` place `mx_pi_agent` in a child grant; a child started from a
  delegating orchestrator has no spawn-capable tool (invariant 8 stands).

Switches are interactive-only. They are persisted as a non-context custom entry
and rehydrated when a session is resumed; rehydration re-derives the prompt and
only re-applies the preset when the live runtime still reflects the switch.

### Recursion

- `MX_PI_AGENTS_CHILD=1` is set in every spawned child, and the extension returns
  before registering anything when it sees that marker.
- The child has no extensions loaded, so `mx_pi_agent` does not exist inside it
  even if it were granted by name.
- Spawn-capable names are excluded from inheritance and refused as explicit
  grants.

### Presentation

All UI text derived from a definition (names, descriptions, diagnostics, tool
lists) is control-character stripped before rendering, so a definition cannot
drive the parent's terminal.

---

## 3. Not enforced

Stated plainly, because these are the boundaries an operator might otherwise
assume:

- **Prompt injection.** A child that reads attacker-controlled text can be
  influenced by it. Grants limit what the model can *do*; they do not make it
  *uninfluenced*. This is inherent to using an LLM.
- **Granted `bash` is a full shell.** Under the default ceiling, `bash` with
  `sandbox: none` is refused (`scope-unenforceable`) rather than pretended to be
  confined. `sandbox: os` narrows it to the run scope plus the system runtime
  allowance, but it is a coarse, opt-in control — not a security boundary for
  arbitrary code. Only an explicit `/` ceiling lets an unsandboxed shell run.
- **Path scope is enforced for the tools this extension supplies, and nowhere
  else.** A granted file tool cannot touch a path outside its run scope
  (invariant 11). The named exceptions are: (a) a run licensed by an explicit `/`
  ceiling, where unsandboxed `bash` or `isolation: subprocess` runs with the
  operator's full filesystem access and a definition-declared narrow scope is
  refused rather than ignored; (b) inside `sandbox: os`, the immutable macOS
  system runtime paths (the dynamic loader and `/usr`, `/bin`, `/sbin`, `/dev`,
  `/etc`) and the resolved JavaScript toolchain directories stay readable — user
  data outside the run scope does not; (c) a granted
  `bash` can still attempt anything the sandbox permits.
- **A sandboxed child can read the host's JavaScript toolchain directories.** A
  sandboxed `bash` must be able to exec `node`/`npm`/`npx`, and on most installs
  (Homebrew, nvm, fnm, volta) those live outside `/usr`, `/bin` and `/sbin`. The
  seatbelt read allowance therefore also includes the realpaths of `node`, `npm`
  and `npx`, the node install prefix, and the enclosing global `node_modules`.
  A `node` binary does not carry its dynamic dependencies, so on Homebrew the
  runtime links against sibling formulae under the package manager prefix
  (`<prefix>/opt/<formula>`, stored under `<prefix>/Cellar/<formula>`); until
  those libraries are readable, `node` aborts under dyld with `Library not
  loaded` (exit 134) before any test can start. The allowance therefore also
  adds the package manager prefix's `bin`, `lib`, `opt`, `Cellar` and `etc`
  directories when they exist — the runtime also reads its own configuration
  there, such as `<prefix>/etc/openssl@3/openssl.cnf`, and without it node aborts
  at OpenSSL initialisation (`node --version` still succeeds while every script
  fails). The prefix is derived from the running process too — the
  ancestor above `Cellar` when the binary lives in one, otherwise the install
  prefix two levels above the binary — and the home directory is explicitly
  refused as a library prefix, so an install directly in `$HOME` cannot grant
  the whole home tree. All of this is resolved through realpath rather than
  hardcoded, and it is necessary for a test runner to function inside the
  sandbox. It remains far narrower than a host-wide read: it grants the
  directories that hold the toolchain and its package-manager libraries, not
  general user data, and a candidate that does not resolve contributes nothing.
  That claim is about **content** reads, and it must not be read as "no global
  read rule at all". Content reads remain per-root and there is still no bare
  `(allow file-read*)`; what the profile now also carries is a bare
  `(allow file-read-metadata)`. That rule is metadata-only — it reveals that a
  path exists, never its contents — and it is required because path resolution
  must stat every ancestor of every path. A `(subpath X)` rule grants X and its
  descendants but says nothing about X's ancestors, so per-root metadata rules
  were rejected as a whack-a-mole that would recur whenever node resolved a path
  outside the roots: Node's loader `realpathSync`s the entry path and lstats
  `/`, `/Users`, `/Users/<user>`, `/opt` and `/opt/homebrew`, and without the
  global rule `npx`, `npm` and `node <file>` all failed with `EPERM: operation
  not permitted, lstat '/opt'` (or `lstat '/Users'`) before the script ran, while
  inline `node -e` worked because it resolves no entry file.
  Two further allowances are scratch space and a cache, not user data. The system
  temp directory (`TMPDIR`, `/tmp`, `/private/tmp`, resolved through realpath) is
  readable **and** writable, because a test runner routinely needs scratch space
  outside the project; it is world-writable sticky-bit scratch, not user data. The
  npm cache (`~/.npm`, or `npm_config_cache`) is readable but **not** writable,
  because npm reads its cache and `~/.npmrc` and a sandboxed child must not be
  able to poison a cache the unsandboxed host later reads. None of this is a
  host-wide content read, and reads are not the boundary this sandbox enforces —
  writes and network are.
- **Network egress is not enforced** except inside `sandbox: os`.
- **Approval is a decision, not a sandbox.** Approving a project agent means "I
  reviewed this definition at this hash". It does not restrict what that
  definition may declare.
- **Provider and LLM trust.** Prompts and file contents are sent to the
  configured provider. That is outside this extension's control.
- **The pi host platform.** A malicious pi build, extension, or model provider is
  outside scope.
- **Process-level isolation.** Children run in the same process (in-process
  runner) or as a child process with the operator's privileges (subprocess
  runner). Neither is a container. Use pi's container/micro-VM guidance when the
  work itself is untrusted.

### Residual risk

- Budgets bound *cost* and *duration*, not *damage*: within a budget, a granted
  tool is a granted tool.
- An in-process child shares the parent's process. A crash or a bug in the SDK
  affects the parent session. The subprocess runner does not have this property;
  choose `isolation: subprocess` when that matters.
- The temp system prompt for a subprocess child is `0600` in a `0700` directory
  and is removed in `finally`, but a determined local attacker with the same UID
  could read it while the child runs. It contains no secrets by construction
  beyond the definition body the operator already has on disk.
- Within `sandbox: os`, the system temp directory (`TMPDIR`, `/tmp`,
  `/private/tmp`, resolved through realpath) is readable **and** writable. A test
  runner routinely needs scratch space outside the project; this is world-writable
  sticky-bit scratch, not user data, and it is the only write location beyond the
  run scope.
- Within `sandbox: os`, the npm cache (`~/.npm`, or `npm_config_cache`) is
  readable but deliberately not writable. npm reads its cache and `~/.npmrc`; it
  is read-only so a sandboxed child cannot poison a cache the unsandboxed host
  later reads. These read allowances remain far narrower than a host-wide read,
  and reads are not the boundary this sandbox enforces — writes and network are.
- Approval entries expire after 180 days and are pruned when the file they refer
  to no longer exists.

---

## 4. Decisions log

| Decision | Rationale |
| --- | --- |
| No `disallowed_tools` field | A deny list can silently no-op against an allowlist; a single total allowlist cannot. |
| Empty `tools:` means ∅, not "all" | An empty list is a declaration of intent. "All" must be written explicitly as `tools_inheritance: parent`. |
| Unknown field drops the definition | Silently ignoring a field the author believed was in effect is how grants widen unnoticed. |
| Global-only settings for children | Reading a project settings file at all is the vulnerability; not passing a cwd removes the code path instead of filtering its output. |
| Definition hash pinned at session start | A file edit between review and execution is the classic TOCTOU; re-hashing at spawn closes it. |
| Trusted definitions beat gated ones regardless of scan order | A repo must not be able to shadow a globally installed agent by declaring the same name. |
| Spawn-capable tools refused, not stripped | Silently removing a grant hides an authoring mistake; refusing makes it visible. |
| Task over stdin, prompt via temp file | `argv` is world-readable via `ps` and has a hard length limit. |
| No background runs in v1 | Completion delivery that can cross sessions or auto-trigger turns is a confused-deputy risk; deferred to a design that keeps delivery session-scoped. |
| `#` directives reuse the tool's plan/run path | A directive is a second caller, not a second capability: it reaches a child only through `planRun`, and only interactive input is intercepted. The synchronous, interactive-only handler keeps delivery session-scoped. |
| Child telemetry rides `pi.events`, not the transcript | A tracer needs the child's events, not its output. Publishing on the shared extension bus keeps B3 intact (no turn, no transcript entry, no session boundary crossed) and needs no changes to the child's isolation: the emitter is an in-process inline extension, so B1 still holds. |
| `sandbox: os` refuses when unavailable | A sandbox that silently degrades to unsandboxed execution is worse than no sandbox, because it is trusted. |
| Default scope is `[cwd]` | A missing declaration must mean the run's own directory, never "everything". Absent and empty stay distinct: absent is cwd, `scope: []` is a refusal. |
| A vector that cannot be path-confined is refused | Unsandboxed `bash` and `isolation: subprocess` have no hook this extension can check, so the run is refused (`scope-unenforceable`) unless the operator types the explicit `/` ceiling. Pretending to confine them would make invariant 11 false. |
| A `/` ceiling overrides the cwd default only for unconfineable vectors | It is the one typed "unrestricted" declaration. A definition-declared narrow scope combined with an unconfineable vector is still refused: a definition may tighten, never loosen. |
| macOS read narrowing uses the `system.sb` import plus the run scope | Hand-listing runtime paths (`/usr`, `/System`, dyld, …) aborts bash: seatbelt needs the rest of the system runtime surface. `system.sb` grants process startup but not user data, so content reads outside the run scope (`$HOME`, `~/.pi`, another project, another temp dir) stay denied. The named exceptions are the global metadata-only read, the readable/writable system temp directory, and the read-only npm cache (see Section 3). |
| Enforcement at `ToolDefinition.execute`, not the operations hook | pi's `GrepOperations`/`FindOperations` never receive the model-supplied search root, so wrapping operations cannot confine grep/find. `execute` sees every raw argument; an unrecognized shape is refused, never passed through. |
| Child settings manager refuses an empty agent dir | `join("", "settings.json")` resolves against `process.cwd()`. Found during the hardening review: the runner was constructed with `agentDir: ""`, which would have read the target repository's settings. The manager now throws instead of resolving, and `index.ts` threads a single resolved dir everywhere. Regression tests: `src/security.test.ts` (invariant 1) and `src/runners/in-process.test.ts`. |

---

## 5. Sandbox usage

```markdown
---
name: careful-builder
description: Build with a sandboxed shell
tools: [read, grep, find, ls, edit, write, bash]
sandbox: os
---
```

- macOS: requires `/usr/bin/sandbox-exec` (present on stock macOS).
- Linux: requires `bwrap` (bubblewrap) on `PATH`.
- The sandbox reads the system runtime allowance, the run scope and a global
  metadata-only rule, and writes only under the run scope plus the system temp
  directory. Network is denied. Path resolution must stat every ancestor of every
  path, so a bare `(allow file-read-metadata)` is present — metadata only, never
  contents; content reads stay per-root and there is no bare
  `(allow file-read*)`. On macOS the allowance is the built-in `system.sb`
  profile plus `/usr`, `/bin`, `/sbin`, the resolved JavaScript toolchain
  directories, the library directories (`bin`, `lib`, `opt`, `Cellar`, `etc`) of
  the package manager prefix that installed the runtime, and the system temp
  directory, so `node`/`npm`/`npx` can exec, dyld can load the runtime's dynamic
  dependencies, and node can read its own configuration there (on Homebrew
  `<prefix>/etc/openssl@3/openssl.cnf`, without which OpenSSL initialisation
  aborts); the npm cache (`~/.npm`, or `npm_config_cache`) is readable but not
  writable, so a sandboxed child cannot poison a cache the host later reads. The
  temp directory is readable and writable — scratch space a runner needs; user
  data outside the run scope is denied. On Linux the allowlisted system roots are
  `--ro-bind` read-only, the run scope is bind-mounted writable, and `--tmpfs
  /tmp` provides the scratch space (unchanged).
- `/mx-pi-agents status` reports whether a backend is available.
- If no backend is available, any run requesting `sandbox: os` is refused with
  `sandbox-unavailable`.

---

## 6. Reporting

Report suspected vulnerabilities privately via the repository's security
advisory form: <https://github.com/rennis23/pi-mono/security/advisories/new>.

Please include the definition file, the config, and the exact tool call that
reproduces the issue. Do not open a public issue for a security report.
