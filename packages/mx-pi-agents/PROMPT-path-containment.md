You are working on `@rennis23/mx-pi-agents` in `/Users/toru/project/pi-mono/packages/mx-pi-agents`.

**Mission.** Make it structurally impossible for the tools this extension supplies — the granted file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) and the `sandbox: os` bash — to touch a path outside the run's granted scope, and make a run that cannot be path-confined (unsandboxed `bash`, `isolation: subprocess`) **refuse** rather than run. Today a general-purpose subagent delegated for work on one project was able to inspect the operator's host instead — home directory, `~/.pi`, `~/Library`, `/tmp`, and parent directories above the project. The extension's own `SECURITY.md` §3 states this gap plainly (*"Path scope is not enforced. A granted `read`/`write`/`edit` can touch any path the process can, including outside the working directory."*). Close it, and make the documentation match the code afterwards.

The locked design is recorded in `packages/mx-pi-agents/PLAN.md`; read it first and treat it as the source of truth for the decisions below.

---

## 0. Hard rules for you (read before anything else)

1. **Do not scan the host.** Your writable and readable scope is:
   - `/Users/toru/project/pi-mono/packages/mx-pi-agents/**`
   - `/Users/toru/project/pi-mono/docs/superpowers/specs/2026-09-18-mx-pi-agents-design.md`
   - `/Users/toru/project/pi-mono/node_modules/@earendil-works/**` (pi SDK typings only, if you need to confirm a tool contract)

   No `~`, no `~/Library`, no `~/.pi`, no `/tmp`, no `find /`, no walking parent directories above the package, no reading other packages in the monorepo. If you need to know what a pi API does, read its typings under the paths above or the package's own `test/` helpers. **Doing otherwise is exactly the behaviour this task exists to prevent — an ironic failure is a task failure.** If you believe you need something outside that scope, stop and ask instead.
2. No `git commit`, no `npm publish`, no changes outside the package and the design doc. Leave the working tree dirty for review.
3. Every claim in your report cites `file:line` from code you actually read. Never invent line numbers, APIs or test names. Label anything you could not verify as `UNVERIFIED`.
4. Do not weaken or bypass any existing control to make your change fit. Invariants 1–10 in design §8 must all keep passing.

---

## 1. Diagnose — evidence first

Read `SECURITY.md` (§2 B4, §3, §4) and the design doc §8, then trace **every** path a child run can reach the filesystem through. For each, establish whether a path outside the granted root is reachable, with `file:line`:

1. **The in-process runner's structured tools.** `src/runners/in-process.ts` (~lines 236–272): how `plan.tools` and `customTools` are handed to `createAgentSession`. Note that `customTools` already replaces the builtin `bash` definition when `sandbox: os` is set — that is the precedent for wrapping tools.
2. **`bash` with `sandbox: none`.** What is bounded today (budgets only) and what is not.
3. **`bash` with `sandbox: os`.** `src/runners/sandbox.ts` — check the seatbelt profile (around line 41, the bare `(allow file-read*)`, and 45–52) and the bwrap argv (around 63–80, `--chdir`, any `--ro-bind`). Confirm both halves rather than assuming.
4. **The subprocess runner.** `src/runners/subprocess.ts` — `cwd`, argv construction, the temp prompt file and directory permissions, the child's environment.
5. **The policy/grant layer.** `src/policy.ts` (`planRun`) and `src/schema.ts` (`computeEffectiveTools`): what is scoped today, and precisely where a scope field would have to enter so that it is computed rather than inferred — mirroring the grant contract in design §4.4 ("total and non-additive").
6. **The helpers that already exist.** `isPathContained` / `realPathOfNearestExisting` live in `src/security.ts:113` / `src/security.ts:105`; `isOutsideRoots` is the `config.ts` wrapper. Read them before writing any new containment logic.

