# PLAN — Sandbox toolchain access, verifier and security-reviewer agents

Source of truth for this work. Replaces the completed "Readable agent names" plan,
which remains in git history.

Operator decisions taken before planning (no longer open):

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Toolchain roots source | Derived at runtime from `process.execPath` and `PATH`, NOT a hardcoded `/opt/homebrew` |
| 2 | New agents | two bundled agents — `verifier` and `security-reviewer` |
| 3 | Orchestrator stages | `product-builder` gains mandatory Verify and Security stages before it reports |
| 4 | Reviewer posture | the security reviewer is read-only and informed by the piolium audit methodology |
| 5 | Plan file | `packages/mx-pi-agents/PLAN.md` |

Baseline: `npx vitest run packages/mx-pi-agents` green, working tree clean before the change.

---

## 1. Diagnosed defect

A `sandbox: os` agent that declares `bash` could not exec the JavaScript toolchain at all.

Evidence, from the pre-change `src/runners/sandbox.ts`:

- `sandbox.ts:37` — `SEATBELT_SYSTEM_READ_ROOTS = ["/usr", "/bin", "/sbin"]`. The seatbelt
  read allowance is the immutable system binary directories only.
- `sandbox.ts:72-74` — `buildSeatbeltProfile` emits one `(allow file-read* (subpath …))`
  clause per entry in `SEATBELT_SYSTEM_READ_ROOTS` (plus the run scope).
- On the operator's macOS host the toolchain lives under `/opt/homebrew` (Homebrew), not
  under any of those three roots.

Observed symptom: a delegated `builder` run, whose `bash` runs under `sandbox: os`, failed
with `npx: command not found`. The shell could start but could not read the directory holding
`node`/`npm`/`npx`, so the command the sandbox existed to allow was impossible.

The fix derives the real toolchain directories from the running process rather than trusting
a hardcoded machine-specific path:

- `toolchainReadRoots()` folds the directories of `process.execPath` and of the `npm`/`npx`
  found on `PATH`, each resolved through realpath, plus the enclosing global `node_modules`
  and the node install prefix, into `SEATBELT_SYSTEM_READ_ROOTS`.
- A path that does not resolve contributes nothing (the function is total), so a machine
  without Homebrew is unaffected.

This deliberately widens the sandboxed read allowance; it is documented in `SECURITY.md` and
in the CHANGELOG, and Section 4 records why it is the correct trade.

### Second, observed layer: dynamic dependencies

The first fix made the `node` binary itself readable, but `node` still aborted under dyld with
`Library not loaded ... (blocked by sandbox)` and exit 134. A `node` binary does not carry its
dynamic dependencies: on Homebrew they are sibling formulae under the package manager prefix
(`<prefix>/opt/<formula>`, stored under `<prefix>/Cellar/<formula>`), not under the node install
prefix the first fix added. `toolchainLibraryRoots()` now derives that prefix — the ancestor above
`Cellar` when the binary lives in one, otherwise the install prefix two levels above the binary —
and folds its `bin`, `lib`, `opt`, `Cellar` and `etc` directories (when they exist) into
`SEATBELT_SYSTEM_READ_ROOTS`; the home directory is refused as a library prefix.

The write allowance was deliberately **not** widened at the same time: writes are still granted
only under the run scope, and temp-directory writes remain denied. If a test runner turns out to
need scratch space, widening the write allowance is a candidate follow-up — flagged here, done
not.

### Third, observed layer: runtime configuration under `etc`

Making the binary and its libraries readable was still not sufficient. `node --version`
succeeded, but every script failed at OpenSSL initialisation:

```text
node: OpenSSL configuration error:
80FFCD0102000000:error:80000001:system library:BIO_new_file:Operation not permitted:
crypto/bio/bss_file.c:67:calling fopen(/opt/homebrew/etc/openssl@3/openssl.cnf, rb)
```

node's OpenSSL initialisation reads its own configuration at
`<prefix>/etc/openssl@3/openssl.cnf`, and the prefix's `etc` directory was not in the read
allowance, so the runtime aborted before any script could run.
`toolchainLibraryRoots()` therefore also folds the prefix's `etc` directory (when it exists)
into `SEATBELT_SYSTEM_READ_ROOTS`. This is why the fix had to be validated by actually
running a script rather than by checking that the binary loads: `node --version` succeeds
without `etc`, so a binary-loads check would have passed while every real run failed.

