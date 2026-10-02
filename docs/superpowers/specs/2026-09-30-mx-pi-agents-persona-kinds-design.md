# Design: mx-pi-agents — agent kinds and main-session persona switching

**Date:** 2026-09-30
**Status:** Draft — awaiting review
**Package:** `packages/mx-pi-agents/` → `@rennis23/mx-pi-agents`
**Related:** [`2026-09-18-mx-pi-agents-design.md`](./2026-09-18-mx-pi-agents-design.md) (§4.7 anticipated this change), [`../plans/2026-09-26-mx-pi-agents-hash-directives-plan.md`](../plans/2026-09-26-mx-pi-agents-hash-directives-plan.md) (the `#` directive that landed in commit `16adcbf`)

---

## 1. Goal

Today a `#name <task>` directive always runs the named agent as a child session. This design changes
`#` into a **manual main-session switch**: a definition can replace or extend the main session's
system prompt, apply its tools/model/thinking level, and be reset to plain pi with `#none`.

Three kinds replace the current single meaning of a definition:

| kind | main session via `#` | subagent via tool / `#[…]` | prompt effect |
| --- | --- | --- | --- |
| `persona` | switch, **replaces** | **refused** | body replaces the default prompt prefix |
| `main` (**default**, field absent) | switch, **appends** | allowed | body appends to the system prompt |
| `sub` | not switchable (`#name <task>` delegates) | allowed | body is the child prompt |

The change is TUI-first (the existing input handler), session-scoped, fail-closed, and keeps the
package's existing trust, pinning and budget guarantees.

## 2. Background: what exists, and the pi mechanisms this uses

- `src/registry.ts` pins every definition at `session_start` with a SHA-256 hash; `src/trust.ts`
  gates project/config sources behind approval; `src/policy.ts` turns a pinned definition into a
  child `RunPlan` or a refusal.
- `index.ts` intercepts `pi.on("input")` for `#` directives (interactive input only), runs
  single/parallel/chain/pipeline delegations, and returns the result to the transcript.
- The child runner (`src/runners/*`) keeps children inert: no discovery, in-memory sessions,
  explicit tool grants.

Two pi extension facilities make main-session switching possible without session replacement:

1. **`pi.on("before_agent_start", handler)`** exposes `event.systemPromptOptions`
   (`NormalizedBuildSystemPromptOptions`), which is **mutable** and re-rendered from the resource
   loader on every `before_agent_start`:
   - `systemPromptOptions.customPrompt` is the prompt *preamble*; setting it replaces the default
     prefix and keeps pi's structured sections (tools, rules, docs, project context, skills, cwd).
     This is exactly the code path used by `pi --system-prompt` (the loader's `systemPrompt` is
     passed as `customPrompt`).
   - `systemPromptOptions.appendSystemPrompt` renders as an `<addendum>` section after the docs
     section and before project context. This is exactly the code path used by
     `pi --append-system-prompt` (repeatable, joined with `\n\n`).
   - Returning `{ systemPrompt }` instead sets `forceSystemPrompt`, an opaque full replacement with
     no sections. **This design never uses it** — it would erase context files, tool guidelines and
     the transcript's section delta.
2. **`pi.on("input")` can return `{ action: "transform", text }`** — the transformed text is
   delivered as the user input for a normal turn. `before_agent_start` fires after the input
   handler, so a switch applied in the handler is in effect for the task sent in the same message.

Also available and used for the preset: `pi.getActiveTools()/setActiveTools()`,
`pi.getThinkingLevel()/setThinkingLevel()`, `pi.setModel()`, `pi.appendEntry()` (session-scoped
custom entry, not sent to the model), and `ctx.sessionManager.getBranch()` for rehydration.

## 3. Locked decisions (from the design dialogue)

