# Review — `PROMPT-path-containment.md`

Reviewed against the tree at commit `6074519` (working tree clean apart from untracked docs/prompt).
All `file:line` claims below were read, not inferred. Baseline `npx vitest run
packages/mx-pi-agents/src/security.test.ts` → 44 passed.

## Verdict

Reconnaissance is genuinely good (~95 % of its `file:line` references are exact, and its one
non-obvious trap — unknown frontmatter fields drop the whole definition — is correct). The direction
is right and fail-closed. But the prompt is **not safe to hand to an agent as written**: it
contradicts two *locked* statements it never authorises changing, its central invariant is
unachievable on two of the three enforcement surfaces it names, and one required edit
(`subprocess.ts` "pass the scope through") has no consumer and would ship as security theatre.
Expected outcome if followed literally: a green suite plus a `SECURITY.md` that asserts both
"path confinement is deliberately rejected" and "path confinement is enforced".

## 1. Premises that check out

| Prompt claim | Verified at |
| --- | --- |
| `SECURITY.md` §3 says path scope is not enforced | `SECURITY.md:146` |
| §2 B4 documents pi-parity / no confinement | `SECURITY.md:96–100` |
| design §8 has invariants 1–10 | design `:228–244` |
| design §4.4 grants are total / non-additive | design `:80–93` |
| `customTools` already replaces builtin `bash` for `sandbox: os` | `src/runners/in-process.ts:240–260`, passed at `:262–270` |
| that override really works | `agent-session.js:1953–1965` — `definitionRegistry.set(definition.name, …)`, custom wins over builtin |
| seatbelt allows host-wide reads, bounds writes | `src/runners/sandbox.ts:41` (`(allow file-read*)`), `:47–49` (`file-write* (subpath …)`) |
| bwrap argv shape | `src/runners/sandbox.ts:63–78` (`--ro-bind / /`, `--bind` writeRoots, `--chdir`) |
| containment helpers exist | `src/security.ts:113` `isPathContained`, `src/config.ts:248` `isOutsideRoots` |
| unknown frontmatter field drops the definition | `src/schema.ts:120` `KNOWN_FIELDS`, `:147` pushes `unknown field "…"` → whole-definition drop |
| test convention is `describe("invariant N: …")` | `src/security.test.ts:62,115,164,222,257,282,334,376,424,453` |
| `limits` ceiling precedent ("tighten, never loosen") | `README.md:167–168` — exact model for the scope ceiling |
| wrapping is technically available | pi exports `createReadToolDefinition`/`createWriteToolDefinition`/… plus `ReadOperations`/`WriteOperations` interfaces (`@earendil-works/pi-coding-agent/dist/index.d.ts:24`) |

## 2. Inaccurate premises (minor, fix in the prompt)

- `src/config.ts (~183–250) has isPathContained / isOutsideRoots` — only `isOutsideRoots` is in
  `config.ts:248`; `isPathContained` is defined at `src/security.ts:113` and merely imported at
  `config.ts:14`.
- "surface the effective scope in `/status`" — the command is `/mx-pi-agents status`
  (`index.ts:362,383`; `README.md:150`).
- design §9 still names the acceptance suite `test/security.test.ts`; the real path is
  `src/security.test.ts`. The prompt uses the correct path but does not require fixing design §9.

## 3. Defects, ranked

### D1 — The mission contradicts two locked statements the prompt never lets you change (blocking)

- design §4.4 #3: *"Tool governance = pi parity. No approval dialogs, **no hidden path
  confinement.** … A granted tool behaves exactly like pi's version of that tool."* (design `:77–79`)
- design §1: *"boundaries that are not enforced (… path scope) are stated…"* (design `:19`)
- `SECURITY.md` §2 **B4** — in the *Enforced* section: *"Safety comes from capability grants … **not
  from hidden path confinement** or approval dialogs."* (`SECURITY.md:98–100`)

The prompt's edit list touches design §8 only, and for `SECURITY.md` names "§1 table (the B4 row),
§3, §4, §5" — **not B4's body**. Its DoD only greps for the §3 sentence. Following the prompt
literally therefore produces a repo that simultaneously asserts confinement is architecturally
rejected and is invariant 11. Fix: add design §4.4 #3, design §6 (if a field is added) and
`SECURITY.md` §2 B4 to the required edits, and widen the DoD grep to `hidden path confinement` /
`pi parity`.

### D2 — Invariant 11 as worded is false, and the prompt says so in the same document (blocking)

§2 prescribes the unconditional sentence *"A child run cannot touch a path outside its granted
scope."* §2 also offers option (b) — leave `bash` + `sandbox: none` out of scope — and §1 admits a
granted unsandboxed shell "cannot be path-confined at the tool level". Both cannot be true at once.
The invariant must be scoped to what the extension actually intercepts (granted *file tools* it
supplies, plus `sandbox: os` bash), and the `SECURITY.md` §3 bullet must name exactly the unconfined
vectors. Otherwise the DoD passes while the security claim is false — the failure mode the prompt
exists to prevent.

### D3 — "subprocess.ts — pass the scope through" has no consumer (blocking)

`subprocess.ts` spawns a real `pi` child: `--tools plan.tools` etc. (`src/runners/subprocess.ts:55–70`,
`:66–67`). That child's `read`/`write`/`edit` are pi's own implementations; no code from this
extension runs inside it, and pi exposes no path-scope flag (`@earendil-works/pi-coding-agent/docs/usage.md`
lists `--tools`, `--no-tools`, `--no-extensions`, … and nothing for paths). So "pass the scope
through" is either a dead env var (advisory, unenforced — exactly the "boundary that is not
enforced" the repo forbids being vague about) or it must become *refuse `isolation: subprocess` when
the scope is narrower than the host*. The prompt must pick one and say so; invariant 11 is otherwise
silently false for the entire subprocess runner.

