# Design: mx-pi-agents — secure agent registry and subagent runner

**Date:** 2026-09-18
**Status:** Draft — awaiting review
**Package:** `packages/mx-pi-agents/` → `@rennis23/mx-pi-agents`

---

## 1. Goal

A pi extension that lets a session define named agents (system prompt + capability grants) and
delegate tasks to them, with a security posture that is explicit, fail-closed, and documented:

- untrusted repository content can never influence a child session's resources or settings;
- a child gets exactly the capabilities its definition declares — never "everything because a
  field was missing or failed to parse";
- every run is bounded (turns, wall-clock, tokens/cost) and leaves no residue (no on-disk
  sessions, no transcripts in the target repo, no cross-session delivery);
- boundaries that are *not* enforced (prompt injection, unsandboxed `bash` under an explicit `/`
  ceiling, the OS runtime allowance inside `sandbox: os`) are stated plainly in `SECURITY.md`, in the
  same boundary language pi uses.

## 2. Background: what the reviewed implementations got right and wrong

Two existing solutions were analyzed before this design.

**pi-code (`/Users/toru/project/pi-code`)** — out-of-process: one `pi --mode json` child per task.

- Works: fail-closed frontmatter parsing (a bad `tools:`/`isolation:` drops the whole agent), a
  project-agent approval gate, no shell anywhere, process-group kill, worktree isolation.
- Weak: the task prompt is passed in `argv` (S1); Claude-style MCP deny entries silently no-op
  (S2/S3); an empty `tools:` list means "all tools" (S4); `memory:` silently widens the grant (S5);
  background completion auto-triggers a parent turn and can cross projects (S6); child transcripts
  persist (S7).

**piolium (`/Users/toru/project/piolium`)** — in-process: `createAgentSession` children.

- Works: authoritative name-based tool allowlist, empty allowlist fails closed, no project agent
  manifests, no extensions/context files/prompt templates in children, in-memory sessions.
- Critical: the audited repo's `.pi/settings.json` sets `shellCommandPrefix`/`shellPath`, giving
  unconditional host code execution with no model cooperation (P-01). High: repo-controlled
  `.pi/skills` injects attacker text into the child **system prompt** (P-02). Also: output paths
  are prose-only (P-03), symlink-following writes (P-04), unredacted transcripts inside the target
  repo (P-05), no cost/time budget (P-06).

**Lesson.** The *capability* layer (name-based allowlists, fail-closed parsing) held up. The
*resource-loading* layer (settings, skills, context files) is where every serious finding lives.
This design makes resource loading structurally inert for children and computes capabilities
fail-closed at session start.

## 3. Threat model

**Assets.** Operator host files, credentials, shell, and `~/.pi/**`; provider credentials and
quota; integrity of delegated results; confidentiality of prompts and transcripts.

**Adversary.** (1) Anyone who controls content in the target tree, including `.pi/**` and
symlinks; (2) content an agent reads (source, docs, web) attempting prompt injection; (3)
third-party agent/skill definitions; (4) confused-deputy behavior across the child↔parent boundary
(argv exposure, transcripts, cross-session delivery, recursion).