| # | Decision | Choice |
| --- | --- | --- |
| P1 | Kind set | `persona`, `main`, `sub`; no `sys`/`sys_ext` |
| P2 | Default when `kind:` is absent | `main` |
| P3 | `persona` prompt mechanic | replaces the default prompt prefix (`customPrompt`; `--system-prompt` parity) |
| P4 | `main` prompt mechanic | appends (`appendSystemPrompt`; `--append-system-prompt` parity) |
| P5 | `sub` prompt mechanic | unchanged child prompt (runtime header + body) |
| P6 | Dispatch rule | the kind decides what `#name` does |
| P7 | Bare switch | `#name` without text switches and waits; `#name <task>` switches and sends the task |
| P8 | Reset | `#none` returns to plain pi, listed as a built-in `pi.dev` entry |
| P9 | Preset | a switch applies the definition's tools/model/thinking (full preset) and restores them on reset |
| P10 | Trust | gated (project/config) `persona`/`main` are allowed **after the existing approval + hash pin** |
| P11 | Delegation | `main` and `sub` may run as subagents; `persona` may not |
| P12 | Bundled agents | left without `kind:` (become `main`); their files are not edited |

Decisions derived for review (interpretations of pi internals, flagged in §14):

- **D1 — `persona` uses `customPrompt`, not `forceSystemPrompt`.** The definition body becomes the
  prompt preamble; pi's rules/docs/project-context/cwd sections stay. This is the literal code path
  of `--system-prompt`.
- **D2 — `none` is a reserved name.** A definition named `none` is dropped at discovery with a
  diagnostic; the built-in reset always wins.
- **D3 — main-session preset resolution is fail-closed.** Every declared tool name must resolve in
  the main session and a declared model must be available, otherwise the whole switch is refused
  (no partial application), matching `src/policy.ts` child semantics.
- **D4 — switches are interactive-only**, exactly like today's directives (`event.source ===
  "interactive"`). A switch persisted in a session is still rehydrated and applied when that session
  is resumed in any mode, because it is part of the session's own branch.

## 4. Kind model (normative)

```ts
export type AgentKind = "persona" | "main" | "sub";
export interface AgentDefinition {
  // ...existing fields...
  kind: AgentKind; // absent frontmatter => "main"
}
```

- `kind` is a flat scalar in frontmatter, parsed by the strict YAML subset. Duplicate keys, nested
  values and multi-document files remain parse errors.
- Values are case-sensitive: exactly `persona`, `main`, `sub`. Any other value, or a non-string
  value, drops the definition with a diagnostic that names the path and the invalid value.
- Absent `kind` means `main` (P2). This is a behavior change for existing definitions; see §12.
- A definition whose name is `none` is dropped with a diagnostic (D2).
- Kind participates in nothing else: precedence, shadowing, gating and hashing are unchanged.
  Because the pin hash covers raw file bytes, editing `kind:` automatically invalidates an
  approval — no separate rule is needed.

## 5. Directive semantics (normative)

The parser (`src/directive.ts`) stops treating "no task" as malformed for a single bare name:

```ts
export interface Directive {
  stages: DirectiveStage[];
  /** Stage-1 task; `undefined` means the directive had no task text. */
  task: string | undefined;
}
```

Pipeline directives (`#[…]`) still require a task. All other parse errors and the inline-pipeline
hint are unchanged.

Dispatch for a single-name directive (`#name [task]`):

| Name | Kind | Behavior |
| --- | --- | --- |
| `none` | built-in | **reset**: restore the snapshot and base prompt; a task is refused ("#none takes no task") |
| known | `persona` | **switch**: replace the prompt prefix; apply the preset; with task, send the task under the new persona |
| known | `main` | **switch**: append to the prompt; apply the preset; with task, send the task under the new persona |
| known | `sub` | **delegate**: existing child path; task required, bare `#name` refuses ("subagents need a task") |
| unknown | — | refusal naming the agent, existing message shape |
| gated | any | existing approval flow; for `persona`/`main` the approval text states the main-prompt consequence (§9) |

Pipeline directives (`#[a > b, c] <task>`, parallel and chain modes) and the `mx_pi_agent` tool keep
their current semantics, with one addition:

- `main` and `sub` kinds are accepted (P11). When a `main` definition runs as a child, the child
  prompt path is unchanged (runtime header + body), exactly like `sub`.
