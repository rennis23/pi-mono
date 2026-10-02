# Design: mx-pi-agents — main-session delegation (`delegate`)

**Date:** 2026-10-02
**Status:** Draft — awaiting review
**Package:** `packages/mx-pi-agents/` → `@rennis23/mx-pi-agents`
**Related:** [`2026-09-18-mx-pi-agents-design.md`](./2026-09-18-mx-pi-agents-design.md) (invariant 8), [`2026-09-30-mx-pi-agents-persona-kinds-design.md`](./2026-09-30-mx-pi-agents-persona-kinds-design.md) (the switch this extends)

---

## 1. Goal

Let a **main-session** agent delegate. An orchestrator persona such as
`#productbuilder <task>` should think, call specialist sub-agents in sequence
(`explorer` → `planner` → `builder` → `reviewer`), ask the user when it needs a
decision, and finish with a commit message plus a PR title and description.

Today it cannot, because a switch applies the definition's `tools` as a preset
that **replaces** the active set:

```ts
// src/persona.ts
applied.tools = [...definition.tools];   // → pi.setActiveTools(applied.tools)
```

Every bundled agent that declares `tools` (`explorer`, `planner`, `reviewer`,
`builder`) therefore loses `mx_pi_agent` the moment it becomes active in the main
session. The orchestrator flow is impossible without a new capability flag.

This design adds a per-definition `delegate` boolean that keeps `mx_pi_agent`
active across a main-session switch. It is a **main-session verb**, not a child
grant: invariant 8 ("children cannot spawn children") is unchanged and still
enforced by `src/policy.ts`.

## 2. Background: the three layers that forbid nesting

`delegate` must not disturb any of them:

| Layer | Code | Role |
| --- | --- | --- |
| Env guard | `index.ts` (`MX_PI_AGENTS_CHILD`) | a marked child never registers the tool |
| Policy | `src/policy.ts` (`spawn-tool-grant`) | a child grant of any spawn-capable name refuses the run |
| Schema | `src/schema.ts` (`computeEffectiveTools`) | spawn-capable names are stripped from `tools_inheritance: parent` |
| Runner | `src/runners/in-process.ts` | child loads no extension, so no tool registers itself |

All four stay exactly as they are. `delegate` is consulted in exactly one place:
`planSwitch`, which only ever runs for `kind: persona | main` in the main
session.

## 3. Locked decisions (from the design dialogue)

| # | Decision | Choice |
| --- | --- | --- |
| D1 | Mechanism | an explicit per-definition frontmatter field, not a global policy |
| D2 | Field | `delegate`, boolean, default `false` |
| D3 | Scope | valid on `kind: persona \| main` only; **ignored with a warning** on `kind: sub` |
| D4 | Effect | unions `mx_pi_agent` into the applied main-session tool preset |
| D5 | Nesting | **explicitly out of scope**; children remain leaves (invariant 8 intact) |
| D6 | Orchestrator | one bundled `kind: main` agent, `productbuilder`, read-only + delegation |
| D7 | Naming | `productbuilder`, per the request |
| D8 | Roster | `/mx-pi-agents list` shows a `delegate` marker |
| D9 | Human questions | asked only by the main-session orchestrator; children have no UI |
| D10 | Deliverable | mechanism + orchestrator only; web fetch, PR automation and new sub-agents are deferred |

## 4. Data model (normative)

```ts
export interface AgentDefinition {
  // ...existing fields...
  /**
   * Main-session delegation. When `true`, the switch guarantees `mx_pi_agent`
   * is in the active tool set. Ignored for child runs, which never receive a
   * spawn-capable grant (invariant 8).
   */
  delegate: boolean;
}
```

- `delegate` is added to `KNOWN_FIELDS` in `src/schema.ts`; absent or `false`
  both mean `false`.
- A non-boolean value drops the whole definition with a diagnostic, matching
  every other typed field.
- `delegate` on `kind: sub` is **ignored with a warning** (D3). The definition
  still loads and runs as a leaf; `registry.ts` emits
  `delegate is ignored on sub agent "<name>": sub agents never run in the main session`.
- `delegate` does not participate in precedence, shadowing, gating or hashing.
  Because the pin hash covers raw bytes, editing `delegate` invalidates an
  approval automatically — no separate rule is needed.

## 5. Switch semantics (normative)

`SwitchContext` gains `currentTools`, the session's currently active tool names
(`pi.getActiveTools()`, already available at both call sites).

`planSwitch` applies one of three cases:

