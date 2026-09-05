# @rennis23/mx-pi-context-stats

Per-prompt context, token, cost and subagent stats for [pi.dev](https://pi.dev) — as a compact widget below the editor plus a single line on pi's built-in footer.

pi's own footer already shows cumulative usage, cache, cost, context % and model. This extension adds what it doesn't: **history** (how did I get here?), **rate** (how fast am I burning?), **projection** (how much room is left?) and **subagent breakdowns**.

## What it looks like

```
↑15k ↓2k  ctx:8.1%/128k  $0.009  ... (provider) model • high   ← pi's native footer
300tok/s  5.0s  ctx:6.3%                                       ← this extension's status line
────────────────────────────────────────────────────────────────
  context history
  #1  ctx:8.0k/128k  6.3%  ↑5.0k ↓1.0k  $0.003  3↩  300tok/s  5.0s  ←
  #2  ctx:18.0k/128k 14.1% ↑3.0k ↓1.0k  $0.0030 3↩  burn 8.0k/min  ~11 left  cache 70%
  #3  ctx:31.0k/128k 24.2% ↑4.0k ↓2.0k  $0.007  2↩  ⟳

  subagents
 ⏳ Explore  [read,grep,find,ls]  sonnet-4-5
      2↩  ↑8.0k ↓1.0k  ctx:10.0k  $0.004  live
 ✓ gap-analyzer  [read]  sonnet-4-5
      3↩  ↑15.0k ↓2.0k  ctx:18.0k  $0.005  400tok/s  5.0s
────────────────────────────────────────────────────────────────
```

- `context history` — one row per prompt: context size and %, in/out tokens, cost, turns, mean output tok/s and wall-clock duration. The newest row is marked `←`.
- Health cells on the current row — `burn` (tokens/minute), `~N left` (prompts remaining at the current growth rate) and `cache` (share of input served from cache).
- `⟳` marks the prompt that followed a compaction, so a sudden context drop is never mistaken for a bug.
- `subagents` — live status, tool list, model and cost for each spawned subagent.

The widget renders below the editor and above pi's footer, and hides itself when there is nothing to show yet.

## Install

```bash
pi install npm:@rennis23/mx-pi-context-stats
```

Requires pi ≥ 0.80 and Node.js 22+.

## Commands

| Command | Effect |
| --- | --- |
| `/mx-pi-settings` | Open the interactive settings picker (shows current values) |
| `/mx-pi-settings toggle` | Show/hide the widget |
| `/mx-pi-settings summary` | Print session totals, current context and subagent rollup |
| `/mx-pi-settings rows <n>` | History rows kept (1–20) |
| `/mx-pi-settings subagent-rows <n>` | Max subagent rows rendered (0–20) |
| `/mx-pi-settings subagents on\|off` | Show/hide the subagent section |
| `/mx-pi-settings health on\|off` | Show/hide burn rate, projection and cache cells |
| `/mx-pi-settings placement above\|below` | Move the widget above or below the editor |
| `/mx-pi-settings reset` | Clear the prompt history (session data only) |

In interactive sessions a bare `/mx-pi-settings` opens a picker listing every
option with its current value; in print/JSON mode it reports the values as text
instead. Option changes are **persisted** to the config file below and apply to
future sessions too. `summary` and `reset` never touch the config.

## Configuration

Options are durable JSON at `~/.pi/agent/extensions/mx-pi-context-stats.json`
(respects `PI_CODING_AGENT_DIR`). The file is created on the first change from
`/mx-pi-settings`, but can be hand-written; every key is optional:

```json
{
 "historyRows": 5,
 "subagentRows": 4,
 "maxWidgetLines": 10,
 "showSubagents": true,
 "showHealth": true,
 "visible": true,
 "placement": "belowEditor",
 "subagentToolNames": ["spawn_subagent"]
}
```

Out-of-range numbers are clamped and invalid values ignored, so a malformed
file can never break the widget.

## CLI flags

Per-run overrides that win over the config file without persisting:

```bash
pi --mx-pi-context-stats-rows 10 -p "explain recursion"
pi --mx-pi-context-stats-hide -p "just the answer"
```

## Subagent support

Any tool named in `subagentToolNames` (`spawn_subagent` by default) is tracked automatically. Progress payloads are parsed tolerantly — both `{ details: { usage, model, toolsUsed } }` and flatter `{ usage, model, tools }` shapes work, with `input`/`inputTokens`, `output`/`outputTokens`, `totalTokens`/`contextTokens` and `cost`/`cost.total` accepted interchangeably.

If no such tool is installed, the subagent section simply never appears — no warnings, no configuration.

## Development

This package is part of the `pi-mono` workspace. From the monorepo root:

```bash
npm install
npm run check   # biome + tsc
npm test        # vitest
```

## License

MIT
