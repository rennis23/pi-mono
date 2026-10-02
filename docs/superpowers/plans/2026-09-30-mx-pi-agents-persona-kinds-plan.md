# Plan: mx-pi-agents persona kinds + main-session switching

Implements `docs/superpowers/specs/2026-09-30-mx-pi-agents-persona-kinds-design.md`.

## Steps

1. **Types** (`src/types.ts`) — add `AgentKind`, `AgentDefinition.kind`, `RefusalReason "persona-child"`,
   `SwitchBaseline`, `SwitchApplied`, `SwitchEntryData`.
2. **Frontmatter/schema** — parse the scalar `kind` field, default `main`, reject unknown/non-string,
   reserve the name `none`.
3. **Directive** (`src/directive.ts`) — `Directive.task` becomes `string | undefined`; a bare single
   name parses successfully; pipelines still require a task.
4. **Persona module** (`src/persona.ts`, new, pure) — kind dispatch, switch plan with fail-closed
   tool/model validation, reset payload, snapshot/restore, rehydration selection from a branch.
5. **Policy** (`src/policy.ts`) — refuse a `persona` definition before any child session; add
   `persona-child` refusal reason.
6. **Autocomplete/render** — kind badges, built-in `pi.dev` row, roster kind column, switch text.
7. **Trust** — approval summary states the main-prompt consequence for `persona`/`main`.
8. **Wiring** (`index.ts`) — `before_agent_start` prompt mutation, input-handler kind dispatch,
   baseline snapshot, preset apply/restore, status, persistence via `appendEntry`, rehydration.
9. **Harness** — `appendEntry`, `sessionManager.getBranch`, thinking/model getters+setters,
   `getAllTools`, model.
10. **Tests** — enable persona in all test fixtures; rewrite `#name <task>` delegation tests to
    `#[name] <task>`; add unit tests for `persona`; add invariants 12–17; add end-to-end switch,
    reset, rehydration, hash-change and persona-refusal tests.
11. **Docs** — README, SECURITY.md, CHANGELOG.md.
12. **Verify** — `npm run check` and `npx vitest run packages/mx-pi-agents`.
