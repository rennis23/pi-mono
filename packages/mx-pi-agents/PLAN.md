# PLAN — Path containment for `mx-pi-agents`

Source of truth for this work. Inputs:

- `PROMPT-path-containment.md` (the revised session prompt) — the instrument, rewritten in Part A.
- `PROMPT-path-containment.review.md` — the defect list (D1–D10) this plan closes.
- `docs/superpowers/specs/2026-09-18-mx-pi-agents-design.md` §4.4, §6, §8, §9 — the contract.

Operator decisions taken before planning (no longer open):

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Plan coverage | Both the prompt v2 rewrite **and** the implementation it drives |
| 2 | Stance for vectors that cannot be path-confined | **Refuse when narrower** — a run that cannot be confined to its scope does not run |
| 3 | Plan file | `packages/mx-pi-agents/PLAN.md` |

Baseline: `npx vitest run packages/mx-pi-agents/src/security.test.ts` → 44 passed, working tree clean.

---

## 1. Locked design decisions

### D-A — Scope model and precedence

A scope is a **list of absolute directory roots**. It is computed in `planRun`, never inferred at
the tool.

- **Ceiling** = `AgentsConfig.scope` when declared, else `[ctx.cwd]`. The ceiling is the maximum a
  definition may reach; it is the operator's declaration, exactly like `limits`
  (`README.md:167–168`: "an agent may tighten them, never loosen them").
- **Ceiling root `/`** is the explicit, typed "unrestricted" declaration. It is the *only* path
  that licenses an unconfineable vector (D-C). There is no default that yields it.
- **Definition field `scope`** (frontmatter, string list) *tightens* the ceiling. Each resolved
  entry must be contained in the ceiling; entries are resolved against `ctx.cwd`.
- **Absent** definition `scope` → effective scope is `[ctx.cwd]` (validated against the ceiling).
- **`scope: []`** → refusal `scope-invalid`, never "everything". Absent and empty stay distinct,
  mirroring the `tools` contract (`src/types.ts:36–40`).
- **Ancestors are refused.** An entry equal to or above `ctx.cwd` (`/`, `/Users`, the project root
  when cwd is the package) is `scope-invalid`, because it is looser than the run's own directory.
  This is the rule the §4 test "a scope entry that is an ancestor of the root must be rejected"
  encodes.
- **Unresolvable roots are refused.** A root that does not exist after realpath, or is not a
  directory, is `scope-invalid`.

Containment reuses `isPathContained` (`src/security.ts:113`) and `assertPathContained`
(`src/security.ts:121`) — no second implementation. They already resolve the nearest-existing
realpath, which covers `..`, absolute escapes and symlink escapes, and fail closed on a
nonexistent root. The only additional logic is the ancestor rule above.

### D-B — Enforcement point: the `ToolDefinition`, not the operations

`ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)`
(`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:361`) is the single hook that sees
the model's raw input for every granted tool. Wrapping there closes all six file tools uniformly.

The operations decorator alone is **not** sufficient, and this is a correction to the prompt's
assumption: `GrepOperations` only exposes `isDirectory(abs)` / `readFile(abs)`
(`dist/core/tools/grep.d.ts:24–29`) and `FindOperations` only `exists(abs)` / `glob(pattern, cwd,
…)` (`find.d.ts:19–27`) — the search root never reaches the operations, because grep/find perform
the walk themselves (ripgrep/fd) using the model-supplied path. So: build each base definition with
pi's factory (`createReadToolDefinition`, …, all exported at
`dist/index.d.ts:24`), then replace `execute` with a wrapper that:

1. maps the tool name to the path-bearing parameter (`read`/`write`/`edit`/`ls` → `path`;
   `grep`/`find` → `path`, and `find`'s `glob`/`pattern` are resolved against it);
2. resolves it against `plan.cwd` when absent or empty (the default is cwd, never "unbounded");
3. asserts containment in `plan.scope` for reads and/or writes per the table in §4;
4. **refuses, never passes through**, if the parameter shape is unrecognized or the check throws.

Wrapping is installed via the existing `customTools` mechanism
(`src/runners/in-process.ts:240–260`), which is confirmed to replace builtins by name
(`agent-session.js:1953–1965`). A granted file tool that is *not* wrapped is a hole, so the wrapper
set is derived from `plan.tools`, not hardcoded.

### D-C — Unconfineable vectors refuse unless the ceiling is explicitly `/`

Exactly one rule, total, no hidden branch:

```text
if (vector is unconfineable)            // bash granted && sandbox === "none", or isolation === "subprocess"
    if (ceiling contains "/")  effective = ["/"]     // operator explicitly licensed an unconfined run
    else                       refuse("scope-unenforceable")
```

Rationale: a granted unsandboxed `bash` is a full shell with the operator's privileges, and a
subprocess child's file tools are pi's own implementations — the extension has no hook in either
(`src/runners/subprocess.ts:55–70` spawns `pi` with `--tools`; pi has no path-scope flag). The
honest fix is not to pretend to confine them but to require the operator to type "unrestricted"
before such a run executes. This makes invariant 11 **literally true for every run that runs**, and
it resolves review defect D3 (the prompt's "pass the scope through" had no consumer).

Blast radius, stated up front: bundled `agents/builder.md:4` grants `bash` with no `sandbox`, so
under a default ceiling it starts refusing. Stage S6 migrates it to `sandbox: os` so the default
roster keeps working; the refusal message names both escapes (`sandbox: os`, or a `/` ceiling).

### D-D — Sandbox read narrowing

- **macOS / seatbelt** (`src/runners/sandbox.ts:37–52`): drop the bare `(allow file-read*)`
  (line 41) and emit `(allow file-read* (subpath …))` for (a) an explicit, short, commented
  **system allowlist** (immutable runtime paths: `/usr`, `/bin`, `/sbin`, `/System`, `/private/var/db/dyld`,
  `/dev`, `/etc` — needed or bash cannot start at all) plus (b) the run's read roots. Writes stay
  per-root (`:47–49`). This is genuinely narrower than host-wide: `$HOME`, `~/.pi`, `~/.ssh`,
  `~/Library`, other projects and temp contents fall outside it, and a golden test asserts the bare
  form is gone. The system allowlist is documented as the honest limit (review defect D4).
- **Linux / bwrap** (`:63–78`): replace `--ro-bind / /` (line 67–70) with per-root `--ro-bind` for
  the system allowlist and the read roots, keep `--bind` for write roots and `--unshare-all`
  (which is what actually denies network). Golden test asserts `--ro-bind / /` is gone.
- Read roots for `sandbox: os` = the effective scope. Write roots = the effective scope (replacing
  today's hardcoded `[plan.cwd]` at `in-process.ts:254`).
- If the backend cannot build a narrowed profile/argv, the run is refused, never run unsandboxed —
  the existing `sandbox: os` or nothing invariant (`SECURITY.md:103–105`) is preserved.

### D-E — Refusals

Add to the closed union `RefusalReason` (`src/types.ts:113–124`) and to `describeRefusal`:

| Reason | Raised when |
| --- | --- |
| `scope-invalid` | empty list, ancestor of cwd, nonexistent/non-directory root, entry outside the ceiling, malformed type |
| `scope-unenforceable` | `bash` + `sandbox: none`, or `isolation: subprocess`, under a ceiling that does not contain `/` |

Ordering in `planRun` (`src/policy.ts:48`): insert scope resolution after the grant/spawn checks and
before `model-unavailable`, so a malformed definition fails on the cheapest, most specific cause
(keeps the documented "first failure wins" property at `policy.ts:40–46`).

### D-F — Operator visibility

- `/mx-pi-agents status` (`index.ts:383`) gains `scope: <ceiling roots or "(cwd)">` and
  `unconfined runs: <allowed|refused>`.
- `describePlan` (`src/policy.ts:139`) appends `scope=<n roots|cwd|host>`.
- The `mx_pi_agent` tool description states that a child cannot touch a path outside the run scope
  and that an unscoped run is cwd-only.

---

## 2. Part A — rewrite of `PROMPT-path-containment.md` (prompt v2)

The prompt stays the instrument; it must not encode the defects. Edit it in place (same path, same
purpose) with these changes:

| # | Prompt change | Closes |
| --- | --- | --- |
| A1 | Mission restated as "impossible **for the tools this extension supplies**", not "for a child run" | D2 |
| A2 | Invariant 11 text keeps the sentence but adds: default scope is cwd; the only run that touches the host is one licensed by an explicit `/` ceiling | D2 |
| A3 | §2 replaces the three options with the **locked decisions** D-C/D-D/D-E above (refuse, system allowlist, named refusal reasons) | D3, D4, D8 |
| A4 | Required-edit list adds design §4.4 #3, design §6, design §9, `SECURITY.md` §2 B4, `README.md`; DoD greps for `hidden path confinement` and `pi parity`, not only the §3 sentence | D1, D9 |
| A5 | New per-tool table (path parameter, absent-value default, read/write side) **and** the statement that enforcement is at `ToolDefinition.execute`, because grep/find operations never see the search root | D5 |
| A6 | Replace "evaluate both the lexical and realpath form" with "reuse `isPathContained`/`assertPathContained` (`src/security.ts:113,121`); add only the ancestor rule; do not write a second implementation" | D6 |
| A7 | §2 states the scope-root validity rule in full: absent vs empty, multi-root, ceiling semantics, ancestor refusal, resolvability | D7 |
| A8 | Name `scope-invalid` / `scope-unenforceable`; state that `CONFIG_VERSION` stays 1 (the field is additive and unknown fields are already tolerated) | D8 |
| A9 | §4 requires one **currently-failing** hermetic reproduction test before the fix, and splits the work into the gated stages S1–S6 | D10 |
| A10 | §3 names `packages/mx-pi-agents/PLAN.md` as where the design is written down before code | D10 |
| A11 | Fix the wrong refs: `isPathContained` lives in `src/security.ts:113` (not `config.ts`); the command is `/mx-pi-agents status` (`index.ts:383`) | minor |

Everything else in the prompt — the anti-host-scan rule, the no-weakening rule, the
`KNOWN_FIELDS` trap warning, the one-test-per-invariant convention, the report format — is kept
verbatim; it was accurate and useful.

---

## 3. Part B — implementation stages

Each stage is gated: it lands green (`npx vitest run`) before the next starts.

### S1 — Pure scope resolution (`src/scope.ts`, new)

- `resolveScope(input: { definitionScope?: string[]; ceiling?: string[]; cwd: string }): ScopeOutcome`
  returning `{ ok: true; roots: string[]; unrestricted: boolean }` or `{ ok: false; reason: "scope-invalid" | "scope-unenforceable"; message }`.
- `isPathInScope(roots, candidate): boolean` (delegates to `isPathContained`), `assertPathInScope(...)`.
- `isUnconfineable(vector: { isolation: IsolationMode; sandbox: SandboxMode; tools: readonly string[] }): boolean`.
- `describeScope(roots, unrestricted): string`.
- `PATH_PARAM: Record<string, { field: string; mode: "read" | "write" | "both" }>`.
- Tests `src/scope.test.ts`: absent → cwd; empty → refusal; ancestor → refusal; sibling outside
  ceiling → refusal; subdir of ceiling → accept; `..` escape; absolute escape; symlink escape;
  nonexistent root; multi-root; `/` ceiling licenses `unrestricted`.

### S2 — Config ceiling (`src/config.ts`)

- `AgentsConfig.scope: string[] | undefined` (`:34`), `defaultConfig()` leaves it absent (`:53`).
- `parseConfig` (`:71`): `parseScope` dropping wrong types with a diagnostic, in the defensive style
  of `parseAgentPaths` (`:93–109`); `~` expansion reusing the `resolveAgentPath` rule (`:183`).
- `serializeConfig` (`:161`) emits `scope` only when present, before `approvals`; keep stable key
  order and trailing newline.
- `CONFIG_VERSION` stays `1` (additive field; `:78` already tolerates unknown fields).
- Tests in `src/config.test.ts`: round-trip, wrong type dropped with diagnostic, absent stays absent.

### S3 — Definition field and plan plumbing (`src/schema.ts`, `src/types.ts`, `src/policy.ts`)

- `KNOWN_FIELDS` (`schema.ts:120`) gains `"scope"` **in the same change** as the parse, or every
  existing definition silently disappears (`schema.ts:147`). Add both directions to
  `src/schema.test.ts`: `scope: [a, b]` accepted; a typo (`scopes`) still drops the definition.
- `readPathList` mirrors `readToolList` (`schema.ts:100–118`) with a path-entry pattern; reuse the
  frontmatter flow-list support (no `src/frontmatter.ts` change expected — verify with one test).
- `AgentDefinition.scope: string[] | undefined` (`types.ts:33–52`).
- `RunPlan.scope: { roots: readonly string[]; unrestricted: boolean }` (`types.ts:136–152`).
- `planRun` calls `resolveScope` and refuses; `SessionContext.limits` unchanged, add
  `SessionContext.scopeCeiling?: string[]` (`policy.ts:20–33`), fed from config at `session_start`.
- `describePlan` appends the scope (`policy.ts:139`).
- Tests `src/policy.test.ts`: each new refusal reason, message contains the fix ("use `sandbox: os`
  or declare `scope: [\"/\"]`").

### S4 — Tool confinement (`src/runners/confine.ts`, new; `src/runners/in-process.ts`)

- `confineToolDefinition(def: ToolDefinition, opts: { cwd: string; roots: readonly string[]; mode }): ToolDefinition`
  — returns a shallow copy whose `execute` validates then delegates to the original. Throws a
  typed error carrying `scope-invalid` when params are unrecognizable, so the run fails closed.
- `buildGrantedTools(plan): ToolDefinition[]` builds pi's six file definitions
  (`createReadToolDefinition` … `createLsToolDefinition`) and confines each in `plan.tools`.
- `in-process.ts`: merge these into the existing `customTools` array (`:240–260`); when
  `plan.scope.unrestricted` is true, skip wrapping (no check to make) and say so in a comment.
- Tests `src/runners/confine.test.ts`: out-of-scope `path` refused for `read`, `write`, `edit`,
  `ls`, `grep`, `find`; absent/empty path → cwd; in-scope passes and produces the same result as the
  unwrapped definition; unrecognized params refused. Hermetic temp dirs only.

### S5 — Sandbox narrowing (`src/runners/sandbox.ts`)

- `buildSeatbeltProfile(writeRoots, readRoots)`, `buildBwrapArgv(command, writeRoots, readRoots, cwd)`,
  `SandboxBashOptions { writeRoots; readRoots?; platform? }`.
- Constants `SEATBELT_SYSTEM_READ_ROOTS` / `BWRAP_READ_ROOTS` with a comment naming them as the
  immutable runtime allowance.
- Tests `src/runners/sandbox.test.ts` (golden strings): no bare `(allow file-read*)`; one
  `(subpath …)` per system + scope root; no `--ro-bind / /`; `--unshare-all` retained.

### S6 — Surfaces, roster, docs

- `index.ts:383`: status gains `scope` + `unconfined runs`; thread `scopeCeiling` from the loaded
  config into `SessionContext`.
- `agents/builder.md:4`: `bash` + `sandbox: os` (write/read roots now derive from scope).
- `SECURITY.md`: §1 B4 row; §2 B4 body ("not from hidden path confinement" must become true or
  change — review D1); §3 bullet names exactly what is still unconfined (macOS system paths,
  unsandboxed bash/subprocess when licensed); §4 decisions log entries for D-C/D-D; §5 syntax.
- design doc: §4.4 #3 amended (confinement is now part of governance); §6 field list gains `scope`;
  §8 gains invariant 11; §9 path corrected to `src/security.test.ts`.
- `README.md`: frontmatter table (`:105–113`) gains `scope`; config example (`:161–168`) gains
  `scope`; status example (`:150`).
- `CHANGELOG.md` under `[Unreleased]`.

---

## 4. Invariant 11 test matrix (`src/security.test.ts`, `describe("invariant 11: …")`)

| Case | Expectation |
| --- | --- |
| Absent scope | cwd only; sibling temp dir unreadable |
| `..` escape from scope | refused |
| Absolute path outside scope | refused |
| Symlink inside scope → outside | refused (realpath) |
| Scope entry is an ancestor of cwd | refused `scope-invalid` |
| Scope entry outside the config ceiling | refused `scope-invalid` |
| Scope entry beneath the ceiling | accepted |
| `scope: []` | refused `scope-invalid` |
| Malformed scope (string, not list) | definition dropped with a diagnostic (`schema.ts:147`) |
| `scope` typo | definition dropped (both directions) |
| `bash` + `sandbox: none`, default ceiling | refused `scope-unenforceable` |
| `bash` + `sandbox: none`, ceiling `["/"]` | runs, and status shows `unconfined runs: allowed` |
| `isolation: subprocess`, default ceiling | refused `scope-unenforceable` |
| `sandbox: os` golden profile | no bare `(allow file-read*)`; per-root subpaths present |
| `sandbox: os` golden argv | no `--ro-bind / /`; per-root ro-binds present |

All fixtures via `test/harness.ts`, `test/fixtures.ts` (`makeAgent`, `makeSessionContext`) and
`mkdtemp` temp dirs. No test references the operator's home directory or any host path.

---

## 5. Verification

```bash
npx vitest run                                  # all suites, invariants 1–11 green
npx vitest run packages/mx-pi-agents -t "invariant 11"
npm run check                                   # biome + tsc
grep -n "file-read\*)" packages/mx-pi-agents/src/runners/sandbox.ts   # no bare form remains
git status --short                              # dirty, nothing committed
```

## 6. Definition of done

- [ ] Every review defect D1–D10 has a corresponding change in the prompt (A1–A11) or the code
- [ ] Invariant 11 present in design §8 and in `src/security.test.ts`, passing
- [ ] `isPathContained` is the only containment implementation; no second copy
- [ ] A run that cannot be confined does not run (except under an explicit `/` ceiling)
- [ ] No bare `(allow file-read*)` and no `--ro-bind / /`
- [ ] `SECURITY.md` §2 B4 and §3 contain no claim contradicted by the code
- [ ] `npx vitest run` and `npm run check` green; working tree dirty, nothing committed

## 7. What remains unconfined (state it, do not fix it here)

- Reads of the macOS system allowlist (`/usr`, `/System`, …) inside `sandbox: os`.
- Anything at all inside a run licensed by a `/` ceiling (unsandboxed bash, subprocess).
- Prompt injection, provider trust, and the process/container boundary: unchanged, per
  `SECURITY.md` §3.

## 8. Risks and rollback

- **Roster breakage:** `builder` refuses until S6 migrates it to `sandbox: os`. Contained by
  landing S1–S5 and S6 together; rollback is a revert of the stage commits (no version bump).
- **Seatbelt profile too tight:** bash cannot start. Mitigated by the golden test plus a smoke test
  that the profile runs `true`; the system allowlist is the tuning knob.
- **Wrapper bypass:** a granted file tool left unwrapped is a hole. Mitigated by deriving the
  wrapper set from `plan.tools` and asserting set equality in `confine.test.ts`.