- `persona` is refused before any child session is created with a message such as
  `agent "x" is a persona agent: it can only run in the main session`.
- The reserved name `none` resolves to no definition, so `#[none]` is an unknown-agent refusal.

Input-handler outcomes:

- Switch with a task → apply the switch, then return `{ action: "transform", text: task }`.
- Bare switch → apply the switch, notify and update status, return `{ action: "handled" }`.
- Delegation (sub kind) → unchanged (`pi.sendMessage` with `triggerTurn`, then `handled`).
- Reset (`#none`) → restore, notify, update status, return `{ action: "handled" }`.
- Refusals → notify `warning`, return `{ action: "handled" }` (nothing reaches the model).

Existing guards are unchanged and are checked before kind dispatch: the disable flag, non-interactive
`event.source`, attached images, and `event.streamingBehavior !== undefined`. In particular a switch
during a running turn is refused ("wait for the current turn"), so two switch applications cannot
interleave.

## 6. Prompt mechanics

One `pi.on("before_agent_start")` handler runs while a switch is active. It re-reads the pinned
definition, re-hashes the file, and mutates `event.systemPromptOptions`:

- `persona`: `options.customPrompt = agent.definition.body`.
- `main`: `options.appendSystemPrompt = [options.appendSystemPrompt, agent.definition.body].filter(Boolean).join("\n\n")`.
- No return value and no `forceSystemPrompt`; the structured prompt keeps pi's sections and the
  transcript records a section delta.

Failure handling, in order:

1. The definition is missing from the registry (e.g. removed on `/mx-pi-agents refresh`) → deactivate
   the switch, notify once, continue with the base prompt.
2. The file hash differs from the pin → deactivate the switch, notify once, continue with the base
   prompt. This extends the existing mid-session edit guarantee (B5) to the main session.
3. The handler never throws into pi: the whole body is wrapped so a disposing session cannot crash a
   turn; on an unexpected error the base prompt is used for that run.

Reset needs no restoration step for the prompt: `systemPromptOptions` is rebuilt from the loader on
every run, so removing the active switch is sufficient.

## 7. Preset application and restore

At the moment a switch is applied (in the input handler, i.e. in `pi` call context):

1. **Snapshot once.** Before the first switch of the session (and before rehydration re-applies
   anything), capture `{ tools: pi.getActiveTools(), model, thinking: pi.getThinkingLevel() }` as
   the *baseline*. The baseline survives subsequent switches and is the only thing `#none` restores.
2. **Validate fail-closed** (D3): every declared tool name resolves in the main session, and a
   declared model is available (`ctx.modelRegistry`, same lookup as `sessionContext`). Any failure
   refuses the switch entirely — prompt, tools, model and thinking all stay as they were.
3. **Apply** only the declared fields; absent fields are left untouched:
   - `tools` present → `pi.setActiveTools(tools)` (present-and-empty means no tools, per the total
     grants contract);
   - `model` present → `pi.setModel(resolved)`;
   - `thinking` present → `pi.setThinkingLevel(thinking)`.
4. **Record** the applied payload and the baseline in the switch state (§8) so reset and rehydration
   are exact.

`#none` restores the baseline: `setActiveTools(baseline.tools)`, `setModel` if the baseline model
still resolves, `setThinkingLevel(baseline.thinking)`, clear the prompt switch, clear the status. A
baseline value that no longer resolves is skipped with a warning; the rest is still restored.

Child-only fields are **ignored in main mode** and documented as such: `scope`,
`tools_inheritance`, `max_turns`, `timeout_ms`, `token_budget`, `cost_budget`, `isolation`,
`sandbox`. A main-session switch is not a bounded child run.

Known limitation (documented): if the user or another extension changes tools/model/thinking after a
switch, a later switch or reset will overwrite that change. This is the same class of interaction as
pi's own preset extension.

## 8. Persistence and rehydration

State is per session and never crosses sessions:

- On every switch and on reset, the extension appends a custom entry:
  `customType: "mx-pi-agents.switch"`, data `{ name, kind, baseline, applied, switchedAt }`
  (reset appends `{ name: null }`). Entries are not sent to the model.