**Deliverable:** a table — *vector → `file:line` → confined today? → what a model or attacker can actually reach* — plus a concrete reproduction **statement** grounded in code (for example: "with `read` granted, `read({ path: \"<path outside cwd>\" })` is accepted because <file:line> performs no containment check"). Do not execute a host scan to produce it; cite the code path.

Then state honestly which vectors are *fixable* and which are not. A granted `bash` with `sandbox: none` is a full shell running with the operator's privileges; it cannot be path-confined at the tool level, so the design **refuses** it (see §2) instead of pretending otherwise.

---

## 2. Design — locked decisions

Introduce **invariant 11**: *"A child run cannot touch a path outside its granted scope. An absent, unparsable or unresolvable scope is a refusal, never 'unrestricted'."*

These decisions are locked. Implement them rather than re-opening them:

- **Scope model.** A scope is a **list of absolute directory roots**. It is computed in `planRun`, never inferred at the tool. **Default scope** when nothing is declared: the run's `cwd`, and nothing else. The default is never an ancestor, `$HOME`, a temp directory, or the agent dir. Everything outside it is refused.
- **Ceiling.** The config `scope` is the ceiling, exactly like `limits`: an agent may tighten it, never loosen it. Absent means `[cwd]`. The definition field `scope` tightens the ceiling; each resolved entry is resolved against `ctx.cwd`.
- **Scope-root validity rule.** Absent definition scope → effective scope is `[cwd]`, validated against the ceiling. `scope: []` → refusal (`scope-invalid`), never "everything"; absent and empty stay distinct, mirroring the `tools` contract. Multiple entries are allowed, order-preserving and deduplicated. Every entry must resolve (after realpath) to an existing directory; a root that does not exist or is not a directory is `scope-invalid`. An entry equal to or **above** `ctx.cwd` (`/`, `/Users`, the project root) is `scope-invalid`, because it is looser than the run's own directory. An entry outside the ceiling is `scope-invalid`.
- **Precedence.** The ceiling is the operator's declaration; a definition always narrows. There is no branch anywhere that yields "unrestricted" as a fallback.
- **Containment must reuse the existing helper.** Use `isPathContained` / `assertPathContained` (`src/security.ts:113,121`) — they already resolve `..`, absolute escapes and symlink escapes through the nearest-existing realpath and fail closed on a missing root. Add only the ancestor rule above. **Do not write a second containment implementation.**
- **Enforcement point: `ToolDefinition.execute`, not the operations hook.** `GrepOperations` (`grep.d.ts:24–29`) only exposes `readFile`/`isDirectory`, and `FindOperations` (`find.d.ts:19–27`) only `exists`/`glob`: the model-supplied search root never reaches the operations, because grep/find perform the walk themselves. Build each base definition with pi's factory (`createReadToolDefinition`, …, all exported at `dist/index.d.ts:24`), then replace `execute` with a wrapper that maps the tool name to its path parameter, resolves an absent/empty value to `plan.cwd`, and asserts containment **before** delegating. A wrapper that cannot recognize the parameter shape **refuses**, never passes through. Derive the wrapper set from `plan.tools`, so a granted file tool cannot be left unwrapped.

  | Tool | Path parameter | Absent value | Side |
  | --- | --- | --- | --- |
  | `read` | `path` | `cwd` | read |
  | `write` | `path` | `cwd` | write |
  | `edit` | `path` | `cwd` | write |
  | `grep` | `path` | `cwd` | read (root; `glob`/`pattern` are matched inside it) |
  | `find` | `path` | `cwd` | read (root) |
  | `ls` | `path` | `cwd` | read |

- **Vectors that cannot be path-confined refuse unless the ceiling is explicitly `/`.** Exactly one total rule, no hidden branch:

  ```text
  if (vector is unconfineable)            // bash granted && sandbox === "none", or isolation === "subprocess"
      if (ceiling contains "/")  effective = ["/"]     // operator explicitly licensed an unconfined run
      else                       refuse("scope-unenforceable")
  ```

  A definition that also declares a narrower `scope` is refused even under a `/` ceiling: a definition may tighten, never loosen. A run licensed by `/` has no check to make, so tool wrapping is skipped for it. Blast radius: the bundled `agents/builder.md` grants `bash` with no sandbox, so it starts refusing under the default ceiling; migrate it to `sandbox: os` so the roster keeps working. The refusal message names both escapes (`sandbox: os`, or a `/` ceiling).
