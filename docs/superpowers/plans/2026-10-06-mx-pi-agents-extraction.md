# Plan: extract the persona subset of `mx-pi-agents` from `agents-v1-patch-3`

- **Date:** 2026-10-06
- **Target branch:** `agents-v2` (created from `master`/`persona` @ `397ed8a`)
- **Source branch:** `agents-v1-patch-3` @ `af5fac8`
- **Source package:** `packages/mx-pi-agents/` (`@rennis23/mx-pi-agents`)
- **Target package:** `packages/mx-pi-agents/` (`@rennis23/mx-pi-agents`) — same name, trimmed feature set
- **Status:** Ready for implementation

## 1. Locked decisions

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Scope | Main-session persona switching with preset + resource filters. No subagents, no `mx_pi_agent` tool, no `#[…]` pipelines, no budgets, no sandbox, no path scope, no telemetry, no progress widget. |
| 2 | Mode field | Frontmatter field renamed `kind` → `system_prompt`; values renamed `persona` → `replace`, `main` → `append`. `system_prompt` accepts only `replace` or `append`; absent = `append`. |
| 3 | Discovery | Same layout as the template: bundled `agents/`, global `<agentDir>/agents`, config `agentPaths`, project `<cwd>/.pi/agents`. Bundled/global are trusted; config/project are gated by the existing hash-approval ledger, stored in a local `<agentDir>/extensions/mx-pi-agents.json`. |
| 4 | Settings | One field registered with `@rennis23/mx-pi-settings`: `defaultPersona` (string), applied at session start. `agentPaths` / approvals stay in the local JSON (no settings UI in this cut). |
| 5 | Bundled definitions | Ship `agents/socrates.md` only, converted to `system_prompt: replace`. |
| 6 | Name | The trimmed extraction reuses the `mx-pi-agents` name (directory, npm name, command, flags, config file, entry type). It supersedes the `agents-v1-patch-3` package rather than coexisting with it. |

## 2. Content changes vs the source package

The package name and its public surface are reused, so only the feature set and the mode vocabulary change.

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

## 3. Target package layout

```text
packages/mx-pi-agents/
├── agents/
│   └── socrates.md
├── src/
│   ├── complete.ts / complete.test.ts
│   ├── config.ts / config.test.ts
│   ├── directive.ts / directive.test.ts
│   ├── frontmatter.ts / frontmatter.test.ts
│   ├── persona.ts / persona.test.ts
│   ├── registry.ts / registry.test.ts
│   ├── render.ts / render.test.ts
│   ├── resources.ts / resources.test.ts
│   ├── schema.ts / schema.test.ts
│   ├── security.ts / security.test.ts
│   ├── trust.ts / trust.test.ts
│   └── types.ts
├── test/
│   ├── fixtures.ts
│   ├── fs.ts
│   └── harness.ts
├── index.ts
├── index.test.ts
├── src/bundled-agents.test.ts
├── CHANGELOG.md
├── LICENSE
├── package.json
├── README.md
└── SECURITY.md
```

Dropped from the template (never copied): `budget.ts`, `concurrency.ts`, `modes.ts`, `output.ts`, `progress.ts`, `prompt.ts`, `policy.ts`, `runner.ts`, `runners/*`, `telemetry.ts`, `source-structure.test.ts`, and all their tests.

## 4. Implementation steps

### Step 1 — Scaffold the workspace package

1. Use the existing `packages/mx-pi-agents/` directory on this branch. It currently holds only an ignored `node_modules/` left over from the other branch; add the package files alongside it (`agents/`, `src/`, `test/`, `index.ts`, docs).
2. Copy `LICENSE` from `packages/mx-pi-settings/`.
3. Add `package.json` modeled on `mx-pi-context-stats`:
   - `name: "@rennis23/mx-pi-agents"`, `version: "0.1.0"`, `"type": "module"`, public `publishConfig`.
   - `files`: `index.ts`, `src/**/*.ts`, `!src/**/*.test.ts`, `agents/**/*.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`.
   - `pi.extensions: ["./index.ts"]`.
   - `dependencies: { "@rennis23/mx-pi-settings": "^0.1.0" }`.
   - `peerDependencies`: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.80.0`; dev deps at `^1.0.3` (match the current workspace).
   - No `typebox` (no tool is registered).
4. Add `CHANGELOG.md` with an `## [Unreleased]` section, and `SECURITY.md` containing the package-policy phrases (`threat`, `enforced`, `not enforced`, `residual`, `report`).
5. Run `npm install` so npm workspaces relinks the package and updates `package-lock.json`.

