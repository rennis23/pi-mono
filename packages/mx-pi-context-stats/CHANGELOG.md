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
- `/mx-pi-settings` command: an interactive picker in TUI sessions and scriptable
  subcommands (`toggle`, `summary`, `rows <n>`, `subagent-rows <n>`,
  `subagents on|off`, `health on|off`, `placement above|below`, `reset`) in every
  mode, with a text report instead of a dialog when no UI is available.
- Durable options at `<agentDir>/extensions/mx-pi-context-stats.json` (honors
  `PI_CODING_AGENT_DIR`). Out-of-range numbers are clamped and invalid values
  ignored, so a malformed file cannot break the widget.
- `--mx-pi-context-stats-rows` and `--mx-pi-context-stats-hide` CLI flags that
  override the config file for a single run without persisting.
- Pure, injectable core (`src/*.ts`, no pi types beyond a minimal theme surface):
  time and the config path are injected, `format.ts` never emits `NaN`/`Infinity`,
  and `health.ts` returns `undefined` rather than `0` for unmeasurable metrics so
  callers omit the cell instead of rendering a misleading number.

### Changed

- Verified against pi 0.99.1 and bumped the dev dependencies
  (`@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` to `^0.99.1`).
  The peer range stays `>=0.80.0`. No source change was needed for 0.99: the
  extension uses no API removed between 0.82 and 0.99.
