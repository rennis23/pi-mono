# TODO

Follow-ups from PR #1 review (https://github.com/rennis23/pi-mono/pull/1).

## Should fix

- [ ] `scripts/release.mjs`: `stageChangedFiles()` stages untracked files (`git ls-files -o`), which could silently commit stray local files during a release. Limit to `git ls-files -m -d` or stage only known paths (`packages/*/package.json`, `packages/*/CHANGELOG.md`).
- [ ] `scripts/release.mjs`: hardcoded `git push origin master` — use `git push origin HEAD` plus the tag push so releases work from other branches/forks.
- [ ] `scripts/sync-versions.js`: read/parse failures are swallowed, which can let the lockstep check pass incorrectly. `process.exit(1)` on read failure.
- [ ] `scripts/sync-versions.js`: also sync intra-monorepo `peerDependencies` for lockstep enforcement.

## Nits

- [ ] `test/setup.ts`: drop the empty `beforeEach(() => {})` until real shared setup is needed.
- [ ] `.husky/pre-commit` / `.husky/pre-push`: replace `cmd; if [ $? -ne 0 ]` with `if ! cmd; then`.
- [ ] Root `package.json`: rename `"publish"` script to `publish:all` to avoid shadowing npm's built-in command.
- [ ] `packages/pi-hello/hello.test.ts`: change import `./index.js` to `./index` for clarity.
