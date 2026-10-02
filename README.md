# pi-mono

npm workspaces monorepo for [pi.dev](https://pi.dev) extensions.

## Structure

```
pi-mono/
├── packages/          # Workspace packages
│   ├── mx-pi-agents/        # Secure agent registry and subagent runner
│   └── mx-pi-context-stats/ # Context/token/cost stats widget
├── scripts/           # Version sync and release helpers
├── test/              # Shared test setup
├── package.json       # Workspace root
├── tsconfig.base.json # Shared TypeScript config
├── biome.json         # Shared formatter/linter config
└── vitest.config.ts   # Shared test runner
```

## Getting started

Requires Node.js 22+ and npm 11+.

```bash
npm install
npm run check   # biome + tsc
npm test        # vitest
```

## Adding a package

1. Create `packages/pi-<name>/`.
2. Add a `package.json` with `"name": "@rennis23/pi-<name>"` and a `pi.extensions` entry pointing to the extension file.
3. Add an `index.ts` that exports a default extension factory.
4. Add tests next to the source files (`*.test.ts`).

## Releasing

Versions are kept in lockstep across all workspace packages.

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

## Mutation testing

Stryker mutation testing is configured at the repo root (`stryker.config.json`)
and scoped to `packages/mx-pi-agents`.

```bash
npm run mutation             # full run (slow, ~22 min)
npm run mutation:changed     # only files changed vs HEAD (fast local feedback)
npm run mutation:changed -- master
npm run mutation:changed -- HEAD --list   # print the mutate list, run nothing
npm run mutation:survivors   # survived / uncovered mutants from the last report
```

`mutation:changed` diffs against `HEAD` by default (staged, unstaged and
untracked files) and takes any git ref as its first argument. When no mutable
source file changed it exits 0 without invoking Stryker. Unknown flags are
passed through to `stryker run`, e.g. `npm run mutation:changed -- --ignoreStatic`.

## Husky hooks

- `pre-commit` runs formatting, linting, and type checking.
- `pre-push` runs the test suite and the full `npm run mutation` gate.
