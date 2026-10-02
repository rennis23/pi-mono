# Plan — `#` agent invocation and autocomplete for `mx-pi-agents`

Source of truth for this work. This is the implementation plan (repo convention:
`docs/superpowers/plans/`, date-prefixed). It is intentionally separate from
`packages/mx-pi-agents/PLAN.md`, which is the in-flight path-containment plan.

Baseline assumption: the path-containment work currently dirty in the tree
(`scope`, `scope-unenforceable`, `src/scope.ts`, `src/runners/confine.ts`) has
landed. This feature reuses `planStep` / `planRun` and therefore inherits its
refusals unchanged. Do not start S3 while that work is unmerged.

Baseline commands:

```bash
npx vitest run packages/mx-pi-agents        # green before starting
npm run check                               # green before starting
```

---

## 1. Goal and success criteria

A user typing in the pi TUI can invoke a named agent (or an agent pipeline)
directly from the prompt with a `#` directive, with live autocomplete of the
registry, and have the result trigger the main model's turn.

Success criteria:

1. Typing `#` at the start of the input opens an autocomplete popup listing every
   pinned agent (bundled, global, project, config), with its description and
   source/trust marker — visually equivalent to the built-in `@` file popup.
2. Inside `#[…]`, autocomplete continues to list agents after `[`, `>` and `,`.
3. `#builder <prompt>` runs exactly one agent and appends a rendered result to
   the transcript.
4. `#[planner > builder > review1, review2 > validator] <prompt>` runs a
   pipeline: stages separated by `>`, parallel groups separated by `,`, with
   cascade `{previous}` substitution.
5. Every run goes through the existing trust gate, pin re-verification, budgets
   and path scope — no new bypass. An unknown agent, a gated agent, or an
   out-of-scope run refuses with the same messages the tool produces.
6. The result is recorded in context and starts a main-model turn.
7. `npm run check` and `npx vitest run packages/mx-pi-agents` are green.

Non-goals (explicitly out of scope, see §10): `##` subprocess override, per-stage
prompt syntax, images attached to a directive, retry/resume of a pipeline.

---

## 2. Locked decisions

Operator decisions taken before planning (no longer open):

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Invocation model | Intercept `pi.on("input")` and run the pipeline in-process via the existing orchestrator; do **not** transform into a model-directed tool call |
| D2 | Pipeline syntax | `#name <prompt>` for a single agent; `#[a > b > c, d] <prompt>` for a pipeline |
| D3 | Stage flow | **Cascade `{previous}`**: stage 1 task = `<prompt>`; every later stage task = the prior stage's combined output |
| D4 | `##` subprocess override | **Dropped for v1.** Isolation comes from the definition, exactly as today |
| D5 | Autocomplete trigger | `#` at the start of the input, and after `[`, `>`, `,` inside an open bracket |
| D6 | Result surfacing | Append a custom message (`display: true`, `triggerTurn: true`) and return `action: "handled"` |
| D7 | Plan file | `docs/superpowers/plans/2026-09-26-mx-pi-agents-hash-directives-plan.md` |

Design decisions derived from the above, stated so they can be challenged in
review:

- **D8 — malformed directives never reach the model.** Input that starts with
  `#` but does not parse is reported via `ctx.ui.notify(..., "warning")` and
  handled. It is not forwarded as a user message. A prompt that legitimately
  begins with `#` is therefore not expressible as normal input; that is the
  intended price of an unambiguous prefix.
- **D9 — the trailing prompt is opaque.** Everything after the single agent name
  (or the closing `]`) is the task, including `#`, `[`, `>` and `,`.
- **D10 — inline pipeline delimiters are rejected with a hint.** `#builder >
  explorer <x>` errors with "pipelines require brackets: `#[builder > explorer]`"
  rather than silently treating `> explorer <x>` as the prompt.
- **D11 — `{previous}` in the user's prompt is left literal.** Under cascade the
  later-stage task is literally `{previous}`, so the user never writes it. This
  keeps one rule instead of two.
- **D12 — only interactive input is intercepted.** `event.source !==
  "interactive"` returns `{ action: "continue" }`. RPC and extension-injected
  input are untouched in v1.
- **D13 — streaming input refuses.** When `event.streamingBehavior` is set, the
  directive is refused with a notification ("wait for the current turn"). This
  avoids two concurrent orchestrations in one session.
