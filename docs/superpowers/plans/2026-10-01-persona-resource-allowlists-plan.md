# Plan: Persona resource allow-lists (`skills`, `tools`, `context_files`)

Date: 2026-10-01
Package: `@rennis23/mx-pi-agents`

## Goal

Let a main-session agent definition declare — in frontmatter — which resources
survive when it is switched in via `#name`. Locked with the user:

- Frontmatter fields only, one list per category.
- List semantics: **absent = inherit current behavior**, **`[]` = none**, **`[a, b]` = only these**.
- Fields: `tools` (exists), `skills`, `context_files`.
- Enforcement is prompt-level in the live session, not a process reload.

## Why prompt-level

pi loads skills, extensions, prompt templates and themes at session start; the
ExtensionAPI has no unload call. What a main-session switch *can* enforce every
turn, via the mutable `event.systemPromptOptions` in `before_agent_start`:

| Frontmatter field | Loaded input | Enforcement |
| --- | --- | --- |
| `tools` | active tool set | `pi.setActiveTools()` (already implemented, fail-closed in `planSwitch`) |
| `skills` | `options.skills[]` | filter by `skill.name` before the `<skills>` section renders |
| `context_files` | `options.contextFiles[]` | filter by path before `<project_context>` renders |

Marked in docs as the boundary:

- Extension **tools** are covered by `tools: []`; extension **handlers** and
  `/skill:*` commands cannot be unloaded from a running session.
- Extension-contributed prompt sections (`options.sections`) are out of scope
  for this change (the user chose skills + tools + context_files only).
- Unknown `skills`/`context_files` entries match nothing; they never widen the
  loaded set.

## Matching rules for `context_files`

An entry matches a loaded context file when it equals, after normalizing
backslashes and trailing slashes:

1. the absolute path, or
2. the path relative to the session cwd (only when the file is strictly beneath
   `cwd + "/"`), or
3. the basename (so `AGENTS.md` matches the global and project copies).

## Steps

1. `src/types.ts` — add `skills` and `contextFiles` to `AgentDefinition`
   (`undefined` = absent, `[]` = none).
2. `src/schema.ts` — register `skills`, `context_files` in `KNOWN_FIELDS`; add
   `SKILL_NAME_PATTERN` and a list reader for each; wrong shape still drops the
   whole definition.
3. `src/resources.ts` (new, pure, pi-free) — `filterSkills(skills, allow)` and
   `filterContextFiles(files, allow, cwd)`; total functions, absent allow →
   passthrough copy.
4. `index.ts` — in the `before_agent_start` switch handler, after applying the
   prompt, narrow `options.skills` / `options.contextFiles` from the pinned
   definition. Applies to `persona` and `main`; a `sub` never reaches this path.
5. `test/fixtures.ts` — expose `skills` / `contextFiles` in `makeAgent`.
6. Tests:
   - `src/resources.test.ts` — absent/empty/list, unknown entries, ordering,
     path matching (absolute, cwd-relative, basename, Windows separators,
     sibling-prefix false positive).
   - `src/schema.test.ts` — parse/dedupe/absent/empty, invalid entries drop the
     definition, unknown fields still reject.
   - `index.test.ts` — while a bare persona with `skills: []` /
     `context_files: []` is active, `before_agent_start` empties both arrays and
     replaces the prompt; absent fields leave them untouched; `#none` restores.
   - `src/registry.test.ts` — bundled `socrates` declares `tools: []`,
     `skills: []`, `context_files: []`.
7. `agents/socrates.md` — add `skills: []` and `context_files: []`.
8. Docs — `README.md` frontmatter table and bundled-agents note; `CHANGELOG.md`
   `[Unreleased]`.
9. Verify — `npm run check` and `npx vitest run packages/mx-pi-agents`.

## Out of scope

- `sections` / extension prompt sections and any `extensions:` field.
- `prompt_templates`, `themes`, MCP toggles — not enforceable in a live switch.
- Child runs: children already load no discovery resources; the fields are
  main-session only and are ignored by `planRun`.