- At `session_start`, the extension walks `ctx.sessionManager.getBranch()` for the last switch entry
  and rehydrates into memory.
- The **prompt** is re-derived every `before_agent_start` from the rehydrated state, so it is exact
  with no extra work.
- The **preset** is re-applied only when the current runtime values still reflect the switch: current
  tools/model/thinking equal either `applied` (nothing changed since) or `baseline` (session was
  restored without them). If they differ from both, the user changed them deliberately and they are
  left alone; the prompt switch still applies.
- Branch navigation (fork/rewind) takes the same path: the last entry on the new branch wins, and a
  branch without a switch entry means plain pi.

## 9. Trust, approval, pinning

Unchanged machinery, extended coverage:

- Bundled and global definitions are trusted. Project (`<cwd>/.pi/agents`) and config (`agentPaths`)
  definitions are gated behind the interactive approval + per-file SHA-256 pin (P10).
- For kinds `persona` and `main`, the approval listing and confirm text additionally state the
  consequence: *"`<name>` [persona] can replace the main system prompt and change tools, model and
  thinking for this session."* A gated definition whose kind is `sub` keeps today's wording.
- The hash is verified at switch time **and again on every turn** by the `before_agent_start`
  handler (§6), matching the mid-session edit guarantee the child runner already enforces.
- Headless sessions (no UI) still refuse gated switches unless a matching stored approval exists.
- A definition named `none` is dropped at discovery (D2), so the reset name can never be shadowed.
- Switching does not execute anything: a gated definition that the user never switches to has no
  effect on the main session.

## 10. Security invariants (added to `src/security.test.ts` and `SECURITY.md`)

Continuing the numbering of the 2026-09-18 design (1–11):

- **12.** A main-session prompt override comes only from (a) the session's base options or (b) a pinned
    definition from a trusted or approved source, re-hashed per turn. A hash mismatch or a missing
    file deactivates the switch; there is no branch that keeps a stale override.
- **13.** `#none` restores the exact pre-switch baseline (tools, model, thinking) and the base prompt; a
    failed restore leaves the session with the base prompt and reports what could not be restored.
- **14.** A `persona` definition can never run as a child: `policy` refuses it before any child session is
    created, for the tool, parallel, chain and pipeline paths alike.
- **15.** Kind parsing is total and fail-closed: absent means `main`; an unknown or non-string kind drops
    the definition with a diagnostic; the reserved name `none` drops the definition.
- **16.** All switch-derived UI text (status, notifications, roster, autocomplete) is control-character
    stripped, same as existing definition-derived text.
- **17.** A main-session switch never grants a child capability and never widens a child grant: it only
    mutates main-session runtime state, and child planning continues to use the unmodified
    `src/policy.ts` contract.

## 11. UI

- **Autocomplete** (`createDirectiveAutocomplete`, `src/complete.ts`): existing `#` trigger and
  bracketed contexts, now with a kind badge per item — `[persona]`, `[main]`, `[sub]` — plus a
  built-in row `pi.dev` with badge `[base]` whose insertion value is `none`. Badges are plain text
  (the popup is not theme-aware).
- **`/mx-pi-agents list`** (`src/render.ts` roster): adds a kind column next to source/trust/hash.
- **Status**: while a switch is active, `ctx.ui.setStatus("mx-pi-agents-persona", "persona:<name>")`
  (or `main:<name>`); cleared on reset. The native footer is never replaced.
- **Notifications**: one line per switch/reset (`"switched to persona reviewer"`), refusal messages
  as described in §5, and a single notification when a switch is auto-deactivated by a hash change
  or a removed definition.
- Non-TUI modes: no status or autocomplete; the persisted switch only affects mode-agnostic
  `before_agent_start` behavior when such a session is resumed (D4).

## 12. Architecture and files