### Step 2 — Port pure modules (source `agents-v1-patch-3`, trim to scope)

Use `git show agents-v1-patch-3:<path> > packages/mx-pi-agents/<path>` as the starting point, then edit.

| File | Action |
| --- | --- |
| `src/frontmatter.ts` + test | Copy verbatim. |
| `src/security.ts` + test | Copy verbatim (`sanitizeUiText`, `sha256Hex`, `isPathContained` kept only if still referenced by config/trust). |
| `src/resources.ts` + test | Copy verbatim. |
| `src/types.ts` | Trim to: `ThinkingLevel`, `SystemPromptMode`, `SourceKind`, `AgentDefinition`, `AgentSource`, `PinnedAgent`, `AgentDiagnostic`, `RegistrySnapshot`, `SwitchBaseline`, `SwitchApplied`, `SwitchPlan`, `SwitchEntryData`. Delete `AgentKind`, `IsolationMode`, `SandboxMode`, `ToolsInheritance`, `RunPlan`, `RunResult`, `RunOptions`, `Budgets`, `TokenUsage`, `Refusal`, `RefusalReason`, `PlanOutcome`, `zeroUsage`. |
| `src/schema.ts` + test | Keep: `name`, `description`, `system_prompt`, `tools`, `skills`, `context_files`, `model`, `thinking`, body. Drop: `kind`, `scope`, `tools_inheritance`, `max_turns`, `timeout_ms`, `token_budget`, `cost_budget`, `isolation`, `sandbox`, `delegate`, spawn-tool list. `system_prompt` accepts only `replace`/`append`; absent = `append`; anything else drops the definition with a diagnostic. Keep reserved name `none`. |
| `src/registry.ts` + test | Keep discovery precedence, hashing, shadowing, `verifyPinned`. Registry dirs stay `{ agentDir, cwd, agentPaths, bundledDir? }`. |
| `src/config.ts` + test | Keep `ApprovalEntry`, `ApprovalLedger`, `agentPaths`, `approvals`, atomic store, `resolveAgentPath`, `createConfigStore`. Drop `scope`, `limits`, `Budgets` references. `CONFIG_FILE_NAME` stays `"mx-pi-agents.json"`. |
| `src/trust.ts` + test | Keep `checkTrust`, `approvalRequest`, `recordApproval`, `withApprovals`, `gatedAgents`, `storedApproval`, `approvalMatches`. Approval summary drops isolation/sandbox; `mainPromptConsequence` uses `replace`/`append`. |
| `src/persona.ts` + test | `dispatchDirective` loses the `delegate` branch (`replace`/`append` switch, `none` reset, unknown/gated refuse). `planSwitch` loses all `delegate`/`DELEGATE_TOOL` logic; takes `SystemPromptMode`; fail-closed tools/model resolution stays. `SwitchPlan.mode`, `SwitchEntryData.mode`. `lastSwitchEntry` still matches `mx-pi-agents.switch`. `parseSwitchEntry`/`rehydrate` validate `replace`/`append`. |
| `src/directive.ts` + test | Single-name grammar only: `#name [task]`, `#none`. A `#[…]` input returns a "delegation was removed in mx-pi-agents" style error without reaching the model. Return shape simplifies to `{ name, task }`. |
| `src/complete.ts` + test | Keep the `#`-prefix context and filtering. Drop pipeline mode. Badge renders `[replace]`/`[append]`; keep the built-in `pi.dev [base]` → `#none` row. |
| `src/render.ts` + test | Keep `renderRosterLines`, `formatSwitchNotice` (mode `"replace"\|"append"\|"base"`), `renderDirectiveMessage`, `renderDiagnostics`. Drop run/tool rendering and `AgentToolDetails`. |
| `test/fs.ts` | Copy verbatim. |
| `test/fixtures.ts` | Trim `MakeAgentOptions` to the new frontmatter fields; emit `system_prompt`; drop policy/scope/budget/isolation options. |
| `test/harness.ts` | Trim to the persona surface: `pi.on`, `pi.registerFlag`, `pi.registerCommand`, `pi.getFlag`, `getActiveTools`/`setActiveTools`, `getAllTools`, `getThinkingLevel`/`setThinkingLevel`, `setModel`, `appendEntry`, `sessionManager.getBranch`, `pi.events` bus, `ctx.ui.*` (notify/confirm/setStatus/addAutocompleteProvider/theme), `ctx.modelRegistry`. Drop tool registry, child-run helpers, telemetry. |

