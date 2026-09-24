# AGENTS.md

Instructions for AI coding agents working on this repository.

> **Required:** Read [DOD-AGENT.md](./DOD-AGENT.md) for the Definition of Done criteria that must be met before declaring any task complete.

## Project overview

**pi-mono** is an npm workspaces monorepo for [pi.dev](https://pi.dev) extensions. Each package under `packages/` is a self-contained pi extension published to npm under the `@rennis23` scope.

Known follow-ups (release-script hardening, husky nits) are tracked in [TODO.md](./TODO.md) — check it before touching `scripts/` or `.husky/`.

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

Run a single test:

```bash
npx vitest run packages/mx-pi-context-stats/src/config.test.ts   # one file
npx vitest run packages/mx-pi-context-stats -t "averages positive deltas"  # by test name
```

Always run `npm run check` and `npm test` before committing. The Husky pre-commit hook enforces this.

## Repository layout

```
pi-mono/
├── packages/          # Workspace packages (each is a pi extension)
│   ├── mx-pi-agents/  # Secure agent registry + subagent runner
│   │   ├── index.ts   # thin pi wiring: tool, command, flags, session pinning
│   │   ├── src/       # pure logic, no pi types (one .test.ts per file)
│   │   ├── src/runners/ # in-process / subprocess / sandbox execution
│   │   ├── agents/    # bundled agent definitions (*.md frontmatter)
│   │   └── test/      # harness.ts (fake pi API) + fixtures.ts
│   └── mx-pi-context-stats/ # Context/token/cost stats widget
│       ├── index.ts   # thin pi wiring: events, command, flags, widget
│       ├── src/       # pure logic, no pi types (one .test.ts per file)
│       └── test/      # harness.ts — fake pi API for end-to-end tests
├── sandbox/           # smolvm micro-VM runtime assets (NOT an npm package)
├── scripts/           # sync-versions.js, release.mjs
├── test/              # Shared test setup (setup.ts)
├── docs/              # Design docs (smolvm-sandbox.md, superpowers/specs|plans)
├── .husky/            # pre-commit / pre-push hooks
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
- **Imports:** ESM — relative imports always carry an explicit `.js` extension even though the source is `.ts` (e.g. `from "./src/config.js"`); type-only imports use `import type`; Node builtins use the `node:` prefix

Run `npm run check` to auto-fix formatting and lint issues (`biome check --write`).

## Architecture notes

### Extension layering (see `mx-pi-agents`)

- `index.ts` is a thin pi wiring layer: it registers the `mx_pi_agent` tool, the
  `/mx-pi-agents` command and the `--mx-pi-agents-*` flags, pins the registry on
  `session_start`, and delegates every decision to `src/`. It owns no computation.
- `src/` is pure logic with no pi types (the only exceptions are the minimal
  `RenderTheme` surface in `render.ts` and the runner modules under
  `src/runners/`, which own pi SDK session creation).
- Security decisions are fail-closed and total: `schema.ts` computes grants,
  `policy.ts` turns a pinned definition into a `RunPlan` or a refusal, and
  `registry.ts` pins definitions by SHA-256 at session start. There is no branch
  anywhere that yields "unrestricted" as a fallback.
- `src/runners/in-process.ts` is the only module that may construct a child
  `AgentSession`, and it must never be given an empty `agentDir` (that would
  resolve `<agentDir>/settings.json` against `process.cwd()`).
- `src/security.test.ts` maps one test per security invariant; a failure there
  names the broken invariant. See `packages/mx-pi-agents/SECURITY.md` for what is
  deliberately *not* enforced.

### Extension layering (see `mx-pi-context-stats`)

- `index.ts` is a thin pi wiring layer: lifecycle events (`pi.on`), the `/mx-pi-settings` command, CLI flags, and widget/status registration. It owns no computation.
- `src/*.ts` is pure logic with no pi types (the only exception is the minimal `ThemeLike` surface in `widget.ts`), so every module is unit-testable without loading pi or a TUI.
- End-to-end tests of `index.ts` drive the fake API in `packages/mx-pi-context-stats/test/harness.ts` (`emit()`, `runCommand()`, `render()`); `mockTheme` echoes plain text so assertions stay ANSI-free.
- Tests never touch the real `~/.pi` dir: the config store takes an injectable path, so tests use temp dirs.
- Time is injected: pure modules take a `now` argument instead of calling `Date.now()` internally. This is what makes every timing path deterministic under test.
- Pure helpers are total. `format.ts` never returns `NaN`/`Infinity`, and `health.ts` returns `undefined` (not `0`) when a metric is unmeasurable, so callers omit the cell rather than render a misleading number.

### Pi integration rules

- Never replace pi's native footer: publish extras with `ctx.ui.setStatus(key, text)` and let the built-in footer render them.
- A widget's `render(width)` runs every frame and must read state fresh — that is how option changes and streaming updates appear without re-registering.
- To force a redraw from outside a render (streaming updates, command changes), call `widgetTui.requestRender()` on the handle captured from the widget factory.
- Wrap every pi API call reachable from an event or render in try/catch: a disposing session must never crash the TUI.
- Durable options live in `<agentDir>/extensions/<extension>.json` (via `getAgentDir()`, which honors `PI_CODING_AGENT_DIR`). The file is the source of truth at session start; CLI flags override it for a single run only.
- New packages declare `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peer deps (publish constraint `>=0.80.0`) plus dev deps for local dev. There is no build step — the published artifact is TypeScript source, and `files` lists `index.ts`, `src/**`, `README.md`, `LICENSE`.

### Sandbox

- `sandbox/` is not an npm package. It runs pi inside a hardware-isolated smolvm (libkrun) micro-VM on macOS: image build, egress allowlists, curated skills/extensions, and launch scripts.
- Entry points: `sandbox/scripts/run-agent.sh` (or the `Makefile` targets); usage in `sandbox/README.md`, design rationale in `docs/smolvm-sandbox.md`.

### Design docs

- Design specs and implementation plans go in `docs/superpowers/specs/` and `docs/superpowers/plans/` (date-prefixed filenames).

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
- Coverage excludes `node_modules`, `dist`, `.pi`, `*.test.ts`, `*.d.ts`, and `packages/*/test/**` (shared harness helpers)

### Versioning

All packages share the same version. Use the `release:*` scripts — never bump versions manually. `scripts/release.mjs` requires a clean tree, runs coverage, bumps all packages in lockstep, syncs internal dependency versions, promotes each package's `CHANGELOG.md` `[Unreleased]` section, commits + tags, publishes, and pushes `master`. Keep a `CHANGELOG.md` with an `[Unreleased]` section in each package so releases record changes. Rehearse with `node scripts/release.mjs patch --dry-run`.

## Git hooks

- **pre-commit:** runs `npm run check` (Biome format + lint + tsc)
- **pre-push:** runs `npm test`