```ts
const DELEGATE_TOOL = "mx_pi_agent";

if (definition.delegate) {
  // Declared preset if present, else whatever is active now, so switching from
  // a narrowed agent (#planner) to an orchestrator restores the capability.
  const base = definition.tools ?? ctx.currentTools;
  const merged = [...new Set([...base, DELEGATE_TOOL])];
  const unresolved = merged.filter((name) => !ctx.availableTools.includes(name));
  if (unresolved.length > 0) {
    return refuse(`agent "${name}" declares tools that do not resolve in the main session: ...`);
  }
  applied.tools = merged;
} else if (definition.tools !== undefined) {
  // unchanged: exact declared list, present-and-empty means no tools
  applied.tools = [...definition.tools];
}
```

Consequences, all intentional:

- `tools: [read, grep, find, ls]` + `delegate: true` → `{read, grep, find, ls, mx_pi_agent}`.
- `tools: []` + `delegate: true` → `{mx_pi_agent}`: a pure orchestrator with no
  other capability. Valid.
- `tools` absent + `delegate: true` → the current active set plus
  `mx_pi_agent`. If that set is already whole, this is a no-op.
- `--mx-pi-agents-disable` (tool not registered) + `delegate: true` → the switch
  **refuses**; the capability is never silently dropped.
- `delegate` false/absent → behavior is byte-identical to today.

`delegate` is otherwise inert: it does not set `model` or `thinking`, does not
affect `skills`/`context_files` narrowing, and is not restored specially by
`#none` (the baseline restore already covers the whole tool set).

## 6. Child semantics — invariant 8 unchanged (normative)

- `delegate` is never read by `policy.ts` or `computeEffectiveTools`.
- A `kind: persona | main` definition that runs as a child gets its grants from
  `tools` alone, exactly as today.
- Any child grant containing `mx_pi_agent` (or the other spawn-capable names)
  still refuses the run with `spawn-tool-grant`.
- `tools_inheritance: parent` still strips spawn-capable names.
- The `MX_PI_AGENTS_CHILD` guard in `index.ts` is untouched.

This is the load-bearing property of the design and gets its own regression
test (see §10).

## 7. Bundled `productbuilder` orchestrator

New file `packages/mx-pi-agents/agents/productbuilder.md`:

```yaml
---
name: productbuilder
description: Orchestrate explorer, planner, builder and reviewer through a task and report a commit message and PR description
kind: main
tools: [read, grep, find, ls]
delegate: true
---

# Product builder orchestrator

You coordinate a pipeline of specialist agents. You do not implement: you
direct, verify and decide. Delegate with the `mx_pi_agent` tool; each sub-agent
returns a report and then stops.

Workflow:

1. **Clarify.** Restate the task in one paragraph. If the goal, scope or
   acceptance criteria are ambiguous, ask the user before delegating anything.
2. **Recon.** Delegate to `explorer` for the files, entry points and constraints.
3. **Plan.** Delegate to `planner` with the recon findings; get ordered steps.
4. **Confirm.** Present the plan and ask the user to approve it. Do not continue
   without approval.
5. **Build.** Delegate to `builder` with the approved plan and the exact scope.
6. **Review.** Delegate to `reviewer` on the change. Send defects back to
   `builder` and re-review. Repeat until clean.
7. **Report.** End with a commit message (imperative subject, ≤ 72 characters),
   a PR title, and a PR description (summary, changes, testing, risks). Do not
   open the PR.

Rules:

- Never claim a sub-agent checked something it could not.
- Quote sub-agent findings verbatim; never silently drop a warning.
- A refusal or a budget stop ends a delegation; it is not a retry.
- Stay in this workflow until the user's task is complete.
```

`kind: main` (append) rather than `persona` (replace), so pi's rules, docs,
project context and cwd sections survive. `tools` is read-only; `builder` owns
all writes, so the orchestrator can direct but cannot modify the tree itself.
The PR step is deferred (D10): the orchestrator emits the text, the user opens
the PR.

## 8. Roster rendering

`RosterEntry` gains `delegate: boolean`; `RosterLine` gains the same field.
`renderRosterLines` appends a dim `⇄ delegate` token after the kind/source
segment when set. `/mx-pi-agents list` therefore makes the orchestrators visible
without changing any other output.

## 9. Validation and errors

| Case | Behavior |
| --- | --- |
| `delegate` not a boolean | drop the definition; diagnostic names the field |
| `delegate: true` on `kind: sub` | keep the definition, ignore the field, emit a warning |
| `delegate: true`, a tool in the merged set does not resolve | refuse the switch, apply nothing |
| `--mx-pi-agents-disable`, `delegate: true` | refuse the switch (`mx_pi_agent` unresolved) |
| `delegate: true` on a gated (project/config) definition | existing approval + hash pin flow, unchanged |