**Non-goals.** The pi host platform; provider/LLM trust; OS-level isolation of the whole pi
process (that is what containers/micro-VMs are for, per pi's own security docs).

| # | Boundary | Attacker control | Control that must hold |
| --- | --- | --- | --- |
| B1 | cloned repo → parent session | `.pi/settings.json`, `.pi/skills`, `.pi/agents`, symlinks | child sessions load **none** of it; project agents gated by approval + hash |
| B2 | parent session → child | agent definition, task text, grants | grants computed fail-closed; task via stdin (subprocess) or direct call; no shell |
| B3 | child → parent | child output, usage, errors | capped, parsed as data, returned only as a tool result; no auto-triggered turns |
| B4 | child → host OS | granted tools (`bash`, `write`, …) | pi-parity: capability grants only, documented; optional `sandbox: os` for bash |
| B5 | definition file on disk → run | mid-session file edits | definitions pinned at `session_start`; hash re-verified at run time |

## 4. Locked decisions

1. **Threat classes:** all four above (repo config, prompt injection, untrusted definitions,
   cross-boundary leakage).
2. **Isolation:** hybrid per agent. `isolation: process` (default) runs an in-process SDK session;
   `isolation: subprocess` spawns a `pi` child. Container is a later profile, not v1.
3. **Tool governance = pi parity plus path scope.** A granted file tool behaves exactly like pi's version
   of that tool *inside the run scope*; the only addition is a path-containment check at
   `ToolDefinition.execute` (invariant 11). A vector that cannot be path-confined (unsandboxed `bash`,
   `isolation: subprocess`) is refused rather than run. `sandbox: os` is an opt-in per-agent bash sandbox
   (seatbelt on macOS, bubblewrap on Linux) that refuses the run when unavailable.
4. **Grants contract (total, never additive):**

   | Declaration | Effective tools |
   | --- | --- |
   | `tools: [read, grep]` | `{read, grep}` exactly |
   | `tools: []` | ∅ |
   | `tools` absent + `tools_inheritance: none` (default) | ∅ |
   | `tools` absent + `tools_inheritance: parent` | parent active tools minus spawn-capable names |

   `tools_inheritance` is ignored when `tools` is present. No `disallowed_tools` field: the
   allowlist is the entire contract, so a deny list can never silently no-op (pi-code S2/S3).
5. **Sources.** Bundled `<package>/agents/` and global `<agentDir>/agents/` are trusted. Project
   `<cwd>/.pi/agents/` and every `agentPaths` entry in the extension config are gated. A gated
   definition that shadows a trusted one is dropped with a diagnostic (no silent override).
6. **Project gate.** Explicit approval + hash pinning: an interactive confirm lists the agent
   names and short hashes; the approval is stored per real directory with per-file SHA-256. Any
   file change invalidates it. Headless sessions refuse gated agents unless a matching approval
   already exists. Definitions are resolved at `session_start` and re-hashed at spawn.
7. **Top-level agents = registry level only.** v1 implements subagent delegation; a future
   "main-session persona" could reuse the same pinned registry without redesign.
8. **v1 scope:** single + parallel + chain delegation with mandatory budgets. Background runs and
   `isolation: worktree` are phase-2 items behind an explicit decision (see §10).
9. **Documentation is a deliverable.** `SECURITY.md` contains the threat model, an
   enforced/not-enforced table, the parity statement, the decisions log, and residual risk.

## 5. Architecture

```text
packages/mx-pi-agents/
├── index.ts                     # thin pi wiring: tool, command, flags, session pinning
├── index.test.ts                # end-to-end via test/harness.ts
├── agents/                      # bundled definitions (explicit grants)
│   ├── explorer.md  planner.md  reviewer.md  builder.md
├── src/
│   ├── types.ts                 # PinnedAgent, RunPlan, RunResult, Budgets, Runner
│   ├── frontmatter.ts           # strict dependency-free YAML-subset parser
│   ├── schema.ts                # field validation + effective-grant computation
│   ├── registry.ts              # discovery, precedence, pinning, shadowing rules
│   ├── trust.ts                 # source classification + approval gate + hash pinning
│   ├── policy.ts                # PinnedAgent + session ctx → RunPlan | refusal
│   ├── config.ts                # <agentDir>/extensions/mx-pi-agents.json
│   ├── prompt.ts                # child system prompt assembly (capped)
│   ├── output.ts                # result capping/truncation/redaction
│   ├── budget.ts                # turn/time/token/cost accounting
│   ├── concurrency.ts           # bounded worker pool
│   ├── modes.ts                 # single/parallel/chain over an injected Runner
│   ├── runner.ts                # Runner interface + selection
│   ├── runners/
│   │   ├── in-process.ts        # createAgentSession, hardened
│   │   ├── subprocess.ts        # spawned pi child, stdin prompt
│   │   └── sandbox.ts           # seatbelt / bwrap wrappers
│   ├── render.ts                # TUI rendering of call/results
│   └── security.ts              # sanitizers, hashing, containment helpers
├── test/harness.ts              # fake pi API (emit, runCommand, render)
├── README.md  SECURITY.md  CHANGELOG.md  LICENSE  package.json
```

`index.ts` owns no computation: it registers the tool, the `/mx-pi-agents` command, and
`--mx-pi-agents-*` flags, pins the registry on `session_start`, and delegates everything to `src/`.

### 5.1 In-process runner

- Settings: `SettingsManager.inMemory(global-only settings)` — built by reading user-global settings
  with a neutral cwd, never `SettingsManager.create(targetCwd)`. This is the piolium P-01 fix made
  structural: a child has no code path that reads `<target>/.pi/settings.json`.
- Session: `SessionManager.inMemory()` — no files anywhere.
- Resources: `DefaultResourceLoader` with `noExtensions`, `noSkills`, `noPromptTemplates`,
  `noThemes`, `noContextFiles` all `true`; `systemPrompt` = definition body + minimal runtime
  header. This is the P-02 fix: project skills cannot reach the child system prompt because skill
  discovery is off entirely.
- Tools: `tools: [...grants]`, or `noTools: "all"` when the grant set is empty. The child has no
  extensions loaded, so `mx_pi_agent` cannot exist inside it (recursion impossible in-process).
- `sandbox: os` + `bash` granted: a custom bash `ToolDefinition` whose `BashOperations` execute the
  command through the platform sandbox (write-cwd-only, network deny).
- Lifecycle: `session.subscribe(...)` for streaming/usage, `session.abort()` on breach/abort,
  `session.dispose()` in `finally`.

### 5.2 Subprocess runner

- Spawn the pi executable with `shell: false` and an argv array:
  `--mode json -p --no-session --no-approve --no-extensions --no-skills --no-prompt-templates
  --no-themes --no-context-files --tools <grants> [--model …] [--thinking …]
  --system-prompt <0600 temp file>`.
- The **task goes over stdin**, never argv (pi-code S1 fix); the system prompt body goes in a
  `mkdtemp` 0700 directory as a 0600 file, path only in argv, unlinked in `finally`.
- `--no-approve` keeps project-local files out of the child even when the parent trusted the repo.
- `MX_PI_AGENTS_CHILD=1` is set so the extension refuses to register or run inside a child
  (defense in depth).
- stdout JSONL is parsed line-by-line with bounded accumulation; stderr is a capped tail;
  abort kills the process group (SIGTERM, then SIGKILL).
- `sandbox: os` wraps the spawn in `sandbox-exec` (macOS) or `bwrap` (Linux); unavailable backend
  ⇒ refuse the run.

### 5.3 Orchestration

- Tool `mx_pi_agent` with exactly one of: `{agent, task}` (single), `{tasks: [...]}` (parallel,
  ≤8 tasks, ≤4 concurrent, allSettled), `{chain: [...]}` (sequential, `{previous}` functional
  substitution, fail-fast with `stoppedAt`).
- Results are returned as a tool result only — capped text for the model plus structured details
  for the renderer. No `pi.sendMessage`, no run registry that outlives the session (pi-code S6
  fix by construction).
- Every child is bounded by `budget.ts`: default `max_turns: 30`, `timeout_ms: 600000`,
  `token_budget: 250000`, cost opt-in; a breach aborts, marks the result partial, and reports the
  reason. Agents may tighten; config ceilings bound what can be loosened.

## 6. Agent definition format

```md
---
name: reviewer
description: Read-only code review of the current diff
tools: [read, grep, find, ls]
model: <concrete-model-id>
thinking: medium
max_turns: 20
timeout_ms: 300000
isolation: process
sandbox: none
---

You are a review agent. Report findings as a list, most severe first.
```

Fields: `name`, `description` (required); `tools`, `tools_inheritance` (`none|parent`), `scope` (path
list; absent means cwd), `model`,
`thinking`, `max_turns`, `timeout_ms`, `token_budget`, `cost_budget`, `isolation`
(`process|subprocess`), `sandbox` (`none|os`). Unknown fields drop the definition with a
diagnostic. The parser is a strict, dependency-free YAML subset (flat scalars, string lists,
ints, booleans); aliases, anchors, tags, duplicate keys, nested maps, and multi-document files are
parse errors, so there is no YAML-bomb surface and no ambiguity about what was declared.

Explicit `tools:` names must resolve in the child or the run is refused. Inherited names that do
not resolve are dropped with a diagnostic — inheritance is convenience, explicit grants are
intent.

## 7. Trust, approval, and pinning

- Discovery: `bundled → global → agentPaths (config order) → project`. Gated definitions that
  shadow a trusted name are dropped with a diagnostic.
- `session_start`: load every definition, compute SHA-256, store `PinnedAgent` records in memory.
- Spawn: re-read and re-hash the file; a mismatch refuses the run ("definition changed since
  session start").
- Approval UI: one confirm listing name, source, and short hash per gated agent; stored in
  `<agentDir>/extensions/mx-pi-agents.json` under `approvals` keyed by real directory.
- Headless: gated agents run only when a stored approval matches current hashes.
- `/mx-pi-agents list` shows the roster with source/trust/hash; `/mx-pi-agents approve` re-runs the
  gate.

## 8. Security invariants (must hold after implementation)

1. No code path constructs a child session with a project-scoped settings manager or loader.
2. Child resource discovery is disabled entirely; the system prompt contains only the definition
   body and a fixed runtime header.
3. Grants are computed by the total contract in §4.4; never inferred, never widened by another
   field.
4. Every error path in definition loading drops the definition or refuses the run — never runs
   unrestricted.
5. No task or prompt content ever appears in a spawned process's argv.
6. No session file, transcript, or run artifact is written inside the target repository.
7. Child output is returned as capped data; it never triggers a parent turn and never crosses a
   session boundary.
8. Children cannot spawn children (`mx_pi_agent` is not in any child grant and the extension
   refuses when `MX_PI_AGENTS_CHILD=1`).
9. All UI text derived from definitions is control-character stripped.
10. Every run is bounded by turn, wall-clock, and token/cost budgets with partial-result semantics.
11. A child run cannot touch a path outside its granted scope. An absent, unparsable or unresolvable scope
    is a refusal, never "unrestricted". A vector that cannot be path-confined (unsandboxed `bash`,
    `isolation: subprocess`) is refused unless the config ceiling is an explicit `/`.

## 9. Testing strategy

- **Pure unit tests** for frontmatter, schema, registry, trust, policy, budget, output, sandbox
  command generation (golden strings). Hostile inputs are table-driven: YAML aliases/bombs,
  duplicate keys, wrong types, unknown fields, empty vs absent `tools`, names with control
  characters, path traversal in temp names.
- **Model-free SDK integration tests** for the in-process runner: assert the loader reports no
  skills, the system prompt has no trace of a hostile `.pi/skills/evil/SKILL.md`, the tool registry
  is exactly the grant set, and a hostile `.pi/settings.json` with `shellCommandPrefix` has no
  effect.
- **Fake-pi e2e tests** via `test/harness.ts` for `index.ts`: session pinning, approval refusals,
  mode dispatch, caps, budget abort.
- **Acceptance suite** `src/security.test.ts` mapping one test per §8 invariant.

## 10. Open decision

v1 scope for background runs (`background: true`, status/cancel/resume) and
`isolation: worktree`. Recommendation: ship v1 as specified, then add them as phase 2 with
session-scoped delivery (no auto-triggered turns) and kept-worktree reporting. This decision does
not change the architecture.