### Step 3 — Write the new `index.ts` wiring

No tool, no delegation, no progress widget, no telemetry. Handlers:

1. **Registration**: `--mx-pi-agents-list` (boolean), `--mx-pi-agents-disable` (boolean), `/mx-pi-agents` command, and the mx-pi-settings provider.
2. **Settings**: `registerSettings<PersonasSettings>(pi, { id: "mx-pi-agents", title: "Agents", fields: [{ key: "defaultPersona", label: "Default persona", type: "string", default: "", placeholder: "e.g. socrates", maxLength: 64 }], onChange })`. `onChange` stores the value and best-effort re-applies it live when a session context exists.
3. **`session_start`**: load config + pin roster; notify warnings; `rehydrateSwitch`; if no active switch, resolve `defaultPersona` (empty = plain pi; unknown = notify + stay plain; gated = approval flow; then verify pin, `planSwitch`, `applySwitchPlan`); print roster when `--mx-pi-agents-list`; register `#` autocomplete in TUI.
4. **`before_agent_start`**: when a switch is active, re-verify the pinned hash (deactivate once with a warning if removed/changed); for `replace` set `options.customPrompt = body`, for `append` append the body to `options.appendSystemPrompt` with `\n\n`; apply `skills`/`context_files` allow-lists via `filterSkills`/`filterContextFiles`.
5. **`input`** (interactive only): parse directive → refuse malformed; refuse images/streaming; `none` resets; unknown refuses; gated runs the approval flow; verify pin; `planSwitch` (fail closed); `applySwitchPlan`; with a task return `{ action: "transform", text: task }`, otherwise `{ action: "handled" }` with an info notice. `--mx-pi-agents-disable` returns `continue`.
6. **`/mx-pi-agents`**: `list` (roster + mode + source + pin hash), `approve [name]` (dialog or headless refusal), `status` (config path, roster counts, gated counts, active persona, default persona), `refresh` (re-pin).
7. **Status/entry keys**: `mx-pi-agents` status, `mx-pi-agents.switch` entry type.
8. Preserve the template's fail-closed and best-effort error handling (every pi/UI call wrapped so a disposing session cannot crash a turn).

### Step 4 — Bundled definition

1. Copy `agents/socrates.md` and change `kind: persona` → `system_prompt: replace`; keep `tools: []`, `skills: []`, `context_files: []`.
2. Rewrite `src/bundled-agents.test.ts` to assert: exactly `socrates` ships; the file parses with no warnings; `system_prompt === "replace"`; `tools/skills/contextFiles` are empty; file stem matches frontmatter name.

### Step 5 — Tests

1. Port module tests listed in Step 2; update fixtures and expectations for the renames.
2. Rewrite `index.test.ts` against the trimmed harness, covering: registration; session_start pin; default persona applied/unknown/gated; `#name` switch (`replace` + `append`) with/without task; `#none` reset and baseline restore; unknown/gated/malformed refusals; disable flag; non-interactive passthrough; streaming/images refusals; `before_agent_start` prompt mutation and allow-lists; hash change deactivation; rehydration on resume; autocomplete items; `/mx-pi-agents` subcommands.
3. Mock the settings SDK in `index.test.ts` with `vi.mock("@rennis23/mx-pi-settings", …)` so `defaultPersona` is controllable without a hub.

