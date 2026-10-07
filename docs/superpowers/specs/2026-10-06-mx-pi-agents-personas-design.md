# mx-pi-agents personas design

## Context

`packages/mx-pi-agents` is extracted from the persona subset of the
`agents-v1-patch-3` branch of the same package. That branch implements a secure
subagent runner (tool, pipelines, budgets, sandbox, path scope, telemetry), plus
a main-session persona switch. Only the persona switch is in scope here; the
subagent surface is dropped. The package name, command, flags, config file and
entry type are reused, so the trimmed package supersedes the source branch rather
than coexisting with it.

This document captures the trimmed design and the mode renames. The source spec
(if any) lives only on `agents-v1-patch-3`.

## Locked decisions

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Scope | Main-session persona switching with preset + resource filters. No subagents, no `mx_pi_agent` tool, no `#[…]` pipelines, no budgets, no sandbox, no path scope, no telemetry, no progress widget. |
| 2 | Mode field | Frontmatter field renamed `kind` → `system_prompt`; values renamed `persona` → `replace`, `main` → `append`. `system_prompt` accepts only `replace` or `append`; absent = `append`. |
| 3 | Discovery | Bundled `agents/`, global `<agentDir>/agents`, config `agentPaths`, project `<cwd>/.pi/agents`. Bundled/global are trusted; config/project are gated by the hash-approval ledger in `<agentDir>/extensions/mx-pi-agents.json`. |
| 4 | Settings | One field registered with `@rennis23/mx-pi-settings`: `defaultPersona` (string), applied at session start. `agentPaths` / approvals stay in the local JSON. |
| 5 | Bundled definitions | Ship `agents/socrates.md` only, converted to `system_prompt: replace`. |
| 6 | Name | The trimmed extraction reuses the `mx-pi-agents` name (directory, npm name, command, flags, config file, entry type). It supersedes the `agents-v1-patch-3` package rather than coexisting with it. |

## Content changes vs the source package

| Concept | Source (`agents-v1-patch-3`) | New (trimmed) |
| --- | --- | --- |
| Package dir / npm name | `packages/mx-pi-agents` / `@rennis23/mx-pi-agents` | same |
| Command / flags | `/mx-pi-agents`, `--mx-pi-agents-list`, `--mx-pi-agents-disable` | same |
| Config file | `mx-pi-agents.json` | same |
| Session entry type | `mx-pi-agents.switch` | same |
| Frontmatter | `kind: persona\|main` | `system_prompt: replace\|append` |
| Internal type | `AgentKind = "persona"\|"main"` | `SystemPromptMode = "replace"\|"append"` |
| Plan/entry field | `kind` | `mode` |
| Status key | `mx-pi-agents-persona` | `mx-pi-agents` |
| Status value | `persona:<name>` / `main:<name>` | `replace:<name>` / `append:<name>` |
| Child marker | `MX_PI_AGENTS_CHILD` | dropped (no children) |
| Directive message type | `mx-pi-agents.directive` | dropped (no delegation results) |
| Settings id | — (not a settings provider) | `mx-pi-agents` |

## Modules

- `frontmatter.ts`, `security.ts`, `resources.ts` — pure helpers, copied (security trimmed to `sanitizeUiText`/`sha256Hex`).
- `types.ts` — trimmed to the persona contracts (`SystemPromptMode`, `SwitchPlan.mode`, `SwitchEntryData.mode`).
- `schema.ts` — validates `name`, `description`, `system_prompt`, `tools`, `skills`, `context_files`, `model`, `thinking`, body.
- `registry.ts` — discovery precedence, hashing, shadowing, `verifyPinned`.
- `config.ts` — `agentPaths`, `approvals`, atomic store, `resolveAgentPath`.
- `trust.ts` — `checkTrust`, `approvalRequest`, `recordApproval`, `withApprovals`, `gatedAgents`.
- `persona.ts` — `dispatchDirective`, `planSwitch`, `planReset`, `snapshotBaseline`, `rehydrate`.
- `directive.ts` — single-name `#name [task]` / `#none` grammar; `#[…]` is an error.
- `complete.ts` — `#`-prefix autocomplete; badge renders `[replace]`/`[append]`; built-in `pi.dev [base]` row.
- `render.ts` — `renderRosterLines`, `formatSwitchNotice`, `renderDirectiveMessage`, `renderDiagnostics`.
- `index.ts` — registration, settings, `session_start`, `before_agent_start`, `input`, `/mx-pi-agents`.

Dropped from the template: `budget.ts`, `concurrency.ts`, `modes.ts`, `output.ts`,
`progress.ts`, `prompt.ts`, `policy.ts`, `runner.ts`, `runners/*`, `telemetry.ts`,
`scope.ts`, and all their tests.

## Semantics

- **Directive grammar**: `#name [task]` and `#none`. `#[…]` is rejected with a
  message; input starting with `#` is never forwarded to the model.
- **Dispatch**: unknown name → refusal; `replace`/`append` → main-session switch;
  gated source → approval first; `none` + task → refusal ("takes no task").
- **Switch preset**: applies only fields present in the definition (`tools`,
  `model`, `thinking`); resolves fail-closed (unknown tool or unavailable model
  refuses the whole switch); captures a session baseline before the first
  switch; `#none` restores it, dropping values that no longer resolve with a
  warning.
- **Prompt effect**: `replace` = `systemPromptOptions.customPrompt`; `append` =
  joined `systemPromptOptions.appendSystemPrompt`. No `forceSystemPrompt`, no
  return of a whole `systemPrompt`.
- **Resource filters**: absent = all loaded entries, `[]` = none, list =
  allow-list; applied per turn while the switch is active.
- **Persistence**: `pi.appendEntry("mx-pi-agents.switch", …)`; rehydrated on
  resume; preset re-applied only when the runtime still matches the baseline or
  the applied state.
- **Default persona**: applied at session start only when no switch rehydrated;
  `#none` still works and is itself persisted.

## Consequences

- The trimmed package reuses the `mx-pi-agents` name and path. The source branch
  can no longer be merged or published alongside it; a future merge conflicts
  across nearly every file.
- The settings hub has no list field type, so `agentPaths` stays in the local
  JSON; only `defaultPersona` is exposed.
- A gated persona that is later edited refuses to re-apply;
  `before_agent_start` deactivates it with a one-time warning and the base
  prompt continues.
