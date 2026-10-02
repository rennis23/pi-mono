# Mutation Testing for `mx-pi-agents` — Plan

Date: 2026-10-01
Status: 80% mutation threshold confirmed by completed full run (80.49%)
Owner: agent

## Progress (2026-10-01)

- Tooling delivered (Stryker config, Stryker-specific vitest config, source-structure
test split, npm scripts, blocking pre-push hook, survivor helper script).
- Whole-package score raised **63.56% → 73.26% → 80.49%** (covered-code score was
77.20% at the intermediate run). The completed full run reports **2750 killed,
22 timeout, 519 survived, and 153 no-coverage** (3444 score-bearing mutants);
1954 errors are excluded from the score. Killed plus timed-out mutants yield
**2772 / 3444 = 80.49%**, clearing the 80% threshold by 17 mutants. The original
73.26% run had 2505 killed, 18 timeout, 745 survived and 176 no-coverage.
- Added 138 tests since the intermediate 1004-test run; `npm test` now passes 1142.
- The first unscoped attempt was stopped at 8% after about 7 minutes, but a later
full `npm run mutation` completed successfully in 21 minutes 59 seconds and
confirmed the threshold in Stryker's single report.

### Earlier iteration (intermediate per-file measurements)

The following table records the previous test-writing pass, before the continuation
that raised the aggregate above 80%.

|File|Before|After|
|---|---:|---:|
|`security.ts`|34.38|84.38|
|`frontmatter.ts`|73.86|82.99|
|`schema.ts`|80.36|85.82|
|`config.ts`|72.60|82.19|
|`directive.ts`|90.83|91.74|
|`concurrency.ts`|82.86|84.29|
|`budget.ts`|80.00|83.64|
|`complete.ts`|74.65|80.28|
|`index.ts`|47.16|53.97|
|plus `registry`, `persona`, `progress`, `render`, `trust`, `scope`, `prompt`, `policy`||improved|


## Goal

Add Stryker mutation testing to `packages/mx-pi-agents` with a hard
`thresholds.break = 80` gate and a blocking pre-push hook, reached by writing the
tests that currently do not exist.

## Baseline (measured, full run 2026-10-01)

- Mutators: 5398 across 27 files.
- Total mutation score: **63.56%** · covered-code score 71.09%.
- `CompileError` (discarded by the TypeScript checker): 1954 — excluded.
- Score counts: 2169 killed, 20 timeout, 890 survived, 365 no-coverage.

Score formula used by Stryker: `(killed + timeout) / (killed + timeout + survived + noCoverage)`.

### Kill requirement

To reach 80% we need `(2189 + x) / 3444 >= 0.80`, i.e. **x >= 566 additional kills**
(assuming the CompileError count stays roughly constant and no new survivors appear).

## Gap by file (survived + no-coverage = killable potential)

| File | Killed | Survived | NoCov | Gap |
|---|---:|---:|---:|---:|
| `index.ts` | 291 | 177 | 149 | **326** |
| `src/runners/in-process.ts` | 42 | 80 | 79 | **159** |
| `src/runners/subprocess.ts` | 115 | 110 | 23 | **133** |
| `src/frontmatter.ts` | 282 | 80 | 23 | **103** |
| `src/security.ts` | 32 | 45 | 18 | 63 |
| `src/schema.ts` | 221 | 46 | 8 | 54 |
| `src/persona.ts` | 123 | 33 | 8 | 41 |
| `src/progress.ts` | 94 | 33 | 8 | 41 |
| `src/config.ts` | 106 | 28 | 12 | 40 |
| `src/render.ts` | 73 | 31 | 3 | 34 |
| `src/registry.ts` | 46 | 24 | 7 | 31 |
| `src/trust.ts` | 70 | 27 | 3 | 30 |
| `src/scope.ts` | 92 | 28 | 2 | 30 |
| `src/runners/sandbox.ts` | 94 | 19 | 8 | 27 |
| `src/policy.ts` | 42 | 20 | 3 | 23 |
| `src/prompt.ts` | 27 | 20 | 0 | 20 |
| `src/modes.ts` | 74 | 17 | 3 | 20 |
| `src/complete.ts` | 53 | 17 | 1 | 18 |
| `src/output.ts` | 51 | 14 | 0 | 14 |
| `src/concurrency.ts` | 56 | 11 | 1 | 12 |
| `src/budget.ts` | 44 | 11 | 0 | 11 |
| `src/directive.ts` | 99 | 10 | 0 | 10 |
| `src/runners/confine.ts` | 26 | 5 | 2 | 7 |
| `src/runner.ts` | 2 | 1 | 4 | 5 |
| `src/runners/telemetry.ts` | 10 | 3 | 0 | 3 |
| **Total** | | | | **1255** |

