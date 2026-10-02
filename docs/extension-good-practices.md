# Extension Good Practices & Documentation Guide

**Purpose.** This is the preparation document for writing and documenting a
pi.dev extension in this monorepo. It collects the practices that held up under
review, the failure modes they prevent, and the analysis behind them, so that a
new extension (or a revision of an existing one) can be designed and documented
against a single checklist.

**How to use it.**

1. Read part 1–2 before writing code; they are the design rules.
2. Use part 4 and part 6 as the documentation brief for `README.md` /
   `SECURITY.md`.
3. Use part 5 and Appendix A as the evidence base: every practice is traceable
   to a concrete finding in a reviewed implementation.
4. `packages/mx-pi-agents` is the reference implementation. Its `SECURITY.md`
   and `src/security.test.ts` are the worked example of everything here.

**Relationship to existing docs.** Repository conventions live in
[`../AGENTS.md`](../AGENTS.md); completion criteria in
[`../DOD-AGENT.md`](../DOD-AGENT.md); the reference security doc in
[`../packages/mx-pi-agents/SECURITY.md`](../packages/mx-pi-agents/SECURITY.md).
This guide does not replace them — it explains *why* they are what they are and
turns them into a reusable brief.

---

## 0. The extension contract

A pi extension is a default-exported factory that receives the pi API:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
   // register tools, commands, flags, event handlers
}
```

- `package.json` must carry `"pi": { "extensions": ["./index.ts"] }`.
- There is no build step. The published artifact is TypeScript source; `files`
  lists `index.ts`, `src/**`, `README.md`, and (for security-bearing packages)
  `SECURITY.md`, `LICENSE`.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are peer
  dependencies with a publish constraint (`>=0.80.0`), plus dev dependencies for
  local development.
- Registration happens at factory time; anything that must observe a live
  session (settings, cwd, session file, trust) is deferred to an event.

### The layering rule

Keep `index.ts` a **thin wiring layer** and put every decision in `src/`:

| Layer | Owns | Must not |
| --- | --- | --- |
| `index.ts` | `pi.on`, `pi.registerTool`, `pi.registerCommand`, flags, widget registration, session pinning | compute policy, parse untrusted formats, touch `Date.now()` directly |
| `src/*.ts` | pure logic: parsing, policy, budgets, rendering, containment | import pi types (except a minimal theme/registry surface) |

This is what makes every security decision unit-testable without loading pi or a
TUI, and it is why the reference package can assert its invariants in plain
Vitest.

---

## 1. Repository and package hygiene

| Practice | Why | Failure it prevents |
| --- | --- | --- |
| Package named `@rennis23/mx-pi-<name>`, directory `packages/mx-pi-<name>/`, all user-visible names (commands, flags) prefixed `mx-pi-` | One convention, one prefix; command/flag collisions stay visible | Ambiguous ownership; a command shadowing another extension's |
| Co-located tests `*.test.ts` next to each source file | The test names become the specification | Untested branches, especially error paths |
| No `postinstall`/`prepare` scripts in a published extension | Install-time code is the highest-trust hook in npm | Supply-chain execution on `npm install` |
| Lockfile committed with integrity hashes; exact versions for runtime deps | Reproducible install | Registry substitution, silent range drift |
| `files` allowlist is explicit | Only what is intended ships | Leaking test fixtures, plans, or dev config into the tarball |
| Versions in lockstep via `npm run release:*` | One release train | Version skew across peer deps |
| `CHANGELOG.md` with an `[Unreleased]` section | Releases record change | "What changed?" archaeology |
| `npm run check` + `npm test` green before commit | Biome + `tsc` + Vitest are the gate | Style/type/test regressions |

---

## 2. Security good practices

Every entry is: **practice → why → the failure mode it prevents → how to verify.**
The reference implementation and the reviewed findings behind each are in part 5.

### 2.1 Trust boundaries (write them down first)

- **Practice.** Before code, write the boundary table: for each asset, name who
  controls the input, what crosses the boundary, and which control holds. Model
  it as B1…Bn (repo→parent, parent→child, child→parent, child→host, disk→run).
- **Why.** Security work without a named boundary turns into unfalsifiable
  "we validate input" prose. A boundary table makes each claim testable.
- **Prevents.** Controls that are implied rather than enforced; a reviewer
  assuming a boundary exists because a related one does.
- **Verify.** One test per boundary that fails loudly and names the invariant.
- **Reference:** `mx-pi-agents/SECURITY.md` §1–2; `src/security.test.ts`.

### 2.2 Fail-closed, total grants

- **Practice.** Compute capabilities; never infer them. Define the allowlist as
  the *entire* contract, with explicit states for absent vs empty, and no branch
  that yields "unrestricted" as a fallback.
- **Why.** A missing field, an unknown value, or a parse error is exactly when an
  attacker benefits from a permissive default.
- **Prevents.** `tools: []` meaning "all tools"; a deny list silently no-opping
  against an allowlist; a malformed definition widening a grant.
- **Verify.** Exhaustive state tests: declared / empty / absent+none /
  absent+inherit / unknown field / unparseable / unresolvable name.
- **Reference:** invariants 3–4.

### 2.3 Resource loading is structural, not filtered

- **Practice.** A spawned child must not load project settings, skills, prompt
  templates, themes, context files, or extensions. Achieve it by never
  constructing the loader with a project cwd — not by filtering its output.
- **Why.** Filtering assumes you enumerated every channel; the resource-loading
  layer is where the serious findings live because it is easy to miss one
  (`shellPath`, `shellCommandPrefix`, `AGENTS.md`, `.pi/skills`).
- **Prevents.** Repo-controlled settings granting unconditional host code
  execution; repo-controlled skills injecting text into the child system prompt.
- **Verify.** Construct a *real* child session and assert its project settings
  are empty and its system prompt contains no repo content.
- **Reference:** invariants 1–2; design spec §2 (P-01, P-02).

### 2.4 Pin untrusted definitions, re-verify at use

- **Practice.** Read and hash every definition at `session_start`; re-read and
  re-hash at spawn. Refuse on missing file or changed hash. Tie approvals to the
  exact hash.
- **Why.** Review-at-T0 / execute-at-T1 is a TOCTOU race on the filesystem.
- **Prevents.** A definition edited between approval and execution.
- **Verify.** Mutate the file after pinning; assert refusal; assert an approval
  is invalidated by an edit.
- **Reference:** invariant 4; `src/registry.ts`, `src/trust.ts`.

### 2.5 No secrets or task text in process `argv`

- **Practice.** Pass a task over stdin or a direct call, never `argv`. A system
  prompt goes through a `0600` temp file in a `0700` directory, removed in
  `finally`.
- **Why.** `argv` is world-readable via `ps` and has a hard length limit.
- **Prevents.** Prompt/transcript disclosure to other local processes; silent
  truncation of a long task.
- **Verify.** Assert the task and body never appear in captured argv; assert the
  temp path is outside the target tree and cleaned up.
- **Reference:** invariant 5.

### 2.6 Child output is data, never a trigger

- **Practice.** Return child results as tool results only. Cap per result and in
  aggregate with an explicit truncation marker. Redact credential-shaped values
  before returning. No child completion may cross a session boundary or start a
  parent turn; if a delivery path exists, it must be session-scoped and
  interactive-only.
- **Why.** A completion that auto-triggers a turn is a confused deputy: a child
  can steer the parent.
- **Prevents.** Cross-session delivery; a child causing the parent to act;
  unbounded output; secret echoes.
- **Verify.** Cap tests (single + aggregate), a "results are data" test, and a
  redaction test.
- **Reference:** invariant 7; design spec §2 (S6).

### 2.7 Bound every run, scope every path

- **Practice.** Apply turn, wall-clock, token (and optionally cost) budgets with
  explicit partial-result semantics; a definition may tighten a config ceiling
  but never loosen it. Confine file-tool paths to the run scope, defaulting an
  absent path to the run cwd — never to "unbounded".
- **Why.** Budgets bound *cost and duration*, not damage: within budget, a
  granted tool is a granted tool. Path containment is what stops a granted file
  tool from reading outside the run.
- **Prevents.** Runaway loops; resource exhaustion; a `..`/absolute/symlink
  escape; a scope declaration widening the ceiling.
- **Verify.** Budget defaults/ceiling/tighten tests; containment tests for `..`,
  absolute escape, symlink escape, ancestor scope, sibling, `scope: []`.
- **Reference:** invariants 10–11; `src/security.ts` (`isPathContained`,
  `realPathOfNearestExisting`).

### 2.8 Refuse vectors you cannot confine

- **Practice.** If a capability has no hook you can check (an unsandboxed shell,
  a subprocess isolation vector), refuse the run unless the operator typed an
  explicit, unambiguous "unrestricted" declaration (for example a `/` ceiling).
- **Why.** Pretending to confine something you cannot is worse than refusing: it
  is trusted and wrong. A silent degradation to unsandboxed is the worst case.
- **Prevents.** A documented boundary that is false for one code path.
- **Verify.** Assert refusal under the default ceiling and acceptance only under
  the explicit `/`.
- **Reference:** invariant 11; `SECURITY.md` §3.

### 2.9 Sanitize all rendered text

- **Practice.** Strip control characters from every UI string derived from a
  definition, file, model, or network — names, descriptions, diagnostics, tool
  lists, titles, transcripts. Keep a shared helper; do not re-implement.
- **Why.** Control characters reach the terminal and can spoof titles, move the
  cursor, or write the clipboard (OSC 52).
- **Prevents.** Terminal escape injection through attacker-influenced content.
- **Verify.** Feed `\x1b`/C0/C1 into each render path and assert it is gone.
- **Reference:** invariant 9; `src/security.ts` (`stripControlChars`,
  `sanitizeUiText`); review finding M-2 (unsanitized session titles).

### 2.10 Fail closed on startup

- **Practice.** If a required dependency (broker, sandbox backend, settings) is
  unavailable, notify and stop — never continue degraded and trusted.
- **Why.** Degraded-but-trusted execution is the failure mode users cannot see.
- **Prevents.** Running unsandboxed because a sandbox binary was missing;
  reading a project settings file because the agent dir was empty.
- **Verify.** Test the unavailable path and assert refusal, not fallback.
- **Reference:** `SECURITY.md` decisions log ("sandbox: os refuses when
  unavailable"); invariant 1 ("refuses an empty agent dir").

### 2.11 Make the unenforced explicit

- **Practice.** `SECURITY.md` names what is *not* enforced in the same language
  as what is: prompt injection, provider trust, process-level isolation, the
  host platform, and any coarse control.
- **Why.** A reader will otherwise assume the strongest boundary they can
  imagine. Naming the limit is what makes the rest credible.
- **Prevents.** Operators relying on a protection that was never promised.
- **Verify.** Documentation review; each "not enforced" item has a matching
  residual-risk note and, where possible, a test that demonstrates the limit.

### 2.12 Keep secrets out of argv, logs, and third-party sinks

- **Practice.** Do not place credentials on a command line (visible in `ps`).
  Redact before logging, telemetry, or sending to a model. Prefer hashes over
  raw values in telemetry.
- **Why.** Data leaves the process through more channels than the obvious one.
- **Prevents.** Credential disclosure in process listings, event buses, or an
  inference call routed to a different provider.
- **Verify.** Redaction tests; a telemetry test asserting raw command text is
  never written.
- **Reference:** review findings L-5, L-6; `mx-pi-agents` output redactor.

---

## 3. Pi API integration practices

These are specific to how the extension behaves inside the TUI and session
lifecycle.

- **Publish extras, never replace pi's footer.** Use
  `ctx.ui.setStatus(key, text)` and let the built-in footer render. A replaced
  footer loses native context/cost/model data.
- **A widget's `render(width)` runs every frame; read state fresh** so option
  changes and streaming updates appear without re-registering. To force a redraw
  from outside a render, call `widgetTui.requestRender()` on the handle captured
  from the widget factory.
- **Wrap every pi call reachable from an event or a render in `try/catch`.**
  A disposing session must never crash the TUI.
- **Defer live-session reads to events.** `cwd`, session id/file, and trust are
  only meaningful after `session_start`.
- **Durable options** live in `<agentDir>/extensions/<extension>.json` via
  `getAgentDir()` (which honors `PI_CODING_AGENT_DIR`). The file is the source of
  truth at session start; CLI flags override for a single run only.
- **Inject time and paths.** Pure modules take a `now` argument and config
  stores take an injectable path, so tests never touch the real `~/.pi` or the
  wall clock.
- **Argument completions** on every command keep the TUI ergonomic; return
  `null` from `getArgumentCompletions` when nothing matches.
- **Recursion guard.** Set a child env marker (`MX_PI_AGENTS_CHILD=1`) and
  return before registering anything when it is present.
- **Escape/cancel** must mark remaining work cancelled and record the result
  without starting a model turn.

---

## 4. The documentation set for an extension

An extension that touches security needs four documents, each with a distinct
job.

### 4.1 `README.md` — for the user deciding whether to install

Required sections, in order:

1. **One-line description** with the pi.dev link.
2. **Why** — the problem and the rules the design is built around.
3. **Install** — `pi install npm:@rennis23/mx-pi-<name>` and the checkout form.
4. **Usage** — the tool schema / commands / directives with realistic examples.
5. **Interactive behavior** — keys, widget, cancellation.
6. **Configuration** — file location, keys, defaults, invalid-value behavior.
7. **Limits** — a short pointer to `SECURITY.md` for what is not enforced.
8. **Development** — how to run `check` and `test`.

### 4.2 `SECURITY.md` — for the operator auditing the boundary

Use the reference structure, which is what makes the doc auditable:

1. **Threat model** — assets, adversary, non-goals, boundary table.
2. **Enforced** — one subsection per boundary; each claim names the structural
   mechanism and the test that backs it.
3. **Not enforced** — stated plainly.
4. **Residual risk.**
5. **Decisions log** — table of decision → rationale, so a future reader knows
   what was deliberate.
6. **Reporting** — private advisory link; what to include.

### 4.3 `CHANGELOG.md` — for the release train

Keep an `[Unreleased]` section; the release script promotes it. Record security
changes explicitly.

### 4.4 `docs/superpowers/{specs,plans}/` — for the design history

Date-prefixed filenames. A spec records the goal, the reviewed prior art, the
threat model, and locked decisions; a plan is the ordered implementation steps.
These are the evidence that the design was reasoned, not accreted.

### 4.5 Documentation templates

**`SECURITY.md` skeleton**

```markdown
# Security — <package>
## 1. Threat model
### Assets / Adversary / Non-goals
| # | Boundary | Attacker control | Control that holds |
## 2. Enforced
### B1 — <boundary>
- claim → structural mechanism → test reference
## 3. Not enforced
## 4. Residual risk
## 5. Decisions log
| Decision | Rationale |
## 6. Reporting
```

**README "Why" section skeleton**

```markdown
## Why
<subsystem> is easy to get subtly wrong. This one is built around N rules:
1. **<rule>.** <one sentence, structural, testable>.
...
See [SECURITY.md](./SECURITY.md) for the full threat model and, importantly,
for what is *not* enforced.
```

---

## 5. Analysis: what the reviewed implementations teach

The design of the reference package came from auditing prior art and a security
review of a published extension set. The findings map directly onto the
practices in part 2.

### 5.1 Prior art

**Out-of-process delegate (pi-code).** Held up: fail-closed frontmatter (a bad
`tools:`/`isolation:` drops the whole agent), a project-agent approval gate, no
shell, process-group kill, worktree isolation.
Failed: the task travelled in `argv` (→ 2.5); MCP-style deny entries silently
no-opped (→ 2.2); an empty `tools:` meant "all tools" (→ 2.2); a `memory:` field
silently widened the grant (→ 2.2); background completion auto-triggered a parent
turn and could cross projects (→ 2.6); child transcripts persisted (→ 2.4/2.6).

**In-process delegate (piolium).** Held up: an authoritative name-based tool
allowlist that failed closed when empty, no project manifests in children,
in-memory sessions.
Critical: a repo-controlled `.pi/settings.json` set `shellCommandPrefix` /
`shellPath`, giving unconditional host code execution with no model cooperation
(→ 2.3, 2.10). High: repo-controlled `.pi/skills` injected attacker text into
the child **system prompt** (→ 2.3). Also: output paths were prose-only (→ 2.7),
writes followed symlinks (→ 2.7), transcripts persisted inside the target repo
(→ 2.4/2.6), and there was no cost/time budget (→ 2.7).

**Lesson.** The *capability* layer (name-based allowlists, fail-closed parsing)
held up in every implementation. The *resource-loading* layer (settings, skills,
context files) is where every serious finding lives. Make resource loading
structurally inert for children and compute capabilities fail-closed at session
start.

### 5.2 Security review of a published extension set (`pi-extensions`)

The review found patterns worth copying and mistakes worth avoiding. Mapping:

| Finding | Severity | Practice it validates / violates |
| --- | --- | --- |
| Sandbox bind-mounted the repo **including `.git`** → host code execution on later git use | High | 2.7 (scope), 2.9 — a writable `.git` is an escape channel; exclude or read-only it |
| Command-risk policy bypassed by `git -c core.pager=… log` | Medium | 2.2 — an allowlist must inspect the arguments that can execute another program |
| `cleanTitle` did not strip control characters | Medium | 2.9 — sanitize every render path, including the manual override |
| Write boundary escaped through a dangling symlink | Low | 2.7 — `realpath` the existing ancestor *and* stop following the leaf symlink |
| Container safety inspection omitted `Privileged`/`PidMode`/`Devices`/`CapAdd` | Low | 2.11 — a "safety" check must be total or name its gaps |
| Unpinned base image and `latest`/`^` ranges | Low | 1 — pin what executes |
| Credential forwarded on a host process `argv` | Low | 2.12 |
| Session text sent to a configurable third-party title model | Low | 2.12 |
| Unauthenticated event bus allowed auto-approving a confirmation | Info | 2.1 — name the trust assumption (all loaded extensions are trusted) |

Patterns to copy from that review: broker path canonicalization + `realpath`;
frozen env allowlist (never forward host env); fail-closed startup
(`ctx.shutdown()` on broker failure); confirmation anti-retry with an expiry
re-check after acknowledgement (do not let a synchronous handler race the
deadline); a shared control-character sanitizer; telemetry that stores hashes of
sensitive strings instead of the strings; owner-only file modes for caches.

---

## 6. Documentation readiness checklist

Use this before declaring an extension documented.

**README**
- [ ] One-line description links pi.dev.
- [ ] "Why" states the design rules as testable claims.
- [ ] Install works both from npm and from a checkout.
- [ ] Every tool/command/flag is listed with an example.
- [ ] Configuration file, keys, defaults, and invalid-value behavior documented.
- [ ] Points to `SECURITY.md` for limits.

**SECURITY.md**
- [ ] Threat model names assets, adversary, and non-goals.
- [ ] Boundary table present (one row per boundary).
- [ ] Every "enforced" claim names a mechanism and a test.
- [ ] "Not enforced" section exists and is specific.
- [ ] Residual risk listed.
- [ ] Decisions log explains deliberate choices.
- [ ] Private reporting route with reproduction guidance.

**Engineering**
- [ ] `npm run check` and `npm test` pass.
- [ ] Every security invariant has a named test.
- [ ] No install scripts; runtime deps pinned; lockfile committed.
- [ ] Every untrusted-derived UI string is sanitized.
- [ ] No secrets, task text, or prompts in `argv` or logs.
- [ ] `CHANGELOG.md` has an `[Unreleased]` entry.

---

## 7. New-extension scaffold

1. `packages/mx-pi-<name>/` with `package.json` (`@rennis23/mx-pi-<name>`,
   `pi.extensions`, peer deps, `files`, `LICENSE`).
2. `index.ts` — thin wiring only.
3. `src/` — one pure module per concern, each with a co-located `*.test.ts`.
4. `test/harness.ts` — a fake pi API so `index.ts` is testable end to end.
5. `agents/*.md` — bundled definitions (frontmatter + body), if the extension
   has a registry.
6. `README.md`, `SECURITY.md`, `CHANGELOG.md` from the part 4 templates.
7. `docs/superpowers/specs/<date>-<name>-design.md` before implementation.
8. Run `npm run check && npm test`; review the diff against part 6.

---

## Appendix A — Reference invariant → test map

`packages/mx-pi-agents/src/security.test.ts` is the model: one `describe` per
invariant, so a failure names the broken boundary.

| # | Invariant |
| --- | --- |
| 1 | No child session with project-scoped settings or loader |
| 2 | Child discovery disabled; prompt is body plus a fixed header |
| 3 | Grants are total and never widened |
| 4 | Error paths drop the definition or refuse — never run unrestricted |
| 5 | No task or prompt content in a spawned process `argv` |
| 6 | No session file, transcript, or artifact in the target repo |
| 7 | Child output is capped data that cannot trigger a parent turn |
| 8 | Children cannot spawn children |
| 9 | UI text derived from definitions is control-character stripped |
| 10 | Every run is bounded with partial-result semantics |
| 11 | A run cannot touch a path outside its granted scope |

**Reuse rule.** When a new extension adds a boundary, add a numbered invariant
and a `describe("invariant N: …")` test *before* the implementation. If a
boundary cannot be tested, it is not a boundary — document it in "not enforced"
instead.

## Appendix B — Reference implementations

| Artifact | Use it for |
| --- | --- |
| `packages/mx-pi-agents/SECURITY.md` | The enforced/not-enforced/decisions documentation pattern |
| `packages/mx-pi-agents/src/security.ts` | Total, fail-closed security helpers (control stripping, containment) |
| `packages/mx-pi-agents/src/security.test.ts` | The invariant-to-test mapping |
| `docs/superpowers/specs/2026-09-18-mx-pi-agents-design.md` | The design-spec pattern, including reviewed prior art |
| `packages/mx-pi-context-stats/README.md` | The user-facing README pattern for a non-security extension |
