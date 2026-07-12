# PR #1 Review — Fix Plan

**PR:** [chore: scaffold pi-mono base monorepo for pi.dev extensions](https://github.com/rennis23/pi-mono/pull/1)
**Date:** 2026-07-12
**Status:** ✅ Complete

---

## 🔴 Blocker — must fix before merge

### 1. Fix `main` → `master` branch references

Two locations reference `main` but the repo default branch is `master`. The release script will fail on publish.

| File | Line | Change |
|------|------|--------|
| `scripts/release.mjs` | `git push origin main` | → `git push origin master` |
| `packages/pi-hello/package.json` | `"homepage": ".../tree/main/..."` | → `.../tree/master/...` |

---

## 🟡 Recommended — before first release

### 2. Decouple `getVersion()` from `packages/pi-hello`

`scripts/release.mjs` hardcodes the path to `pi-hello`:

```js
function getVersion() {
    const pkg = JSON.parse(readFileSync("packages/pi-hello/package.json", "utf-8"));
    return pkg.version;
}
```

**Fix:** Read the version from the root `package.json` or dynamically pick the first workspace package. This unblocks adding a second package without breaking the release workflow.

### 3. Add `--dry-run` flag to `release.mjs`

The full release script commits, tags, pushes, and publishes — with no preview mode. A `--dry-run` flag that prints what it *would* do (skipping `git commit`, `git tag`, `git push`, and `npm publish`) reduces risk on first real release.

### 4. Make `sync-versions.js` writes atomic

Currently writes each `package.json` as it encounters changes. If writing fails mid-way, the workspace is left in an inconsistent state.

**Fix:** Accumulate all changes in memory, validate, then write all files in one pass. If any write fails, roll back the rest.

---

## 🟢 Nice-to-have — can defer

### 5. Name the default export in `index.ts`

`packages/pi-hello/index.ts` uses an anonymous function:

```ts
export default function (pi: ExtensionAPI) {
```

A named function improves stack traces:

```ts
export default function helloExtension(pi: ExtensionAPI) {
```

### 6. DRY up repeated mock setup in tests

`packages/pi-hello/hello.test.ts` — tests 2 and 3 duplicate the same mock `pi`/`captured` boilerplate. Extract a `setupMock()` helper:

```ts
function setupMock() {
    const captured = new Map<string, { handler: Function }>();
    const pi = {
        registerCommand: (name: string, def: { handler: Function }) => {
            captured.set(name, def);
        },
    } as unknown as ExtensionAPI;
    return { pi, captured };
}
```

### 7. Pin peer dependency version

`packages/pi-hello/package.json` uses a wildcard peer dep:

```json
"@earendil-works/pi-coding-agent": "*"
```

Once the pi SDK stabilizes, pin a minimum:

```json
"@earendil-works/pi-coding-agent": ">=1.0.0"
```

### 8. Clean up empty `test/setup.ts`

`test/setup.ts` has an `import { beforeEach }` with an empty callback. Either add a `// TODO` comment explaining its future purpose, or remove the import until there's actual setup logic.

---

## Effort Estimate

| Phase | Items | Effort |
|-------|-------|--------|
| Blocker | #1 | ~5 min |
| Recommended | #2–#4 | ~30 min |
| Nice-to-have | #5–#8 | ~15 min |
| **Total** | | **~50 min** |