### Fourth, observed layer: path resolution

After the third fix the runtime loaded completely — `node --version` printed `v26.10.0` and
`node -e 'console.log("ok")'` printed `ok` — yet every real invocation still failed:

```text
Error: EPERM: operation not permitted, lstat '/opt'
    at Object.realpathSync (node:fs:3436:29)
    at Module._findPath (node:internal/modules/cjs/loader:861:36)
    at resolveMainPath (node:internal/modules/run_main:37:21)
  errno: -1, code: 'EPERM', syscall: 'lstat', path: '/opt'
```

`npx`, `npm --version` and `node <file>` all died identically; a direct `node <file>` reported
`lstat '/Users'` instead. node's module loader calls `realpathSync` on the entry path, which
`lstat`s every ancestor (`/`, `/Users`, `/Users/toru`, `/Users/toru/project`, `/opt`,
`/opt/homebrew`). A seatbelt `(allow file-read* (subpath X))` rule grants X and its descendants
but says nothing about X's ancestors, so resolution failed before a single line of the script ran.
Inline `node -e` worked only because it resolves no entry file.

The fix is a global metadata-only read, `(allow file-read-metadata)`. Per-root ancestor literals
would have been more precise, but they would have recurred every time node resolved a path
outside the allowed roots (a symlink target, the npm cache, a home config) — another
one-layer-per-reload cycle. The rule is metadata-only: it reveals that a path exists, never its
contents. Content reads remain per-root and there is still no bare `(allow file-read*)`.

Two further allowances were approved in the same pass, explicitly to stop the
one-layer-per-reload cycle:

- The system temp directory (`TMPDIR`, `/tmp`, `/private/tmp`, resolved through realpath) is
  readable **and** writable, because a test runner routinely needs scratch space outside the
  project.
- The npm cache (`~/.npm`, or `npm_config_cache`) is readable, read-only on purpose because a
  sandboxed child must not be able to poison a cache the unsandboxed host later reads.

The lesson: this is the layer where the earlier fixes **looked** successful — both `node --version`
and `node -e` passed — while every real invocation still failed. Only running an actual script was
a valid check. (The third-layer subsection makes the same point about `node --version` alone; here
it is the pair.)

The Linux `bwrap` path was deliberately left unchanged: it already provides `--tmpfs /tmp`, and
its write allowance is unchanged.

---

## 2. piolium-derived review methodology

The `security-reviewer` agent adopts the review method from the piolium audit, not a generic
"look for bugs" prompt. The method it must follow:

1. **Threat model first.** Assets, adversary, entry points and explicit non-goals, reusing the
   vocabulary of `SECURITY.md`.
2. **Decompose the claim into testable sub-claims.** A: the attacker controls input X. B: X
   reaches code point Y without adequate sanitisation. C: Y causes security effect Z. If any
   sub-claim fails, the verdict is **DISPROVED** — never softened into a lower severity.
3. **Independent trace from the entry point.** The reviewer traces the path itself; the author's
   summary, comments and quoted snippets are claims to be checked, not evidence.
4. **Protection-surface search by layer** — language, framework, middleware, application, and
   documentation — including whether `SECURITY.md` or a CHANGELOG entry explicitly accepts the
   risk as known.
5. **Severity-ranked, CWE-tagged findings.** Critical/High/Medium/Low/Informational, each with a
   CWE id.
6. **Self-contained findings.** Each finding carries `## Summary`, `## Details`, `## Root Cause`,
   `## Impact` and `file:line` evidence. Pointer phrases that make a finding depend on another
   document are banned (`see draft.md`, `refer to the debate`, `for the full analysis see …`).
7. **An explicit "what I could not verify" section**, so the verdict never implies coverage that
   was not achieved.

The agent body encodes this method verbatim so the reviewer does not re-derive it per run, and it
singles out this extension's own invariants: fail-closed grants, scope confinement, no
spawn-capable tool in a child, definition pinning, and any change that widens a sandbox read or
write allowance.

---

## 3. Why the security reviewer gets no `bash`

piolium's own audit found that its review agents — running with `bypassPermissions` and `Bash` —
were the vector for its Critical **P-01** finding: a repository-controlled `.pi/settings.json`
(`shellCommandPrefix`/`shellPath`) giving unconditional host code execution with no model
cooperation. A shell handed to an agent that reads an untrusted repository is the pattern, not an
incidental detail.

