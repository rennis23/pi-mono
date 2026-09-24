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
the whole pi process. Those are what containers and micro-VMs are for, per pi's
own security documentation.

| # | Boundary | Attacker control | Control that holds |
| --- | --- | --- | --- |
| B1 | cloned repo → parent session | `.pi/settings.json`, `.pi/skills`, `.pi/agents`, symlinks | child sessions load **none** of it; project agents gated by approval + hash |
| B2 | parent session → child | agent definition, task text, grants | grants computed fail-closed; task via stdin; no shell anywhere |
| B3 | child → parent | child output, usage, errors | capped, parsed as data, returned only as a tool result; no auto-triggered turns |
| B4 | child → host OS | granted tools (`bash`, `write`, …) | pi-parity: capability grants only, documented; optional `sandbox: os` for bash |
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
  `spawn_subagent`, `subagent_task`, `Task`) **refuses the run**.
- An unknown frontmatter field **drops the whole definition**.
- Any parse error drops the definition. There is no branch that yields
  "unrestricted" as a fallback.

### B3 — child output is data

- Results are returned as a tool result only. The extension never calls
  `pi.sendMessage` or `pi.sendUserMessage`, so a completed child cannot trigger a
  parent turn and cannot cross a session boundary.
- Output is capped per result (32 KiB) and in aggregate (128 KiB), with an
  explicit truncation marker.
- Output is redacted for credential-shaped values from the environment before it
  is returned.

### B4 — pi parity for granted tools

A granted tool behaves exactly like pi's version of that tool. Safety comes from
capability grants, the trust gate, budgets and session hygiene — not from hidden
path confinement or approval dialogs. See §3 for what this does not cover.

`sandbox: os` is an opt-in per-agent wrapper for the `bash` tool only:
`sandbox-exec` with a generated seatbelt profile on macOS, `bwrap` on Linux
(write inside the working directory and temp dir only, network denied). If no
backend is available the run is **refused**, never silently unsandboxed.

### B5 — definitions are pinned

- Every definition is read and hashed at `session_start`; the pinned body is what
  the policy layer uses.
- At spawn the file is re-read and re-hashed. A missing file or a changed hash
  refuses the run ("definition changed since session start").
- Gated approvals store the exact approved hash. Any edit invalidates the
  approval and requires re-approval.

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
- **Granted `bash` is a full shell.** `bash` with `sandbox: none` can read and
  write anything the operator can, subject only to budgets. Grant it only to
  agents whose definitions you trust. `sandbox: os` narrows this to the working
  directory, but it is a coarse, opt-in control — not a security boundary for
  arbitrary code.
- **Path scope is not enforced.** A granted `read`/`write`/`edit` can touch any
  path the process can, including outside the working directory. pi has no
  path-confinement layer, and this extension does not add one.
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
| `sandbox: os` refuses when unavailable | A sandbox that silently degrades to unsandboxed execution is worse than no sandbox, because it is trusted. |
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
- The sandbox allows reads broadly (a child that cannot read the source tree is
  useless) and writes only under the working directory and the temp dir. Network
  is denied.
- `/mx-pi-agents status` reports whether a backend is available.
- If no backend is available, any run requesting `sandbox: os` is refused with
  `sandbox-unavailable`.

---

## 6. Reporting

Report suspected vulnerabilities privately via the repository's security
advisory form: <https://github.com/rennis23/pi-mono/security/advisories/new>.

Please include the definition file, the config, and the exact tool call that
reproduces the issue. Do not open a public issue for a security report.
