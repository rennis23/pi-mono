# AGENTS.md

Instructions for AI coding agents working on this repository.

> **Required:** Read [DOD-AGENT.md](./DOD-AGENT.md) for the Definition of Done criteria that must be met before declaring any task complete.

## Project overview

**pi-mono** is an npm workspaces monorepo for [pi.dev](https://pi.dev) extensions. Each package under `packages/` is a self-contained pi extension published to npm under the `@rennis23` scope.

## Tech stack

- **Runtime:** Node.js 22+
- **Language:** TypeScript 6, strict mode, ES2022 target
- **Module system:** ESM (`"type": "module"`, Node16 module resolution)
- **Formatter/Linter:** Biome 2.5
- **Test runner:** Vitest 4
- **Git hooks:** Husky 9

## Commands

| Command                  | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `npm run check`          | Format, lint (Biome), and type-check (tsc)  |
| `npm test`               | Run all tests                               |
| `npm run coverage`       | Run tests with V8 coverage                  |
| `npm run security`       | Run package, dependency, and CodeQL checks  |
| `npm run security:packages` | Validate public package artifacts       |
| `npm run security:codeql` | Run local CodeQL and SARIF gate            |
| `npm run mutation:changed` | Mutate changed package source only        |
| `npm run mutation:survivors` | Report mutation gaps                    |
| `npm run release:patch`  | Bump patch version across all packages      |
| `npm run release:minor`  | Bump minor version across all packages      |
| `npm run release:major`  | Bump major version across all packages      |

Always run `npm run check` and `npm test` before committing. The Husky pre-commit hook enforces this.

## Repository layout

```
pi-mono/
├── packages/          # Workspace packages (each is a pi extension)
│   └── mx-pi-context-stats/ # Context/token/cost stats widget
├── scripts/           # release, security, and mutation helpers
├── test/              # Shared test setup (setup.ts)
├── .github/           # Pull-request CI and CodeQL configuration
├── biome.json         # Shared formatter/linter config
├── tsconfig.base.json # Shared TypeScript config
└── vitest.config.ts   # Shared test runner config
```

## Code style

Biome is the single source of truth for formatting and linting. Key settings (see `biome.json`):

- **Indent:** tabs, width 3
- **Line width:** 120 characters
- **`noExplicitAny`:** off — `any` is allowed
- **`noNonNullAssertion`:** off — `!` assertions are allowed
- **`useConst`:** error — always prefer `const`
- **Repository scope:** quality and security tooling covers `packages/` and explicitly excludes `sandbox/`

Run `npm run check` to auto-fix formatting and lint issues (`biome check --write`).

## Conventions

### Package naming

Every extension and skill in this repository uses the `mx-pi-` prefix. All
user-visible names must begin with `mx-pi-`:

- Directory: `packages/mx-pi-<name>/`
- npm name: `@rennis23/mx-pi-<name>`
- Registered commands and CLI flags: must start with `mx-pi-` (e.g. command
  `/mx-pi-context-stats`, flags `--mx-pi-context-stats-rows`)
- Skills (e.g. under `sandbox/skills/`): `mx-pi-<name>/SKILL.md`
- Include `"pi": { "extensions": ["./index.ts"] }` in `package.json`

### Extension structure

Each extension exports a default function that receives `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
   pi.registerCommand("myCommand", {
      description: "What it does",
      handler: async (args, ctx) => {
         // implementation
      },
   });
}
```

### Testing

- Co-locate tests with source: `hello.test.ts` next to `index.ts`
- Shared setup lives in `test/setup.ts`
- Vitest is configured with `clearMocks`, `restoreMocks`, and `unstubGlobals`
- Coverage excludes `node_modules`, `dist`, `.pi`, `*.test.ts`, and `*.d.ts`
- Root script tests use `scripts/**/*.test.mjs`; package coverage remains scoped to `packages/`
- Package artifacts are checked with `npm run security:packages`; tests and harnesses must not ship

### Security and mutation testing

- `npm run security:packages` validates every direct workspace under `packages/`, including its `npm pack --dry-run` contents.
- `npm run security:audit` blocks high and critical production dependency advisories.
- `npm run security:codeql` uses the local CodeQL CLI with `security-extended` queries and fails on SARIF findings. The local pre-push hook skips this one check only when the CLI is unavailable; CI remains authoritative.
- `npm run mutation:changed` compares package source against `HEAD` locally or an explicit PR base SHA in CI. It skips tests, reports, generated files, and `sandbox/`.
- Full mutation testing is available with `npm run mutation`, but changed-source mutation is the mandatory PR/local gate.

### Versioning

All packages share the same version. Use the `release:*` scripts — never bump versions manually. The scripts run `sync-versions.js` and reinstall dependencies.

## Git hooks

- **pre-commit:** runs `npm run check` (Biome format + lint + tsc)
- **pre-push:** runs tests, package policy, dependency audit, changed-source mutation, and local CodeQL when installed.

PR CI defines separate required quality, package-security, mutation, CodeQL, and dependency-review jobs. Configure those job names as required checks in GitHub branch protection.
