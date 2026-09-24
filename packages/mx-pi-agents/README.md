# @rennis23/mx-pi-agents

Secure agent registry and subagent runner for [pi.dev](https://pi.dev).

Define named agents as markdown files (system prompt + capability grants), then
delegate tasks to them. The security posture is explicit and fail-closed: a
child gets exactly the capabilities its definition declares, project agents
require approval, and every run is bounded.

## Why

Subagent extensions are easy to get subtly wrong. This one is built around four
rules:

1. **Repository content never reaches a child.** No project settings, skills,
   context files or extensions are loaded into a child session — structurally,
   not by filtering.
2. **Grants are total.** An empty `tools:` means *no tools*, never "all tools".
   There is no deny list that can silently no-op.
3. **Definitions are pinned.** A file edited after session start refuses the run
   rather than executing something that was never reviewed.
4. **Every run is bounded** by turns, wall-clock and tokens, with explicit
   partial-result semantics.

See [SECURITY.md](./SECURITY.md) for the full threat model and, importantly, for
what is *not* enforced.

## Install

```bash
pi install npm:@rennis23/mx-pi-agents
```

Or from a checkout:

```bash
pi -e ./packages/mx-pi-agents
```

## Usage

The model calls `mx_pi_agent` in one of three modes:

```jsonc
// single
{ "agent": "explorer", "task": "Where is the config loaded?" }

// parallel — up to 8 tasks, up to 4 concurrent
{ "tasks": [
  { "agent": "explorer", "task": "Find the auth entry point" },
  { "agent": "reviewer", "task": "Review src/auth.ts for issues" }
]}

// chain — sequential; {previous} is replaced by the prior step's output
{ "chain": [
  { "agent": "explorer", "task": "Find the auth entry point" },
  { "agent": "reviewer", "task": "Review this for security issues:\n{previous}" }
]}
```

A chain stops at the first failed step and reports where it stopped. A parallel
call settles every task and reports per-task status.

## Bundled agents

| Agent | Tools | Purpose |
| --- | --- | --- |
| `explorer` | read, grep, find, ls | Read-only reconnaissance with `path:line` evidence |
| `planner` | read, grep, find, ls | Ordered implementation plan with risks and verification steps |
| `reviewer` | read, grep, find, ls | Defect-focused code review, severity-ranked |
| `builder` | read, grep, find, ls, edit, write, bash | Scoped implementation with tests and self-verification |

`builder` is the only bundled agent with write access and a shell. Grant it only
where that is appropriate.

## Writing an agent

Create `<agentDir>/agents/my-agent.md` (global, trusted) or
`<cwd>/.pi/agents/my-agent.md` (project, gated behind approval):

```markdown
---
name: my-agent
description: What this agent does, in one line
tools: [read, grep]
model: anthropic/claude-sonnet-4-5
thinking: medium
max_turns: 20
timeout_ms: 300000
token_budget: 150000
isolation: process
sandbox: none
---

You are a review agent. Report findings as a list, most severe first.
```

### Frontmatter reference

| Field | Required | Values | Notes |
| --- | --- | --- | --- |
| `name` | yes | `[a-z0-9][a-z0-9_-]{0,63}` | Identity; also the `agent` value in tool calls |
| `description` | yes | ≤ 512 chars | Shown in the roster |
| `tools` | no | list of tool names | **Absent ≠ empty.** `[]` means no tools |
| `tools_inheritance` | no | `none` (default), `parent` | Ignored when `tools` is present |
| `model` | no | `provider/model-id` or model id | Must resolve with configured credentials |
| `thinking` | no | `off`…`max` | Clamped to the model's capabilities |
| `max_turns` | no | 1–1000 | Default 30; config ceiling wins if lower |
| `timeout_ms` | no | ≥ 1000 | Default 600000 |
| `token_budget` | no | ≥ 1000 | Default 250000 |
| `cost_budget` | no | ≥ 0 | Opt-in; unset means no cost ceiling |
| `isolation` | no | `process` (default), `subprocess` | In-process SDK session, or a spawned `pi` child |
| `sandbox` | no | `none` (default), `os` | Sandboxes the child's `bash` tool only |

**Unknown fields drop the definition.** So does any parse error, a missing body,
or an invalid name. There is no partial acceptance.

### Effective tools

| Declaration | Effective tools |
| --- | --- |
| `tools: [read, grep]` | `{read, grep}` exactly |
| `tools: []` | ∅ |
| `tools` absent, `tools_inheritance: none` | ∅ |
| `tools` absent, `tools_inheritance: parent` | parent's active tools minus spawn-capable names |

Explicit names that do not resolve refuse the run. Inherited names that do not
resolve are dropped with a diagnostic. Spawn-capable names (`mx_pi_agent`,
`subagent`, `spawn_subagent`, `subagent_task`, `Task`) are never granted.

## Trust and approval

| Source | Path | Trust |
| --- | --- | --- |
| bundled | package `agents/` | trusted |
| global | `<agentDir>/agents/` | trusted |
| config | each `agentPaths` entry | **gated** |
| project | `<cwd>/.pi/agents/` | **gated** |

A gated definition that shadows a trusted name is dropped with a diagnostic — a
repository cannot override a globally installed agent.

Gated agents need approval, which pins the file's SHA-256. Any edit invalidates
the approval. Headless sessions refuse gated agents unless a matching approval
already exists.

```bash
/mx-pi-agents list      # roster with source, trust and pinned hash
/mx-pi-agents approve   # review and approve gated agents
/mx-pi-agents status    # config path, counts, limits, sandbox availability
/mx-pi-agents refresh   # re-pin the registry from disk
```

## Configuration

`<agentDir>/extensions/mx-pi-agents.json`:

```json
{
  "version": 1,
  "agentPaths": ["~/team-agents", "./shared/agents"],
  "approvals": {},
  "limits": { "maxTurns": 40, "timeoutMs": 600000, "tokenBudget": 300000 }
}
```

`limits` are **ceilings**: an agent may tighten them, never loosen them. An
agent declaring `max_turns: 900` under a ceiling of `40` runs with `40`.

A corrupt config file falls back to defaults with a diagnostic; it never blocks
a session.

### Flags

| Flag | Effect |
| --- | --- |
| `--mx-pi-agents-list` | Print the roster on startup |
| `--mx-pi-agents-disable` | Disable `mx_pi_agent` for this run |

## Limits

| Limit | Value |
| --- | --- |
| Parallel tasks per call | 8 |
| Concurrent children | 4 |
| Default turns per child | 30 |
| Default wall-clock per child | 10 minutes |
| Default tokens per child | 250,000 |
| Per-result output cap | 32 KiB |
| Total output cap | 128 KiB |
| Definition size (system prompt) | 64 KiB |

## Development

```bash
npm test --workspace @rennis23/mx-pi-agents
npm run check
```

`src/` is pure logic with no pi types (except the minimal `ThemeLike` surface in
`render.ts`), so every module is unit-testable without loading pi or a TUI.
`test/harness.ts` is a fake pi API used to drive `index.ts` end to end.
`src/runners/in-process.test.ts` builds real SDK sessions with no model call to
prove the resource-loading invariants.

## License

MIT
