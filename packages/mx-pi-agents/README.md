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
call settles every task and reports per-task status. While a call runs, the
[live progress widget](#live-progress) shows each agent's state; Escape cancels.

## Direct invocation

In the interactive TUI you can invoke an agent directly from the prompt with a
`#` directive, without the model having to call the tool. A definition's `kind`
(see [agent kinds](#agent-kinds)) decides what a bare `#name` does: `persona`
and `main` switch the **main session**, `sub` delegates to a child.

```text
#explorer Where is the config loaded?      # switch (explorer defaults to main)
#reviewer                                  # switch and wait
#none                                      # reset to plain pi

#[planner > builder > reviewer, explorer] Add a health endpoint
```

The directive grammar:

| Syntax | Meaning |
| --- | --- |
| `#name [prompt]` | Switch the main session to a `persona`/`main` agent; with a prompt, send it under the new persona |
| `#name [prompt]` | Delegate to a `sub` agent (a prompt is required) |
| `#none` | Reset the main session to plain pi (takes no prompt) |
| `#[a > b] <prompt>` | Delegate: run `a`, then feed its output to `b` |
| `#[a, b] <prompt>` | Delegate: run `a` and `b` in parallel with the same prompt |
| `#[a > b, c > d] <prompt>` | Delegate: `a`; then `b` and `c` in parallel; then `d` |

Bracketed pipelines and the `mx_pi_agent` tool always run children, so a `sub`
agent without brackets is the only single-name form that delegates. `persona`
agents are refused as children everywhere; `main` agents may still run as
children. `none` is reserved and can never be a definition name.

Stages flow with cascade `{previous}`: stage 1 receives `<prompt>` and every
later stage receives the previous stage's combined output (for a parallel stage,
the successful results joined under `--- <agent> ---` headers). Up to 16 stages
are allowed, and a parallel group is capped at 8 agents.

Typing `#` at the start of an empty input opens autocomplete listing every
pinned agent with its kind badge, description and source, plus a built-in
`pi.dev [base]` row that inserts `#none`. It keeps completing after `[`, `>` and
`,` inside a bracket. `#` is an unambiguous prefix: input that starts with `#`
but does not parse is reported in the UI and **not** forwarded to the model, so
a prompt cannot accidentally begin with `#`.

Directives go through exactly the same trust gate, definition hash
re-verification, budgets and path scope as the `mx_pi_agent` tool. An unknown or
gated agent refuses with the same message. Only interactive input is
intercepted; RPC and extension-injected input are untouched, and directives are
disabled by `--mx-pi-agents-disable` along with the tool.

### Agent kinds

Every definition has a `kind` in frontmatter. It is optional and defaults to
`main`.

| `kind` | `#name` | As a child (tool / `#[…]`) | Prompt effect |
| --- | --- | --- | --- |
| `persona` | switches the main session, **replacing** the default prompt prefix | **refused** | body replaces the prompt preamble; pi's rules, docs, project context and cwd sections stay |
| `main` | switches the main session, **appending** to the system prompt | allowed | body appends as an addendum |
| `sub` | not switchable; `#name <task>` delegates | allowed | body is the child prompt (runtime header + body) |

A switch also applies the definition's `tools`, `model` and `thinking` as a
preset and restores the pre-switch values on `#none`. While it is active,
`skills` and `context_files` narrow what the resource loader puts into the
prompt: absent means every loaded entry, `[]` means none, a list is an
allow-list (unknown entries match nothing). pi loads resources at session
start, so a definition can only narrow: extension handlers, `/skill:*`
commands and extension-contributed prompt sections stay loaded. Child-only
fields (`scope`, `tools_inheritance`, `max_turns`, `timeout_ms`, `token_budget`,
`cost_budget`, `isolation`, `sandbox`) are ignored in main mode. The preset is
applied fail-closed: if any declared tool does not resolve in the main session,
or a declared model is unavailable, the whole switch is refused and nothing
changes.

A switch is scoped to the session. It is persisted as a non-context custom
entry and re-applied when the session is resumed (the prompt is always
re-derived; the preset is only re-applied when the runtime still reflects the
switch). The active switch is shown in the footer as `persona:<name>` or
`main:<name>`.

```markdown
---
name: reviewer
description: Review a diff for correctness and security
kind: persona
thinking: medium
---

You are a meticulous code reviewer. Report findings by severity and cite
file:line evidence.
```

### Live progress

While any delegation runs — a `#` directive or a model-invoked `mx_pi_agent`
call — a widget above the editor shows the whole chain: a spinner header with
the completed/total count and one row per stage with a status glyph.

```text
● Agents (1/3)  ⠋
├─ ✓ planner            done
├─ ◐ builder            running
└─ ○ reviewer, explorer waiting
```

- `◐` running, `○` waiting, `✓` done, `✗` failed, `⊘` cancelled.
- Agents in one stage run in parallel and share a row; stages run in sequence.
- Press **Escape** while a run is in progress to cancel it. Running and waiting
  agents are marked `⊘`; the result is recorded without starting a model turn.

### Child telemetry

Delegated agents run in isolated child sessions that load no extensions, so a
parent-session tracing extension (pi-phoenix, Langfuse, …) never sees their
model calls or tool executions on its own. To make child runs traceable without
weakening that isolation, each child loads exactly one **inline** extension
constructed in-process by the runner (inline factories bypass `noExtensions`),
which re-publishes the child's lifecycle events on the shared extension event
bus, `pi.events`:

```ts
pi.events.on("mx-pi-agents:child-telemetry", (envelope) => {
   // envelope.delegationId  shared by every agent in one call
   // envelope.runId         unique per child run
   // envelope.agent         the named agent, e.g. "explorer"
   // envelope.parentSessionId / envelope.childSessionId
   // envelope.event         the raw child extension event
});
```

Forwarded events are the span-building set: `session_start`, `session_shutdown`,
`before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `context`,
`before_provider_request`, `before_provider_headers`, `after_provider_response`,
`message_end`, `turn_end`, `tool_execution_start` and `tool_execution_end`.
Streaming events (`message_update`, `tool_execution_update`) are deliberately
not forwarded. Publishing is best-effort: a missing bus, a throwing subscriber
or a slow consumer can never disturb a child run.

mx-pi-agents only publishes; it does not ship a tracer. A consumer extension
subscribes to the channel and builds spans from the events. The **subprocess**
runner (`isolation: subprocess`) runs in a separate process and cannot share
this bus, so it publishes nothing.

## Bundled agents

| Agent | Tools | Purpose |
| --- | --- | --- |
| `explorer` | read, grep, find, ls | Read-only reconnaissance with `path:line` evidence |
| `planner` | read, grep, find, ls | Ordered implementation plan with risks and verification steps |
| `reviewer` | read, grep, find, ls | Defect-focused code review, severity-ranked |
| `builder` | read, grep, find, ls, edit, write, bash | Scoped implementation with tests and self-verification |
| `socrates` | none (persona) | Socratic questioning of a problem with a chosen number of questions; proposes no answers |

`builder` is the only bundled agent with write access and a shell; its `bash`
runs under `sandbox: os`, and every bundled file tool is path-confined to the
run scope. `socrates` is the bundled `persona` with no tools, skills or project
context at all: switch to it with `#socrates`, describe a problem, and choose a
question depth of `1-3`, `3-5`, `7-9` or `10-12`.

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
| `name` | yes | `[a-z0-9][a-z0-9_-]{0,63}` | Identity; also the `agent` value in tool calls. `none` is reserved |
| `description` | yes | ≤ 512 chars | Shown in the roster |
| `kind` | no | `main` (default), `persona`, `sub` | What a bare `#name` does. See [agent kinds](#agent-kinds) |
| `tools` | no | list of tool names | **Absent ≠ empty.** `[]` means no tools |
| `skills` | no | list of skill names | Main-session (`persona`/`main`) skill allow-list. Absent = all loaded skills; `[]` = none; unknown names match nothing |
| `context_files` | no | list of paths | Main-session project-context allow-list. An entry matches the absolute path, the cwd-relative path or the basename. Absent = all loaded files; `[]` = none |
| `tools_inheritance` | no | `none` (default), `parent` | Ignored when `tools` is present |
| `scope` | no | list of paths | Directory roots this agent may touch. Absent = the run's cwd; `[]` is a refusal. Must be beneath the config ceiling and below cwd |
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

## Path scope

Every granted file tool is confined to the run's scope. The default scope is the
run's cwd and nothing else — no `$HOME`, no temp dir, no parent directory. An
out-of-scope read, write or search is refused.

- An agent may declare `scope: ["relative/dir", "/absolute/dir"]` to narrow the
  config `scope` ceiling. `scope: []` is a refusal, and so is any entry that is
  cwd, an ancestor of cwd, outside the ceiling, or not an existing directory.
- A run that cannot be path-confined — `bash` with `sandbox: none`, or
  `isolation: subprocess` — is refused (`scope-unenforceable`) under the default
  ceiling. The only way to license such a run is an explicit `scope: ["/"]`
  ceiling in the config, which the `/mx-pi-agents status` output reports as
  `unconfined runs: allowed`.
- `sandbox: os` confines the child's reads to the run scope plus an immutable OS
  runtime allowance, and its writes to the run scope.

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
/mx-pi-agents status    # config path, counts, limits, scope, sandbox availability
/mx-pi-agents refresh   # re-pin the registry from disk
```

## Configuration

`<agentDir>/extensions/mx-pi-agents.json`:

```json
{
  "version": 1,
  "agentPaths": ["~/team-agents", "./shared/agents"],
  "scope": ["/srv/team"],
  "approvals": {},
  "limits": { "maxTurns": 40, "timeoutMs": 600000, "tokenBudget": 300000 }
}
```

`limits` are **ceilings**: an agent may tighten them, never loosen them. An
agent declaring `max_turns: 900` under a ceiling of `40` runs with `40`.

`scope` is a **ceiling** in the same sense: the maximum directory roots any run
may reach. Absent means the run's cwd. An agent declaring `scope: ["sub/dir"]`
is confined to that subdirectory; an entry at or above the cwd, outside the
ceiling, or that does not resolve to an existing directory refuses the run.

A corrupt config file falls back to defaults with a diagnostic; it never blocks
a session.

### Flags

| Flag | Effect |
| --- | --- |
| `--mx-pi-agents-list` | Print the roster on startup |
| `--mx-pi-agents-disable` | Disable `mx_pi_agent` and `#` directives for this run |

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