This repository fixed P-01 and P-02 structurally:

- the child settings manager is built from `<agentDir>/settings.json` read directly, so no code
  path can observe `<cwd>/.pi/settings.json`;
- child resource discovery is disabled entirely, so repository skills and context files cannot
  reach the child system prompt.

`security-reviewer` must not reintroduce the pattern. It is granted `read`, `grep`, `find`, `ls`
and **no `bash`**, so it cannot execute repository-controlled code even indirectly. It reports the
minimal fix for a finding instead of applying it; `builder` (or the operator) applies it.

---

## 4. Files touched

| File | Change |
| --- | --- |
| `src/runners/sandbox.ts` | add `toolchainReadRoots()` and `toolchainLibraryRoots()` (the latter folding `bin`, `lib`, `opt`, `Cellar` and `etc` under the derived prefix); fold their output into `SEATBELT_SYSTEM_READ_ROOTS` |
| `src/runners/sandbox.ts` | add `sandboxTempRoots()` (realpath-resolved system temp roots) and `packageManagerReadRoots()` (the npm cache); both are folded into `SEATBELT_SYSTEM_READ_ROOTS` — the temp roots also contribute a write clause |
| `agents/verifier.md` | new bundled agent (`read, grep, find, ls, bash`; `sandbox: os`) |
| `agents/security-reviewer.md` | new bundled agent (`read, grep, find, ls`; no `bash`) |
| `agents/product-builder.md` | add mandatory stages 7 Verify and 8 Security before the report |
| `README.md` | roster rows, orchestrator stage note, sandbox read-allowance sentence |
| `CHANGELOG.md` | the two agents, the orchestrator stages, the widened read allowance |
| `SECURITY.md` | record the widened read allowance and keep the existing claims true |

---

## 5. Test matrix

| Behaviour | Test |
| --- | --- |
| `toolchainReadRoots()` returns the realpath dirs of `node`/`npm`/`npx` and the enclosing `node_modules` | `src/runners/sandbox.test.ts` (new) |
| an unresolvable candidate contributes nothing and the function never throws | new |
| `toolchainLibraryRoots()` derives `opt`, `Cellar` and `etc` under a Homebrew-shaped prefix | `src/runners/sandbox.test.ts` |
| the `etc` directory is included so node can read `<prefix>/etc/openssl@3/openssl.cnf` at OpenSSL init | new |
| `toolchainLibraryRoots()` refuses the home directory as a library prefix | `src/runners/sandbox.test.ts` |
| `SEATBELT_SYSTEM_READ_ROOTS` still contains `/usr`, `/bin`, `/sbin` | existing golden profile test |
| the profile carries a bare `(allow file-read-metadata)` and it is not emitted per-root | new `buildSeatbeltProfile` test |
| the temp write clause is emitted | new `buildSeatbeltProfile` test |
| `sandboxTempRoots()` resolves through realpath and dedupes | `src/runners/sandbox.test.ts` (new) |
| `packageManagerReadRoots()` returns `[]` for a nonexistent path and for an empty path | `src/runners/sandbox.test.ts` (new) |
| the generated seatbelt profile emits one read clause per system root including the toolchain dirs | new/updated `buildSeatbeltProfile` test |
| `verifier` loads with `bash` and `sandbox: os`, and writes are still confined to the run scope | `src/bundled-agents.test.ts` |
| `security-reviewer` loads with no `bash` and no write tool | `src/bundled-agents.test.ts` (new) |
| `product-builder` names Verify and Security as stages and blocks on Critical/High | `src/bundled-agents.test.ts` (new assertion) |

---

## 6. Verification

```bash
npx vitest run packages/mx-pi-agents
npx vitest run packages/mx-pi-agents/src/runners/sandbox.test.ts
npm run check
npm test
```

The sandbox profile is built by the **loaded** runtime, so every one of the four fixes above
requires a `/reload` before it can be exercised. At the time of writing the verification run had
not yet succeeded — none of the commands above have been run against this change.

---

## 7. Definition of done (per DOD-AGENT.md)

- [ ] `npm run check` and `npm test` pass, with the output shown
- [ ] No `TODO`/`FIXME`/commented-out code; no unrelated file touched
- [ ] New tests are co-located, deterministic, and cover happy path, edge cases and errors
- [ ] `README.md`, `CHANGELOG.md` and `SECURITY.md` updated because user-facing and security
      behaviour changed
