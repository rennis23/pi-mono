# Security — `@rennis23/mx-pi-agents`

This document states what the extension enforces, what it does **not** enforce,
and why. A boundary that is not enforced is named as such rather than implied by
omission. The implementation and its co-located tests are the authoritative
evidence for every claim below.

---

## 1. Threat model

**Assets.** The main session's system prompt, active tool set, selected model and
thinking level; the operator's provider credentials and quota; the integrity of
the target repository, which a switched persona can read through the host tools
pi already granted.

**Adversary.**

1. Anyone who controls content in the target tree, including `<cwd>/.pi/agents/**`
   and symlinks.
2. A third-party agent definition, bundled, global or project-sourced.
3. Content an agent reads (source, docs, web) attempting prompt injection into
   the persona body's downstream behaviour.

**Non-goals.** This package is not a sandbox and runs no child processes. A
persona cannot spawn a subagent, cannot confine a tool to a path scope, cannot
set a token or cost budget, and does not isolate the pi host. Those controls
belong to the full `agents-v1-patch-3` design; the persona-only extraction
deliberately drops them.

| # | Boundary | Attacker control | Control that holds |
| --- | --- | --- | --- |
| B1 | definition file on disk → switch | Definition frontmatter, body, file name | Definitions are hashed at `session_start`; the pinned body is what is applied. The file is re-hashed every turn and on every switch |
| B2 | project/config directory → roster | `.pi/agents/**` and `agentPaths` entries | Gated sources require an explicit approval that pins the file's SHA-256; a gated definition never shadows a trusted name |
| B3 | definition → terminal UI | `name`, `description`, `model`, diagnostics | Every definition-derived string is passed through `sanitizeUiText` (control characters stripped) and length-capped before display |
| B4 | definition → main-session preset | `tools`, `model`, `thinking` | The preset is fail-closed: an unresolved tool or unavailable model refuses the whole switch; nothing is applied partially |
| B5 | shared settings store → extension | `defaultPersona` from the mx-pi-settings hub | The hub validates the value against the registered field bounds; the extension maps it to a pinned, gated definition rather than trusting it |

---

## 2. Enforced protections

### B1 — definitions are pinned and hash-verified

- Every definition is read and hashed at `session_start`; the pinned body is what
  `before_agent_start` applies.
- A switch re-reads and re-hashes the file before applying it. A missing file or
  a changed hash refuses the switch.
- `before_agent_start` re-verifies the active switch on every turn. A removed or
  edited file deactivates the switch with a one-time warning, and the base prompt
  is used. There is no branch that keeps a stale override.
- Persisted switch entries are validated structurally on resume
  (`parseSwitchEntry`); malformed data is ignored instead of trusted.

### B2 — gated sources require approval

- `bundled` (`agents/`) and `global` (`<agentDir>/agents/`) sources are trusted.
- `config` (`agentPaths`) and `project` (`<cwd>/.pi/agents/`) sources are gated.
  They are applied only after an explicit `ctx.ui.confirm`, which records the
  file's SHA-256 in the local ledger. Any edit invalidates the approval.
- A gated definition that would shadow a trusted name is dropped with a
  diagnostic; a repository cannot override a globally installed persona.
- Headless sessions never prompt. A gated definition without a matching stored
  approval is refused.
- A definition file whose stem does not match its `name` field is dropped.
- Unknown frontmatter fields, parse errors, a missing body and an invalid name
  all drop the definition. There is no partial acceptance and no permissive
  fallback.

### B3 — definition-derived text is control-free

- The roster, notifications, status line, autocomplete rows and approval summary
  sanitize every name, description, model and path with `sanitizeUiText`, so a
  hostile name cannot drive the terminal.
- Approval and approval-dialog bodies are built only from sanitized fields.

### B4 — the preset is total and fail-closed

- A switch applies only the fields the definition declares.
- An explicit `tools` list with any name that does not resolve in the main
  session refuses the whole switch; an unavailable `model` refuses the whole
  switch. Nothing is applied on refusal.
- `[]` means "no tools" and is honored literally.
- `#none` restores the pre-switch baseline (tools, model, thinking). A baseline
  value that no longer resolves is skipped with a warning; the rest is restored
  and the base prompt is always reached.
- A persona definition can never become a child: this package registers no tool
  and no pipeline, so there is no child path to reach.

### B5 — the settings value is validated by the hub

- `defaultPersona` is a bounded string field registered with
  `@rennis23/mx-pi-settings`; the hub trims and length-caps it against the
  declared field before the extension reads it.
- The extension treats the value as a name lookup, not as code: an empty value
  stays plain, an unknown name notifies and stays plain, and a gated name goes
  through the same approval flow as a `#name` directive.

The package artifact is checked by the repository package-policy gate and
excludes tests, fixtures, local configuration and development reports.

---

## 3. Not enforced

- **A persona can change the session's tools, model and thinking level.** That is
  the feature. `system_prompt: replace` replaces the default prompt prefix, and a
  switched definition can narrow or widen the active tool set to the tools pi
  makes available. Approve a gated definition only if you trust its body.
- **A persona is not path-confined and has no budget.** It runs in the main
  session with the host's existing grants. This package does not sandbox bash,
  does not confine file tools to a scope, and does not cap turns, time or tokens.
- **Project and config definitions require approval, but a trusted global
  definition does not.** Anything in `<agentDir>/agents/` applies without a
  prompt, exactly like a user-installed extension.
- **The hash pin detects edits, not intent.** A malicious definition that is
  approved once runs until it is edited; the pin does not re-review content.
- **The extension is not isolated from the host.** A compromised pi host or
  another loaded extension can inspect or mutate its state.
- **Terminal safety depends on the pi TUI.** Sanitization removes control
  characters but does not make arbitrary definition prose safe to act on.

---

## 4. Residual risk

A local process with write access to the pi agent directory can edit the local
JSON (`agentPaths`, `approvals`) or the shared settings document between reads.
That can add a gated search path or alter `defaultPersona`, but the gated path
still requires approval before a definition is applied, so the process gains no
capability beyond what the operator can already grant interactively.

An approved definition that changes behaviour without a file edit (for example a
bundled body whose meaning depends on external content it reads at runtime) is
not re-reviewed by the hash pin. Treat agent bodies as code you are granting the
main session.

---

## 5. Reporting

Please report vulnerabilities privately through the repository security policy
rather than opening a public issue. Include the affected package/version, a
reproduction, the boundary involved (B1–B5 above), and the expected versus
observed behaviour. See the repository-level `SECURITY.md` for the reporting
route.