- **Sandbox read narrowing.** macOS/seatbelt (`src/runners/sandbox.ts`): drop the bare `(allow file-read*)` and emit `(allow file-read* (subpath …))` for the run's read roots plus an immutable system runtime allowance. Hand-listing the runtime paths is not sufficient (bash aborts without the rest of the surface), so the allowance is the built-in `system.sb` import plus the system binary directories; it grants process startup, not user data, and user data outside the run scope stays denied. Linux/bwrap: replace `--ro-bind / /` with per-root `--ro-bind` for the system allowlist and the read roots, keep `--bind` for the write roots and `--unshare-all`. Write roots and read roots for `sandbox: os` are the effective scope. Golden tests assert the bare seatbelt form and `--ro-bind / /` are gone. If the backend cannot build a narrowed profile/argv, refuse the run — never run unsandboxed (the `sandbox: os` or nothing invariant).
- **Named refusal reasons.** Add `scope-invalid` and `scope-unenforceable` to the closed union `RefusalReason` (`src/types.ts`) and to `describeRefusal`. `CONFIG_VERSION` stays `1`: the config field is additive and unknown fields are already tolerated.
- **Ordering in `planRun`.** Resolve the scope after the grant/spawn checks and before `model-unavailable`, so a malformed definition fails on the cheapest, most specific cause (keeps the "first failure wins" property).
- **Operator visibility.** `/mx-pi-agents status` gains `scope: <ceiling roots or "(cwd)">` and `unconfined runs: <allowed|refused>`; `describePlan` appends `scope=<n roots|cwd|host>`; the `mx_pi_agent` tool description states that a child cannot touch a path outside the run scope and that an unscoped run is cwd-only.

Write the design down in `packages/mx-pi-agents/PLAN.md` before you edit code, then implement it. Keep the change as small as the invariant allows.

---

## 3. Implement

**Careful trap:** in this repo an unknown frontmatter field drops the whole definition (`src/schema.ts:120` `KNOWN_FIELDS`, `:147`), so a new `scope` field must be registered in the known-field set **in the same change** as its parse, or every existing definition silently disappears. Add a test that proves both directions.

Touch these after verifying each is genuinely needed (add others only if your §1 trace shows they are):

- `src/scope.ts` (new) — `resolveScope`, `isPathInScope` / `assertPathInScope`, `isUnconfineable`, `describeScope`, the per-tool table, the ancestor rule.
- `src/config.ts` — `scope` ceiling on `AgentsConfig`, `defaultConfig()`, `parseConfig()` (drop wrong types with a diagnostic, matching the existing defensive style), `serializeConfig()` (emit only when present, stable key order).
- `src/types.ts` — `AgentDefinition.scope`, `RunPlan.scope`, the two new refusal reasons.
- `src/schema.ts` — register `scope` and parse it as a string list.
- `src/policy.ts` — resolve the scope in `planRun()` and refuse; thread the config ceiling via `SessionContext.scopeCeiling`; append the scope in `describePlan`.
- `src/runners/confine.ts` (new) and `src/runners/in-process.ts` — wrap the granted file tools with the same `customTools` mechanism already used for sandboxed bash, and thread the scope into the sandbox write/read roots.
- `src/runners/sandbox.ts` — narrow the seatbelt read rules and the bwrap argv.
- `src/runners/subprocess.ts` — no scope plumbing: a subprocess child runs pi's own tools with no hook from this extension, so `isolation: subprocess` is refused by the policy instead (review defect D3). Do not ship a dead env var.
- `index.ts` — surface the effective scope in `/mx-pi-agents status` (`index.ts:383`) and the `mx_pi_agent` tool description; thread `config.scope` into `SessionContext`.
- `SECURITY.md` — §1 table (the B4 row), **§2 B4 body** (the "not from hidden path confinement" sentence must become true or change), §3 (rewrite or remove the "Path scope is not enforced" bullet so it names exactly the vectors that are still unconfined), §4 decisions log, §5 syntax.
- `docs/superpowers/specs/2026-09-18-mx-pi-agents-design.md` — amend §4.4 #3 (confinement is part of governance), add `scope` to the §6 field list, add invariant 11 to §8, and correct §9's acceptance-suite path to `src/security.test.ts`.
- `README.md` — frontmatter table (`:105–113`) and the config example (`:161–168`) gain `scope`; the status example (`:150`) gains the new lines.
- `CHANGELOG.md` — under `[Unreleased]`.

