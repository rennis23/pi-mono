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
| `/mx-pi-context-stats` | Print session totals, current context and subagent rollup |

Configure the widget through the central [`mx-pi-settings` hub](../mx-pi-settings/README.md):
`/mx-pi-settings` opens the searchable extension settings overlay, where you can
change history rows (1–20), subagent rows (0–20), section visibility, health
metrics, and widget placement. The hub persists those registered values for
future sessions. This extension does not maintain its own settings command or
config file.

## Configuration

Registered options are stored in the central file
`~/.pi/agent/extensions/mx-pi-settings.json` (respects `PI_CODING_AGENT_DIR`)
under the `mx-pi-context-stats` namespace. Configure values using the hub or
its `/mx-pi-settings set mx-pi-context-stats.<key> <value>` command. The file
is JSON and can also be edited directly; the settings hub validates values
against the provider's field spec before using them.

`maxWidgetLines` and `subagentToolNames` are internal runtime defaults rather
than registered user settings; the defaults are 10 and `["spawn_subagent"]`.

## CLI flags

The central hub provides run-scoped overrides, which win over persisted values
without writing them back:

```bash
pi --mx-pi-settings-set 'mx-pi-context-stats.historyRows=10' -p "explain recursion"
pi --mx-pi-settings-set 'mx-pi-context-stats.visible=false' -p "just the answer"
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

## Security

The extension runs inside the pi host process and uses the central settings
hub's shared config file under the active pi agent directory. It does not provide
process sandboxing or authenticate other local writers. See
[SECURITY.md](./SECURITY.md) for the threat model, enforced controls, residual
risks, and reporting route.

## License

MIT