- **D14 — images refuse.** A directive carrying `event.images` is refused with a
  notification; the runner API takes a text task only.
- **D15 — the disable flag applies.** `--mx-pi-agents-disable` makes the input
  handler return `{ action: "continue" }` (so the text reaches the model
  unchanged, matching how the tool reports itself disabled).

---

## 3. Directive grammar (normative)

Input is the raw editor text. `_ws` is one or more whitespace characters.

```text
directive := ws? "#" name          _ws task
           | ws? "#" "[" pipeline "]" _ws task

pipeline  := stage ( ws? ">" ws? stage )*
stage     := name  ( ws? "," ws? name  )*
name      := [A-Za-z0-9][A-Za-z0-9_-]{0,63}
task      := the remaining text, trimmed; must be non-empty
```

Semantics:

- `#name task` ⇒ one stage with one agent.
- `#[a > b] task` ⇒ two stages.
- `#[a, b] task` ⇒ one stage that runs `a` and `b` in parallel.
- `#[a > b, c > d] task` ⇒ `a`; then `b` and `c` in parallel; then `d`.
- Stage 1 task is the trailing `task` verbatim. Stage `i > 1` task is the string
  `{previous}`; the orchestrator substitutes it with stage `i-1`'s combined
  output. Combined output of a single-result stage is that result's `text`;
  combined output of a parallel stage is the results joined with
  `\n\n--- <agent> ---\n` headers (successful results only).
- Limits: `MAX_PIPELINE_STAGES = 16`; a parallel group is capped by the existing
  `MAX_CONCURRENCY = 8`; `taskCountError` supplies the message.

Parse errors (all reported with `ctx.ui.notify(msg, "warning")`, then handled):

| Input | Reason |
| --- | --- |
| `#` / `# ` | empty agent |
| `#builder` (no task) | missing task |
| `#[…]` with an empty bracket body | empty pipeline |
| `#[a >]`, `#[a,,b]`, `#[> a]` | empty stage / dangling delimiter |
| malformed name (`#-x`, `#a b` before the task) | invalid name |
| `#builder > explorer task` | D10 hint |
| > `MAX_PIPELINE_STAGES` | too many stages |

Worked examples:

```text
#explorer Where is the config loaded?
  → stages: [[explorer]]            task: "Where is the config loaded?"

#[planner > builder > review1, review2] Add a login page
  → stages: [[planner], [builder], [review1, review2]]
    planner.task  = "Add a login page"
    builder.task  = {previous}            (planner output)
    review1.task  = {previous}            (builder output)
    review2.task  = {previous}            (same builder output)
```

---

## 4. Architecture and files

```text
packages/mx-pi-agents/
  src/directive.ts        NEW  pure parser (grammar §3)
  src/directive.test.ts   NEW
  src/complete.ts         NEW  pure autocomplete context + filtering
  src/complete.test.ts    NEW
  src/modes.ts            MOD  add runPipeline; extend mode union
  src/modes.test.ts       MOD
  src/render.ts           MOD  mode union + directive message renderer
  src/render.test.ts      MOD
  index.ts                MOD  input handler, autocomplete wiring, shared delegation
  index.test.ts           MOD
  test/harness.ts         MOD  fake addAutocompleteProvider / sendMessage / registerMessageRenderer
  README.md               MOD  document `#` and `#[…]`
  CHANGELOG.md            MOD  [Unreleased]
```

Boundaries:

- `directive.ts` and `complete.ts` are pure and pi-free (no pi imports), so both
  are unit-testable with plain strings. `complete.ts` defines its own
  `CompletionItem` structurally compatible with pi-tui's `AutocompleteItem`,
  mirroring how `render.ts` defines the minimal `RenderTheme`.
- `modes.ts` stays the only place that plans and runs children. `runPipeline`
  reuses the existing private `planStep` / `runStep` helpers so hash
  re-verification and the trust gate apply identically.
- `index.ts` remains the wiring layer. The tool's `execute` and the input handler
  share one local `runDelegation` helper so the two entry points cannot drift.

---

## 5. Implementation stages (each gated green before the next)

### S1 — Directive parser (`src/directive.ts`, new)

Types:

```ts
export interface DirectiveStage { agents: string[]; }      // >1 = parallel
export interface Directive { stages: DirectiveStage[]; task: string; }
export type DirectiveOutcome =
  | { ok: true; directive: Directive }
  | { ok: false; message: string };                        // user-facing, already useful