- [ ] Diff re-read; scope creep confirmed absent
- [ ] Nothing committed

---

## 8. Explicitly out of scope

- piolium's other ~30 agents. Only its review methodology is borrowed; none of its roster,
  prompts or configuration is.
- Linux `bwrap` toolchain roots. The defect and the fix are the macOS seatbelt profile; `bwrap`
  already `--ro-bind`s the system roots and is left as-is.
- Any PoC-execution sandbox for the security reviewer. It stays read-only with no shell, by the
  decision in Section 3.

---

## 9. Risks

- **The extension is pinned at `session_start`.** The new roster and the new sandbox profile only
  take effect after the session reloads; a running session keeps the old profile and the old
  agent list until then. Operators must restart (or `#none` and refresh) to pick up the change.
- **Widened read allowance.** A sandboxed child can read the host's JS toolchain directories. This
  is a deliberate, documented widening (Section 1); `SECURITY.md` records it and the reviewer
  treats any future widening as a finding unless it is documented.

---

## 10. Resolution and architectural verdict (post-mortem)

### Verification — finally executed

All commands run in the orchestrator's own (unsandboxed) shell, 2026-02-15:

- `npx vitest run packages/mx-pi-agents` — **30 files, 1062 tests, all pass**
- `npm run check` — **biome + `tsc --noEmit` clean**
- `npm test` — **38 files, 1209 tests, all pass**

Two test bugs were found and fixed on the first real run (they were written blind during the
reload cycles): `toolchainReadRoots("…", undefined)` triggered the default parameter
(`process.env.PATH`), and the Homebrew-layout test compared a `/var/…` expectation against the
function's realpath'd `/private/var/…` output. Both were test-side; the source was correct.

### The missing artifact, now present: executed-profile tests

The root cause of the four reload cycles was not any single layer of the fix — it was that the
repository had **no test that executes the generated profile**. Every assertion was string-level
(`toContain("(allow file-read* (subpath …"))`), so the shipped profile could be — and was —
dead on arrival while the suite stayed green.

`sandbox.test.ts` now has `describe("buildSeatbeltProfile, executed")` (darwin-gated), which runs
a real process under the generated profile and crosses each boundary in both directions:

1. node runs a real script — proves binary, dylibs, OpenSSL config and path resolution in one shot;
2. an entry file resolves through its ancestors — the layer-four mechanism, proven directly;
3. a temp-directory write succeeds;
4. a `$HOME` write fails and leaves no file — the write boundary, exercised not asserted;
5. network egress fails — the other boundary, exercised not asserted.

Any future narrowing that breaks the toolchain fails test 1–2 immediately, on the developer's
machine, with no reload. Any future widening of writes or network fails test 4–5.

### Verdict on the sandboxing idea (the question that was asked)

**The idea is sound; the shipped implementation was untested theater.**

- The boundary choice was right all along: **writes and network are what a sandbox for an
  unattended agent must confine.** The code said so in comments; the implementation just never
  survived contact with a real toolchain.
- The read side was over-confined to the point of uselessness: `["/usr", "/bin", "/sbin"]` cannot
  start a Homebrew or nvm node. Nobody noticed because nothing ever ran inside the profile.
- "Maximum security vs. tool access" is a false trade-off. Reads of a toolchain are not
  containable in any useful sense — dyld, OpenSSL config, node module resolution and temp scratch
  each demand their own surface, discoverable only by execution. The correct posture is: reads
  just wide enough (derived toolchain roots, global metadata-only read, read-only npm cache,
  temp dir), writes confined to the run scope plus temp, network denied. Exfiltration and
  destruction stay blocked; work does not.
- The derivation approach (everything computed from `process.execPath`/`PATH`, nothing hardcoded,
  unresolvable candidates contribute nothing, `$HOME` refused as a library prefix) is kept and is
  now backed by execution.

### Process lesson

Verification was delegated to the sandboxed sub-agent — the very component under repair — while
the orchestrator's own shell was never sandboxed. Four reload cycles were spent remote-debugging
a guest through a keyhole when `npx vitest run` in the host would have answered in seconds.
Delegate tests to the environment that can run them; never let the thing under test be the only
thing that can test it.
