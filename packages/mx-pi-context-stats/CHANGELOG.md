# Changelog

All notable changes to `@rennis23/mx-pi-context-stats` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository publication and security-policy documentation.
- Per-prompt context, token, cost and subagent stats widget rendered below (or
  above) the editor, plus a single status line on pi's built-in footer showing
  live tok/s, prompt duration and context usage. pi's native footer is never
  replaced: extras are published through `ctx.ui.setStatus`.
- Rolling prompt history: one row per prompt with context size and percentage,
  input/output tokens, cost, turns, mean output tok/s and wall-clock duration,
  with the newest row marked `←`.
- Health cells on the current row: `burn` (tokens/minute), `~N left` (prompts
  remaining at the current growth rate) and `cache` (share of input served from
  cache), plus a `⟳` marker on the prompt that followed a compaction so a sudden
  context drop is not mistaken for a bug.
- Live subagent section: status, tool list, model, turns, tokens, context, cost,
  burn rate and duration for each tracked subagent, driven by tolerant parsing of
  `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
  payloads. Tracking is opt-in by tool name (`subagentToolNames`, default
  `["spawn_subagent"]`) and the section simply never renders when no such tool
  exists.
- Pure, injectable core (`src/*.ts`, no pi types beyond a minimal theme surface):
  time is injected, `format.ts` never emits `NaN`/`Infinity`, and `health.ts`
  returns `undefined` rather than `0` for unmeasurable metrics so callers omit
  the cell instead of rendering a misleading number.

### Changed

- Registered widget options with `@rennis23/mx-pi-settings` and moved persistence to its central namespaced store.
- Replaced `/mx-pi-settings` options commands with the hub; `/mx-pi-context-stats` now prints the session summary.
- Removed the development-only config file, context-stats CLI flags, and settings picker; no backward-compatibility migration is provided.