/** undefined when the text is not a directive at all (no leading `#`). */
export function parseDirective(text: string): DirectiveOutcome | undefined;
export const MAX_PIPELINE_STAGES = 16;
```

- Leading whitespace allowed; anything non-whitespace before `#` ⇒ `undefined`.
- Reject `>` / `,` immediately after a bare single name with the D10 hint.
- All error messages name the offending token and include a one-line usage.

Tests `src/directive.test.ts`: one case per row of the §3 error table, plus each
worked example, leading-whitespace, task containing `#`/`[`/`>`/`,`, duplicate
agent names across stages, name length bounds, `MAX_PIPELINE_STAGES` boundary.

### S2 — Autocomplete context (`src/complete.ts`, new)

```ts
export interface CompletionItem { value: string; label: string; description?: string; }
export interface CompletionSource { name: string; description: string; source: string; trusted: boolean; }
export function toCompletionSource(agents: readonly PinnedAgent[]): CompletionSource[];
/** undefined when the cursor is not in a completable directive position. */
export function directiveContext(textBeforeCursor: string): { mode: "single" | "pipeline"; prefix: string } | undefined;
export function completionItems(source: readonly CompletionSource[], context: { mode: "single" | "pipeline"; prefix: string }): CompletionItem[];
```

- `directiveContext`: validate line-start `#`; if the next character is `[` and no
  `]` has closed it, take the trailing `[A-Za-z0-9_-]*` run after the last
  `[`/`>`/`,`/whitespace as `prefix`, mode `"pipeline"`; otherwise require a
  whitespace-free partial name after `#` and return `prefix = "#" + name`,
  mode `"single"`. Return `undefined` once the task text has begun or once the
  bracket is closed.
- `completionItems`: prefix match first (case-insensitive `startsWith`), then
  substring match; cap at 20; `value` is `#name` in single mode and `name` in
  pipeline mode; `label` is the sanitized name; `description` is
  `"<description> · <source>[ gated]"` using `sanitizeUiText`.
- Return `[]` (not a fallback) when the context matches but no agent does, so an
  unknown name shows an empty popup rather than the file popup.

Tests `src/complete.test.ts`: `#`, `#bui`, `#[`, `#[planner > bui`,
`#[planner > builder > `, closed bracket, `#[…] ` (already in task), mid-line
`#`, `@` line, no leading `#`, sanitization of a hostile description, empty and
over-cap results.

### S3 — Pipeline orchestration (`src/modes.ts`)

- Extend `DelegationOutcome["mode"]` to `"single" | "parallel" | "chain" | "pipeline"`.
- Add:

```ts
export interface PipelineStage { agents: readonly string[]; }
export async function runPipeline(
  stages: readonly PipelineStage[],
  task: string,
  deps: OrchestratorDeps,
  options: RunOptions,
): Promise<DelegationOutcome>;
```

- Validate `stages.length` (1..`MAX_PIPELINE_STAGES`) and each parallel group via
  `taskCountError`; a violation returns `{ mode: "pipeline", results: [],
  refusal: { reason: "invalid-request", … } }` before any child session exists.
- Per stage: `taskForStage = index === 0 ? task : "{previous}"`. Single-agent
  stage = `planStep` + `runStep`, fail-fast (chain semantics). Multi-agent stage =
  the existing bounded `mapWithConcurrencyLimit` + `allSettled`; if every result
  in the group failed, stop after the group.
- `previous = combineStageResults(results)` (label join; successful results only).
- A refusal from `planStep` stops the pipeline at that stage and is returned on
  `outcome.refusal`, exactly like `runChain`.

Tests `src/modes.test.ts` (stub runner, no pi): single-stage pipeline; three
sequential stages observe `{previous}`; parallel stage shares one `{previous}`
and produces a labeled combined output consumed by the next stage; fail-fast on
a stage failure including `stoppedAt`; group cap and stage cap refusals;
mixed parallel/sequential ordering; refusal propagation with a stub `authorize`.

### S4 — Shared delegation helper (`index.ts`, behavior-preserving)