## 10. Security invariants and `SECURITY.md`

Invariant 8 is restated, not weakened. One invariant is added, continuing the
numbering of the persona-kinds design:

- **15. `delegate` is a main-session verb.** It is read only by `planSwitch`,
  which runs only for `kind: persona | main` in the main session. No code path
  lets `delegate` place `mx_pi_agent` in a child grant. A child session started
  from a delegating orchestrator has no spawn-capable tool.

`SECURITY.md` gets two edits: the B2 grant table notes that any spawn-capable
child grant still refuses the run, and the "Non-goals" list states explicitly
that **recursive delegation is not supported** — a child cannot delegate, by
design, and `delegate` does not change that.

## 11. Testing

| Suite | Test |
| --- | --- |
| `src/schema.test.ts` | parses `delegate: true` / `false` / absent; non-boolean drops the definition |
| `src/registry.test.ts` | `delegate: true` on `sub` loads with a warning; other diagnostics unaffected |
| `src/persona.test.ts` | `delegate` unions `mx_pi_agent`; `tools: []` yields only `mx_pi_agent`; `tools` absent unions `currentTools`; unresolved tool refuses; `delegate: false` is byte-identical |
| `src/persona.test.ts` | switching `#planner` → delegating agent with no preset restores `mx_pi_agent` |
| `src/security.test.ts` | invariant 15: a delegating main-kind definition run as a child still refuses / gets no `mx_pi_agent`; invariant 8 suite still green |
| `src/bundled-agents.test.ts` | `productbuilder` exists, `kind: main`, `delegate: true`, tools read-only, and declares no `mx_pi_agent` in `tools` |
| `src/render.test.ts` | roster line shows the `delegate` marker only when set |
| `index.test.ts` | `#productbuilder <task>` applies the switch and keeps `mx_pi_agent` active |

## 12. Documentation

- `README.md`: add `delegate` to the frontmatter field table; add a paragraph to
  "Agent kinds" explaining that a main-session switch can preserve delegation and
  that children never delegate; list `productbuilder` in the bundled-agent table.
- `SECURITY.md`: §10 additions.
- `CHANGELOG.md`: `[Unreleased] → Added` entry.
- `index.ts` header comment: note that `delegate` is a main-session verb.

## 13. File structure

| File | Change |
| --- | --- |
| `src/types.ts` | `delegate` on `AgentDefinition` |
| `src/schema.ts` | parse + validate `delegate`; add to `KNOWN_FIELDS` |
| `src/persona.ts` | `SwitchContext.currentTools`; the union in `planSwitch` |
| `src/registry.ts` | `delegate` on `RosterEntry`; the `sub` warning |
| `src/render.ts` | `delegate` marker |
| `index.ts` | pass `currentTools` at both `planSwitch` call sites |
| `agents/productbuilder.md` | new bundled orchestrator |
| `src/*.test.ts` | §11 |
| `README.md`, `SECURITY.md`, `CHANGELOG.md` | §12 |

## 14. Out of scope (explicitly)

- **Recursive delegation.** Children stay leaves. Replacing invariant 8 with a
  bounded recursion budget is a separate design with its own depth, scope
  intersection, budget division and cycle-detection controls.
- **Web fetch.** pi exposes no web tool, so a spider would need `bash` + `curl`,
  which is refused unless the scope ceiling is `/` (unconfined); `sandbox: os`
  denies network. This needs its own egress design.
- **PR automation.** `git`/`gh` execution is deferred; the orchestrator only
  produces the text.
- **New sub-agents** (`websprider`, `codesecurity`). The orchestrator reuses the
  existing roster for now.

## 15. Derived decisions for review

- **P1 — `delegate` with `tools` absent unions `currentTools`.** The alternative,
  treating it as a no-op, breaks switching directly from a narrowed agent
  (`#planner` → `#productbuilder`), which would leave `mx_pi_agent` off.
- **P2 — `delegate` on `sub` warns rather than drops.** Chosen for ergonomics
  while writing definitions; it is not a security boundary, because a child
  never runs `planSwitch`.
- **P3 — the orchestrator is `kind: main`, not `persona`.** `persona` replaces
  the prompt preamble and would drop pi's rules and project context, which an
  orchestrator needs to reason about the change.
- **P4 — no `delegate` marker on the status line.** Only the roster changes;
  the active switch already shows as `main:<name>` in the footer.