### Step 6 — Docs and repo integration

1. `README.md`: purpose, scope boundary (no delegation), install, `/mx-pi-agents`, `#name`/`#none` grammar, frontmatter reference (`system_prompt`, `tools`, `skills`, `context_files`, `model`, `thinking`), discovery dirs, approval behavior, settings field, local JSON (`agentPaths`), flags.
2. `SECURITY.md`: trimmed threat model — trust boundaries of gated definitions, hash pinning, fail-closed switching, what is explicitly not enforced (a persona can change tools/model; project files require approval).
3. `CHANGELOG.md`: `[Unreleased]` entry describing the initial extraction.
4. Add `docs/superpowers/specs/2026-10-06-mx-pi-agents-personas-design.md` capturing the trimmed design and the mode renames (the source spec is only on `agents-v1-patch-3`).
5. Update the root `README.md` package list with `mx-pi-agents`.
6. Leave the ignored `packages/mx-pi-agents/node_modules/` as-is; `npm install` manages it.

## 5. Semantics reference (normative for the new package)

- **Directive grammar**: `#name [task]` and `#none`. `#[…]` is rejected with a message; input starting with `#` is never forwarded to the model.
- **Dispatch**: unknown name → refusal; `replace`/`append` → main-session switch; gated source → approval first; `none` + task → refusal ("takes no task").
- **Switch preset**: applies only fields present in the definition (`tools`, `model`, `thinking`); resolves fail-closed (unknown tool or unavailable model refuses the whole switch); captures a session baseline before the first switch; `#none` restores it, dropping values that no longer resolve with a warning.
- **Prompt effect**: `replace` = `systemPromptOptions.customPrompt`; `append` = joined `systemPromptOptions.appendSystemPrompt`. No `forceSystemPrompt`, no return of a whole `systemPrompt`.
- **Resource filters**: absent = all loaded entries, `[]` = none, list = allow-list; applied per turn while the switch is active.
- **Persistence**: `pi.appendEntry("mx-pi-agents.switch", …)`; rehydrated on resume; preset re-applied only when the runtime still matches the baseline or the applied state.
- **Default persona**: applied at session start only when no switch rehydrated; `#none` still works and is itself persisted.

## 6. Acceptance criteria (DoD)

- [ ] `npm run check` passes (Biome + tsc).
- [ ] `npm test` passes; new tests co-located.
- [ ] `npm run security:packages` passes (required files, tarball contents, SECURITY.md phrases, `[Unreleased]` changelog).
- [ ] `npm run mutation:changed` completes for the new package with no unacceptable survivors.
- [ ] `git status` shows only intended files; no plan/todo files inside the package tarball.
- [ ] Manual smoke: `pi -e ./packages/mx-pi-agents` with a temp `<agentDir>/agents/*.md`, verify `#name`, `#name task`, `#none`, footer status, autocomplete, and `defaultPersona` via `--mx-pi-settings-set 'mx-pi-agents.defaultPersona=x'`.

## 7. Risks / notes

- **The trimmed package reuses the `mx-pi-agents` name and path.** The `agents-v1-patch-3` package can no longer be merged or published alongside it; that branch is superseded by this extraction. A future merge would conflict across nearly every file. Confirm the WIP branch is discarded before publishing.
- The settings hub has no list field type, so `agentPaths` intentionally stays in the local JSON; only `defaultPersona` is exposed. Document this clearly.
- A gated persona that is later edited refuses to re-apply; `before_agent_start` deactivates it with a one-time warning and the base prompt continues.
- `source-structure.test.ts` from the template is not portable (it asserts the child-marker invariant); replace its useful part with a small structural test that `index.ts` contains no `registerTool(` and no `#[` pipeline path.
- Keep the `#` autocomplete provider delegating to the current provider outside a directive, so built-in completion is never shadowed.