---

## 4. Tests

Follow the repo's own convention: **one test per invariant** in `src/security.test.ts`, using `describe("invariant 11: …")` alongside the existing `describe("invariant N: …")` blocks. Unit tests live next to their module (`src/scope.test.ts`, `src/runners/confine.test.ts`, `src/runners/sandbox.test.ts`).

- **Show the hole first.** Write one hermetic, **currently-failing** reproduction test before the fix — for example a granted `read` tool accepting a path outside the cwd — so the diagnosis is evidence, not narration.
- **Hermetic.** Use the existing `test/harness.ts` and `test/fixtures.ts` helpers and `mkdtemp` temp directories. Never reference the operator's real home directory, and never assert against a host path.
- **Gated stages.** Land each stage green (`npx vitest run`) before the next: S1 scope resolution; S2 config ceiling; S3 definition field + plan plumbing; S4 tool confinement; S5 sandbox narrowing; S6 surfaces, roster and docs.
- **Cover at minimum:** escape via `..`; escape via an absolute path; escape via a symlink inside the root; a scope entry that is an ancestor of the root (must be rejected); a scope entry outside the ceiling (rejected) and beneath it (accepted); malformed/unparsable scope → refusal; absent scope → `cwd` only; frontmatter tightening accepted and loosening refused; golden-string assertions for the narrowed sandbox profile and argv; and the `bash` + `sandbox: none` refusal, including the `/`-ceiling escape hatch.
- Run `npx vitest run`. All pre-existing tests must stay green, including invariants 1–10.

---

## 5. Definition of done

- [ ] Evidence table produced, with `file:line` for every vector
- [ ] Invariant 11 present in design §8 **and** in `src/security.test.ts`, passing
- [ ] `isPathContained` is the only containment implementation; no second copy
- [ ] A run that cannot be confined does not run (except under an explicit `/` ceiling)
- [ ] No bare `(allow file-read*)` and no `--ro-bind / /` remain; a test proves it
- [ ] `grep -n "hidden path confinement" packages/mx-pi-agents` and `grep -n "pi parity" packages/mx-pi-agents` return no stale claim
- [ ] `SECURITY.md` contains no stale claim: the sentence "Path scope is not enforced" is gone **or** narrowed to name exactly the vectors that are still unconfined
- [ ] `npx vitest run` and `npm run check` are green
- [ ] Working tree dirty, nothing committed

---

## 6. Report back

1. The evidence table from §1.
2. The design decision and its reasoning, including the `bash` + `sandbox: none` choice.
3. Files changed, one line of justification each.
4. Tail of the `npx vitest run` output.
5. What you could **not** confine, and why.
6. Anything you found but deliberately did not change.

---

## Non-goals

- No container, VM or OS-level isolation layer — that is explicitly out of scope in §3 of `SECURITY.md`.
- No changes to pi's own tool implementations outside this package.
- No `disallowed_tools`-style deny list; the decisions log in §4 rejects deny lists because they can silently no-op against an allowlist.