```text
packages/mx-pi-agents/
├── index.ts                 # wiring only: input branch, before_agent_start, status, entry, rehydrate
├── src/
│   ├── persona.ts           # NEW, pure: kind dispatch, switch plan, snapshot/restore payload,
│   │                        #      refusals, reset, rehydration selection
│   ├── types.ts             # AgentKind, Directive.task?, SwitchState, SwitchPlan
│   ├── frontmatter.ts       # parse `kind` scalar
│   ├── schema.ts            # validate kind, reserved name `none`
│   ├── directive.ts         # bare single name => task undefined; pipelines still require a task
│   ├── policy.ts            # refuse persona child runs
│   ├── complete.ts          # kind badges, built-in pi.dev row
│   ├── render.ts            # kind column, switch message rendering
│   └── ...
├── test/harness.ts          # add appendEntry, sessionManager.getBranch, model/thinking getters+setters
├── agents/*.md              # unchanged; all four stay default `main`
└── README.md  SECURITY.md  CHANGELOG.md
```

`index.ts` keeps owning no computation: it parses nothing, interprets nothing, and applies only the
`SwitchPlan` returned by `src/persona.ts` (plus the existing delegation wiring).

## 13. Testing

- **Pure unit tests** (co-located, one per module):
  - `frontmatter`/`schema`: absent → `main`; each valid value; unknown/non-string drop; reserved
    name drop; parse errors unchanged.
  - `persona`: dispatch per kind; bare switch allowed for `persona`/`main` and refused for `sub`;
    `#none` semantics (no task, no active switch, reset payload); persona refused in pipelines;
    unknown agent refusal; snapshot/restore payloads; fail-closed tool/model validation.
  - `complete`/`render`: badges, the `pi.dev` row, kind column, control-character stripping.
- **`src/security.test.ts`**: one test per new invariant 12–17, named so a failure names the broken
  invariant.
- **End-to-end via `test/harness.ts`**: `#reviewer task` returns `transform` with the task and the
  persona is active; bare `#reviewer` returns `handled` and sets status; `#none` clears it;
  `before_agent_start` emits the right `customPrompt`/`appendSystemPrompt`; a hash change
  deactivates; a gated switch uses the approval warning; sub delegation and `#[explorer]` pipelines
  still work; `persona` is refused by the tool.
- Regression: existing directive, delegation, trust and progress tests must stay green after
  `Directive.task` becomes optional.
- `npm run check` and `npx vitest run packages/mx-pi-agents` are the definition of done for each
  step (per `DOD-AGENT.md`).

## 14. Review notes (interpretations to confirm with the spec review)

1. **`persona` = `customPrompt`.** It replaces the prompt preamble and keeps pi's rules, docs,
   project context, skills and cwd sections — the literal `--system-prompt` path. The alternative
   (`forceSystemPrompt`) is deliberately not used. If "replaces the system prompt" was meant
   absolutely, this is the one line to change.
2. **`none` is reserved** and cannot be a definition name.
3. **Subagents keep the hardened child prompt** (fixed runtime header + body); "append" for `sub`
   does not add pi's default prompt to a child.
4. **Preset rehydration rule** in §8 (re-apply only when runtime values still reflect the switch) is
   a deliberate choice to avoid clobbering later user changes; the simpler always-re-apply rule is
   the alternative.

## 15. Out of scope

- Non-interactive switching (a `/mx-pi-agents switch` command, RPC, CLI flag). A future command can
  reuse `src/persona.ts` unchanged.
- Auto-switching per turn or per task.
- Token/cost budgets on the main session.
- A `forceSystemPrompt` "absolute replacement" kind.
- Editing the four bundled agent files.
- Worktree/background runs (still phase-2 per the base design).

## 16. Migration and compatibility

- **Behavior change (breaking, documented in `CHANGELOG.md`):** definitions with no `kind:` are now
  `main`, so `#explorer <task>` switches the main prompt instead of delegating. Delegation to the
  same agents remains available via `#[explorer] <task>` and the `mx_pi_agent` tool.
- `#none` becomes reserved.
- No config-file format change; no new flags required. `--mx-pi-agents-disable` disables switching
  and delegation alike, as today.
- Any file edit to a gated definition invalidates its approval automatically (raw-byte hash), which
  covers `kind:` edits with no extra rule.