### D4 — `sandbox: os` read-narrowing is under-specified and probably infeasible, yet the DoD demands it (blocking)

A `(deny default)` seatbelt profile whose only read rule is `(allow file-read* (subpath <project>))`
stops the child from reading `/bin/bash`, `/usr/lib`, `dyld`'s shared cache, `/System` — bash cannot
start. The prompt's rule *"a profile that still allows `file-read*` host-wide is not a fix"* points at
a profile that either breaks execution or keeps reading host system paths, i.e. reads are still not
confined to the project. The DoD's escape hatch ("or a test plus a documented reason shows why it
must stay") should be promoted to the *expected* outcome, with the honest conclusion: on macOS the
seatbelt profile confines **writes** (already true, `sandbox.ts:47–49`) and network, and cannot
confine *reads* to the project without a system-read allowance that reopens them. Note bwrap is a
different story — `--ro-bind / /` (`sandbox.ts:67–70`) plus `--unshare-all` is where Linux read
narrowing is actually achievable. The prompt treats macOS and Linux as one change; they are not.

### D5 — Operation-level vs path-level confinement are conflated

`read`/`write`/`edit` take a `path`. `grep`/`find`/`ls` take a *search root* (`path`/`cwd`) and can
walk whatever it points at — confining them means confining the root, and the "absent path → cwd"
default matters. The prompt lists all six tools together and specifies only read/write semantics.
Add a per-tool table: which input carries the path, what the absent value means, and what happens to
`glob`/recursive options.

### D6 — "Reuse the existing helpers" vs "evaluate both the lexical and realpath form" (internal tension)

`isPathContained` (`src/security.ts:113–118`) resolves through `realPathOfNearestExisting`, which
already `resolve()`s lexically (so `..` and absolute escapes are caught), realpaths (so symlink
escapes are caught), and fails closed when the root does not exist. There is no separate lexical
conclusion to "take the more restrictive of" — and demanding one invites a second, divergent
implementation, which the same sentence forbids. Either state "reuse `isPathContained`; do not add a
second implementation" or specify what the lexical pass adds (e.g. rejecting a scope root that is
itself a symlink, which `realpath` would hide).

### D7 — Scope-root validity is required in tests but never defined in the design (important)

§4 demands a test that "a scope entry that is an ancestor of the root (must be rejected)", but §2
never states the rule. Unspecified: is `cwd` implicitly always in the scope? Multiple roots — list,
order, dedup? Must an entry be inside `cwd`, or merely not an ancestor of it? Write the rule in §2
before implementing; otherwise the test encodes an accident.

### D8 — Refusal reason is a closed union (minor, but a compile-time landmine)

`RefusalReason` is an exhaustive union (`src/types.ts:113–124`) consumed by `describeRefusal`
(`src/policy.ts:130`). "add a refusal reason" needs the union member named in the prompt and a test
that the new reason renders — otherwise the implementer improvises a name that leaks to users.
Same for `CONFIG_VERSION` (`src/config.ts:18,78`): adding a config field changes the stored format
and its documentation; decide whether the version gate is bumped.

### D9 — README is missing from the edit list (important)

`README.md` documents the frontmatter field table (`:105–113`) and the config surface
(`:161–168`). Adding a scope field or config key without touching it makes the *documentation-match-code*
premise false on arrival — the prompt's own stated goal.

### D10 — The mission is not falsifiable as a single blob (process)

The DoD has no requirement to show a vector *is currently reachable* — only to cite code. A hermetic
test that fails before the change (e.g. `createReadToolDefinition` with a confined `ReadOperations`
and an outside path being accepted/refused) is what makes the diagnosis evidence rather than
narration. Also: one giant task spanning diagnosis → design → 10 files → docs is the highest-risk
shape for an agent; and per the repo's global rules the design must land in a markdown file, but §2
says "write the design down" without naming a path.

## 4. Strengths worth preserving in v2

- Accurate, non-obvious reconnaissance; the `KNOWN_FIELDS` trap warning is correct and valuable.
- Fail-closed tone matches design §8 #4; explicit "absent/unparsable scope is a refusal, never
  unrestricted".
- Correctly reuses the `customTools` override precedent, which does work
  (`agent-session.js:1953–1965`).
- Explicit anti-host-scan rule with an irony justification — appropriate given the task.
- Explicit "do not weaken invariants 1–10" guardrail.
- One-test-per-invariant convention matches design §9 and the existing suite.
- Non-goals line up with design §4.4 #2 (no container/VM) and §4.4 #4 (no deny lists).

## 5. Minimal patch set for a v2 prompt

1. Restate the mission as "impossible for the tools this extension supplies" (file tools + `sandbox: os`
   bash), not "a child run".
2. Add to required edits: design §4.4 #3, design §6, design §9 path, `SECURITY.md` §2 B4,
   `README.md`; widen the DoD grep.
3. Decide and write down three choices: `bash` + `sandbox: none` (refuse vs. document),
   `isolation: subprocess` with a narrow scope (refuse vs. document), and macOS seatbelt reads
   (write-only confinement is the honest outcome).
4. Specify: scope-root validity rule, multiple roots, implicit `cwd`, per-tool path input table,
   new `RefusalReason` name, `CONFIG_VERSION` decision.
5. Replace the "lexical + realpath, more restrictive" sentence with "reuse `isPathContained`
   (`src/security.ts:113`); do not add a second implementation".
6. Require one hermetic, currently-failing reproduction test before the fix, and split the work into
   gated stages (decisions → file tools → sandbox → docs).
