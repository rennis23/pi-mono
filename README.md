# pi-mono

npm workspaces monorepo for [pi.dev](https://pi.dev) extensions.

## Structure

```
pi-mono/
├── packages/          # Workspace packages
│   └── pi-hello/      # Minimal example extension
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

## Husky hooks

- `pre-commit` runs formatting, linting, and type checking.
- `pre-push` runs the test suite.
