# pi-mono

npm workspaces monorepo for [pi.dev](https://pi.dev) extensions.

## Structure

```
pi-mono/
├── packages/          # Workspace packages
│   ├── mx-pi-context-stats/ # Context/token/cost stats widget
│   └── mx-pi-settings/      # Central settings hub + SDK for mx-pi extensions
├── scripts/           # Release, security, and mutation helpers
├── test/              # Shared test setup
├── .github/           # Pull-request CI and CodeQL configuration
├── package.json       # Workspace root
├── SECURITY.md        # Repository security policy
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
npm run security # package policy + audit + local CodeQL
```

## Adding a package

1. Create `packages/mx-pi-<name>/`.
2. Add a public `package.json` named `@rennis23/mx-pi-<name>` with a `pi.extensions` entry and explicit `files` allowlist.
3. Add an `index.ts` that exports a default extension factory.
4. Add `README.md`, `LICENSE`, `CHANGELOG.md`, and `SECURITY.md`.
5. Add tests next to the source files (`*.test.ts`).

## Releasing

Versions are kept in lockstep across all workspace packages.

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

## Quality and security guardians

- `npm run security:packages` validates every public package and its actual npm tarball contents.
- `npm run security:audit` blocks high and critical production dependency advisories.
- `npm run security:codeql` runs local CodeQL `security-extended` analysis and fails on SARIF findings.
- `npm run mutation:changed` runs Stryker only for changed package source; pass a base ref in CI when needed.
- All quality and security package analysis covers `packages/` and explicitly excludes `sandbox/`.
- The pull-request workflow defines separate quality, package-security, mutation, CodeQL, and dependency-review jobs. Configure them as required checks in GitHub branch protection.

## Husky hooks

- `pre-commit` runs formatting, linting, and type checking.
- `pre-push` runs tests, package policy, dependency audit, changed-source mutation, and local CodeQL when installed.