- Extract the body of `registerTool({ execute })` after parameter parsing into:

```ts
async function runDelegation(
  request: { kind: "single" | "parallel" | "chain" | "pipeline"; steps?: DelegationStep[]; stages?: PipelineStage[]; task?: string },
  ctx: ExtensionContext,
  options: { signal: AbortSignal; onUpdate?: (results: RunResult[]) => void },
): Promise<{ text: string; details: AgentToolDetails }>;
```

- It owns: `deps(ctx)`, the upfront async `authorize` sweep over every distinct
  agent name (mapping refusals into `orchestration.authorize`), mode dispatch,
  `createRedactor(process.env)`, `aggregateResults`, and details assembly.
- The tool's `execute` becomes: parse params → `runDelegation` → tool result.
  No behavior change; the existing `index.test.ts` suite must stay green.

Tests: none added here; S4 is proven by the unchanged `index.test.ts` suite.

### S5 — Input handler + directive message (`index.ts`, `src/render.ts`)

- Constant `DIRECTIVE_MESSAGE = "mx-pi-agents.directive"`.
- Register `pi.registerMessageRenderer(DIRECTIVE_MESSAGE, …)` in the factory.
  `render.ts` gains `renderDirectiveMessage(message, theme)` that reuses
  `renderResultLines` over the `AgentToolDetails` in `details`.
- `render.ts`: add `"pipeline"` to `AgentToolDetails["mode"]`.
- `pi.on("input", async (event, ctx) => …)`:
  1. `mx-pi-agents-disable` ⇒ `{ action: "continue" }`.
  2. `event.source !== "interactive"` ⇒ `{ action: "continue" }`.
  3. `parseDirective(event.text)` undefined ⇒ `{ action: "continue" }`.
  4. `!parsed.ok` ⇒ notify warning, `{ action: "handled" }`.
  5. `event.images?.length` or `event.streamingBehavior` ⇒ notify, handled.
  6. Set a working status (`ctx.ui.setStatus("mx-pi-agents", "…")`; clear in a
     `finally`), call `runDelegation`, then
     `pi.sendMessage({ customType: DIRECTIVE_MESSAGE, content: text, display: true, details }, { triggerTurn: true })`,
     and return `{ action: "handled" }`.
- Wrap every pi call in try/catch; a handler failure must not crash the TUI and
  must clear the status.
- The `AbortSignal`: use `ctx.signal ?? new AbortController().signal`. There is
  no way for the user to abort an in-flight directive in v1 (recorded as a known
  limitation in §10).

Tests `index.test.ts`: directive with a stubbed runner appends one custom message
with `triggerTurn: true` and returns `handled`; malformed input notifies and
handles; disabled flag continues; streaming input refuses; image input refuses;
unknown agent yields a refusal message; gated agent triggers `ctx.ui.confirm`;
`source: "extension"` continues.

### S6 — Autocomplete provider wiring (`index.ts`, `test/harness.ts`)

- In `session_start`, after `pin(ctx)`:

```ts
if (ctx.mode === "tui") {
  ctx.ui.addAutocompleteProvider((current) => createDirectiveAutocomplete(current, () => roster));
}
```

- `index.ts` defines the wrapper inline (it is thin): call `directiveContext` on
  the text before the cursor; on `undefined` return
  `current.getSuggestions(...)`; otherwise return
  `{ items: completionItems(toCompletionSource(roster), context), prefix: context.prefix }`,
  and delegate `applyCompletion` / `shouldTriggerFileCompletion` to `current`.
  Set `triggerCharacters: ["#"]`. Because the editor's `applyCompletion`
  generic branch replaces `prefix` with `item.value`, no custom apply logic is
  needed (verified against `@earendil-works/pi-tui` `CombinedAutocompleteProvider`).
- Everything is inside try/catch: a provider that throws must degrade to
  `current.getSuggestions(...)`.
- `test/harness.ts` gains `addAutocompleteProvider` (capturing factories),
  `sendMessage` (capturing messages), and `registerMessageRenderer`
  (capturing renderers), mirroring the real shapes.

Tests `index.test.ts`: register a synchronous fake session, start it, pull the
captured provider factories, and drive `getSuggestions` for `#`, `#bui`,
`#[planner > bui`, and a non-directive line (asserts delegation to `current`).

### S7 — Docs and changelog

