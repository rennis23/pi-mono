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
| `npm run release:patch`  | Bump patch version across all packages      |
| `npm run release:minor`  | Bump minor version across all packages      |
| `npm run release:major`  | Bump major version across all packages      |

Always run `npm run check` and `npm test` before committing. The Husky pre-commit hook enforces this.

## Repository layout

```
pi-mono/
├── packages/          # Workspace packages (each is a pi extension)
│   └── pi-hello/      # Example extension
├── scripts/           # sync-versions.js, release.mjs
├── test/              # Shared test setup (setup.ts)
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

Run `npm run check` to auto-fix formatting and lint issues (`biome check --write`).

## Conventions

### Package naming

- Directory: `packages/pi-<name>/`
- npm name: `@rennis23/pi-<name>`
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

### Versioning

All packages share the same version. Use the `release:*` scripts — never bump versions manually. The scripts run `sync-versions.js` and reinstall dependencies.

## Git hooks

- **pre-commit:** runs `npm run check` (Biome format + lint + tsc)
- **pre-push:** runs `npm test`