Survivor mix by mutator: `ConditionalExpression` 368, `StringLiteral` 263,
`EqualityOperator` 150, `BlockStatement` 99, `MethodExpression` 80,
`BooleanLiteral` 71, `Regex` 45, `ArrayDeclaration` 43, `LogicalOperator` 41.

## Approach

Iterate per file for fast feedback; use the unscoped run below as the final gate
verification (the completed run took about 22 minutes):

```bash
# fast, scoped feedback (incremental results are reused by the full run)
npx stryker run --mutate "packages/mx-pi-agents/src/<file>.ts"
npx stryker run --mutate "packages/mx-pi-agents/src/<file>.ts" --ignoreStatic
```

Then a final full run to confirm the gate:

```bash
npm run mutation
```

### Work order (highest kill-per-effort first)

1. **Pure logic with existing tests** — add boundary/error cases:
   `frontmatter`, `config`, `scope`, `trust`, `security`, `schema`, `persona`,
   `progress`, `render`, `registry`, `complete`, `output`, `budget`, `directive`,
   `modes`, `policy`, `prompt`. Target: ~350 kills.
2. **`index.ts`** — extend `index.test.ts` via `test/harness.ts` (fake pi API):
   exercise error paths, flag parsing, event handlers, completion, directive
   dispatch, widget/status. Target: ~150 kills.
3. **Runner modules** (`in-process`, `subprocess`, `sandbox`, `confine`) — add
   focused tests for argv/profile builders and refusal branches (pure helpers),
   and use the fake child session harness where possible. Target: ~80 kills.

## Tooling delivered

- `stryker.config.json` — whole-package mutate set, vitest runner + TS checker,
  `thresholds { high: 90, low: 80, break: 80 }`, incremental + HTML/JSON reports,
  `cleanTempDir: "always"` so a failed run leaves no `.stryker-tmp` that would
  break Biome.
- `vitest.stryker.config.ts` — excludes `source-structure.test.ts`, whose
  exact-substring source assertions cannot survive Stryker instrumentation.
- `packages/mx-pi-agents/src/source-structure.test.ts` — the two source-text
  invariant checks moved out of `security.test.ts`; still run by `npm test`.
- Root scripts: `mutation`, `mutation:mx-pi-agents`.
- `.husky/pre-push` — blocking Stryker run (added per operator decision).
- `.gitignore` — `.stryker-tmp/`, `reports/`.

## Risks / notes

- The completed unscoped run confirms the configured 80% gate in Stryker's single
report and refreshes the incremental cache for the pre-push hook.
- Remaining survivors are still concentrated in `index.ts` and the runner run loops
  (`in-process.ts`, `subprocess.ts`); the threshold is met without suppressing or
  excluding mutants.
- Each kill costs roughly one focused boundary test; the existing suites already
  cover most happy paths, so remaining wins are negative/edge cases.
- Some survivors are equivalent mutants and cannot be killed; budget for a
  tail. If the practical ceiling lands below 80, the remaining levers are
  `// Stryker disable` on specific equivalent mutants (documented one by one) or
  narrowing `mutate`.
- `CompileError` mutants are excluded from the score by design.
- A full run takes ~25 min; pre-push therefore becomes slow. Operator accepted
  this trade-off.

## Verification

- `npm run check` passes (Biome + TypeScript).
- `npm test` passes: 36 files, 1142 tests.
- Full unscoped `npm run mutation` completed in 21 minutes 59 seconds and passed
the 80% break threshold: 2750 killed, 22 timeout, 519 survived, 153 no-coverage,
1954 errors excluded; mutation score **80.49%**. `npm run mutation:survivors`
reports the remaining survivors, concentrated in `index.ts` and the runner modules.