- `README.md`: a new "Direct invocation" section with the grammar table, the two
  worked examples, and a note that directives use the same trust gate and
  budgets as the tool; mention autocomplete and that unknown/malformed
  directives are reported, not forwarded.
- `CHANGELOG.md` under `[Unreleased]`: `Added` entry.
- `SECURITY.md`: one line in the entry-points section stating that a `#`
  directive reaches the child only through `planRun` and cannot widen a grant.
  No threat-model change; `#` is not a new capability, only a new caller.

---

## 6. Test matrix (summary)

| Area | Cases |
| --- | --- |
| `directive.test.ts` | every §3 error row; both worked examples; leading whitespace; task containing `#[]>,`; duplicate names; limits |
| `complete.test.ts` | single/pipeline contexts; closed bracket; task position; non-directive lines; sanitization; caps |
| `modes.test.ts` | cascade `{previous}`; parallel group combination; fail-fast; caps; refusal propagation |
| `index.test.ts` | input handled/continue paths; disabled; streaming; images; unknown/gated agent; custom message shape; provider delegation |
| unchanged | the whole existing suite, especially `security.test.ts` invariants 1–11 |

No test touches the real `~/.pi`; temp dirs and the existing fixtures only.

---

## 7. Verification

```bash
npx vitest run packages/mx-pi-agents                              # all suites
npx vitest run packages/mx-pi-agents/src/directive.test.ts        # new parser
npx vitest run packages/mx-pi-agents/src/complete.test.ts         # new completion
npx vitest run packages/mx-pi-agents -t "pipeline"                # orchestration
npm run check                                                     # biome + tsc
```

Manual smoke (interactive TUI), recorded in the PR description:

1. Type `#` → popup lists the four bundled agents with descriptions.
2. `#explorer where is config loaded` → result appended, main model replies.
3. `#[planner > builder] add a health endpoint` → two-stage cascade.
4. `#nope x` → warning notification, no model turn.
5. `#builder > x` → bracket hint.

---

## 8. Definition of done

- [x] `#name task` and `#[…] task` parse per §3, with every error row covered.
- [x] Autocomplete lists all pinned agents at line start and after `[`, `>`, `,`.
- [x] `runPipeline` performs cascade `{previous}` substitution and fails fast.
- [x] The tool and the input handler share one `runDelegation`; no duplicated
      authorize/redact/aggregate logic.
- [x] The result is a rendered custom message with `triggerTurn: true`.
- [x] `npm run check` and `npx vitest run packages/mx-pi-agents` are green.
- [x] README, CHANGELOG and SECURITY updated.
- [x] A directive run obeys the same trust gate, pin verification, budgets and
      path scope as `mx_pi_agent` (proven by an `index.test.ts` case).

---

## 9. Risks and rollback

- **In-flight PR ordering.** S3 depends on `planStep` / `planRun` from the path
  containment work. Land that first; rebase this plan's stages onto it.
- **Input handler latency.** A pipeline runs model calls while the editor is
  blocked; there is no user abort in v1. Mitigated by a status line; accepted as
  a known limitation and revisited if it bites.
- **Fire-and-forget `pi.sendMessage`.** `triggerTurn` turns start asynchronously
  and errors surface as extension errors. This matches how extension commands
  already behave (`_tryExecuteExtensionCommand` → `pi.sendMessage`), so the
  ordering contract is proven, but the plan calls for a try/catch so a failure
  clears the status.
- **`#` in prose.** Rejected-by-design (D8). If it proves too strict, the
  fallback is to forward unparsable `#` text as a normal prompt — a one-line
  change, deliberately not taken now.
- **Autocomplete collisions.** Other extensions may register providers; we
  always delegate to `current` when the cursor is not in a directive context.

Rollback: the feature is additive and gated by no flag changes. Revert S5–S6 to
remove the entry points, or set `--mx-pi-agents-disable` for a single run.

---

## 10. Out of scope

- `##name` subprocess override (dropped in D4).
- Per-stage prompt syntax (e.g. `#planner <plan X> > #builder <{previous}>`).
- Mixed `#` and `#[…]` in one input, or several directives in one message.
- Images attached to a directive.
- Resume/retry, streaming partial output of a pipeline into the transcript.
- Autocomplete of prompt fragments or of `{previous}`.
