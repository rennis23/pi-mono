# Plan: mx-pi-agents — secure agent registry and subagent runner

**Date:** 2026-09-18
**Status:** Implemented (phases 0–4 complete; phase 5 remains decision-gated)
**Design:** [`docs/superpowers/specs/2026-09-18-mx-pi-agents-design.md`](../specs/2026-09-18-mx-pi-agents-design.md)

---

## Phase gate

Background runs and `isolation: worktree` are **phase 2** pending your decision (design §10).
Everything below is v1 unless marked otherwise.

## Acceptance criteria

- Hostile repo config cannot influence any child session (settings and system-prompt assertions).
- Unapproved or changed project agents are refused before any session is created.
- Grants are exact and fail closed; inheritance degrades safely with diagnostics.
- No prompt text in argv; no session or transcript files in the target repo.
- Every run is capped by turn/time/token budgets with explicit partial-result semantics.
- `npm run check` and `npm test` green.

## Phase 0 — document and scaffold

1. [x] Commit the design spec and this plan (files already written).
2. [x] Create `packages/mx-pi-agents/`: `package.json` following `mx-pi-context-stats`
   conventions (`@rennis23/mx-pi-agents`, 0.1.0, `pi.extensions: ["./index.ts"]`, peer/dev deps
   on `pi-coding-agent` + `pi-tui`, `files` list), `LICENSE`, `CHANGELOG.md` with an
   `[Unreleased]` section, `README.md` and `SECURITY.md` skeletons, `src/`, `src/runners/`,
   `agents/`, `test/harness.ts`.
3. [x] Run `npm run check` and `npm test` to confirm the empty scaffold is clean in the monorepo.

## Phase 1 — pure core

1. [x] `src/types.ts`: `PinnedAgent`, `RunPlan`, `RunResult`, `Budgets`, `SourceKind`,
   `RefusalReason`, `Runner` interface.
2. [x] `src/frontmatter.ts` + tests: strict dependency-free YAML-subset parser. Aliases, anchors,
   tags, duplicate keys, nested maps, multi-doc → parse error. Decimals accepted (cost budgets);
   exponents and hex rejected.
3. [x] `src/schema.ts` + tests: all fields from design §6, name/description rules, unknown-field
   drop, and the effective-grant contract from design §4.4 (all five cases table-driven).
4. [x] `src/security.ts` + tests: control-char stripping, name/description sanitizers, SHA-256
   helper, realpath-containment helper for our own temp/audit paths.
5. [x] `src/config.ts` + tests: injectable `<agentDir>/extensions/mx-pi-agents.json` with
   `agentPaths`, `approvals`, `limits`; atomic temp+rename write; corrupt file → defaults +
   diagnostic.
6. [x] `src/registry.ts` + tests: discovery order, shadowing rule, pinning at session start,
   run-time hash re-verification, roster data.
7. [x] `src/trust.ts` + tests: source classification, approval gate (interactive confirm, stored
   hash match, headless refusal), persistence, re-approval on change.
8. [x] `src/policy.ts` + tests: `PinnedAgent + session context → RunPlan | refusal`; explicit
   unresolved tool ⇒ refuse; inherited unresolved ⇒ drop + diagnostic; empty grants ⇒
   `noTools: "all"`; model resolution check; runner/sandbox selection.
9. [x] `src/prompt.ts` + tests: child system prompt assembly (definition body + fixed runtime
   header), byte caps.
10. [x] `src/output.ts` + tests: per-result/total caps, truncation markers, redaction helper.
11. [x] `src/budget.ts` + tests: turn/time/token/cost accounting, defaults (30 turns, 10 min,
    250k tokens, cost opt-in), breach ⇒ abort + partial + reason.
12. [x] `src/concurrency.ts` + tests: bounded worker pool (≤8 tasks, ≤4 concurrent), abort
    propagation, no unbounded queues.

## Phase 2 — in-process runner and delegation modes

1. [x] `src/runner.ts` + `src/runners/in-process.ts` + tests: in-memory global-only settings,
   in-memory session, all-discovery-off loader, allowlist tools, `sandbox: os` bash override,
   subscribe/abort/dispose lifecycle.
2. [x] Model-free SDK integration tests: hostile `.pi/settings.json` and `.pi/skills/**` fixtures
   prove no influence on the child; tool registry equals the grant set.
3. [x] `src/modes.ts` + tests: single/parallel/chain over the injected `Runner`, `{previous}`
   substitution, fail-fast chain, parallel `allSettled`, cap refusals.
4. [x] `index.ts` + `index.test.ts` + `test/harness.ts`: tool `mx_pi_agent`, command
   `/mx-pi-agents list|approve|status`, `--mx-pi-agents-*` flags, session pinning, refusal when
   `MX_PI_AGENTS_CHILD=1`, renderer, fake-pi e2e coverage.
5. [x] Bundled agents `agents/{explorer,planner,reviewer,builder}.md` with explicit grants;
   document them in README.

## Phase 3 — subprocess runner and sandbox

1. [x] `src/runners/subprocess.ts` + tests: hardened argv (design §5.2), stdin task, 0600 temp
   system prompt, JSONL parsing with caps, process-group kill, recursion env marker. Test asserts
   the task never appears in argv.
2. [x] `src/runners/sandbox.ts` + tests: seatbelt profile generator and bwrap argv builder
   (write-cwd + tmp only, network deny), fail closed when the backend is unavailable.

## Phase 4 — documentation and hardening

1. [x] `SECURITY.md`: threat model, enforced/not-enforced table, pi-parity statement, decisions
   log, residual risk, sandbox usage, reporting.
2. [x] `test/security.test.ts`: one test per invariant in design §8 (43 tests).
3. [x] README: install, frontmatter reference, modes, config, commands, limits, bundled agents.
4. [x] Hardening review: pi-lens diagnostics on changed files, manual re-read of the four threat
   classes against the implementation, fix findings, record decisions in `SECURITY.md`.
   Findings fixed: (a) the in-process runner was constructed with `agentDir: ""`, so
   `<agentDir>/settings.json` resolved against `process.cwd()` — the target repository; the
   settings manager and loader now refuse an empty dir and `index.ts` threads one resolved dir
   everywhere. (b) an already-aborted signal still created a session/process; both runners now
   refuse before starting. (c) `whichBinary` treated an explicit `undefined` PATH as the ambient
   PATH. Each has a regression test.
5. [x] Final gates: `npm run check`, `npm test`, coverage; update `CHANGELOG.md` `[Unreleased]`.

## Phase 5 — decision-gated (not v1)

1. [ ] If approved: background runs with session-scoped delivery and no auto-triggered turns.
2. [ ] If approved: `isolation: worktree` with kept-worktree reporting and fail-closed git checks.
