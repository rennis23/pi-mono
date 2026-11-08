# PLAN — Fix review findings (mx-pi-agents)

Work in `/Users/toru/project/pi-mono`. Do steps in order. One commit per step.
Do not touch `packages/mx-pi-agents/PLAN.md`.

Before every commit run:

```bash
npm run check && npx vitest run packages/mx-pi-agents
```

Both must pass. If not, fix before committing.

---

## Step 1 — Fix `~` path bypass (HIGH)

Problem: `packages/mx-pi-agents/src/runners/confine.ts` checks the raw `path`.
pi expands `~` and strips `@`, so `~/.ssh/id_rsa` passes the check but reads the real home file.

1a. Create `packages/mx-pi-agents/src/paths.ts` with:

```ts
import { homedir } from "node:os";
import { resolve } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Same normalization pi applies before it opens a path. */
export function normalizeToolPath(raw: string, home: string = homedir()): string {
	let value = raw.replace(UNICODE_SPACES, " ");
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") return home;
	if (value.startsWith("~/")) return resolve(home, value.slice(2));
	return value;
}

/** Paths pi may open for this input: the base path plus macOS name variants. */
export function candidatePaths(normalized: string, cwd: string): string[] {
	const base = resolve(cwd, normalized);
	const variants = [
		base.replace(/ (AM|PM)\./gi, "\u202F$1."),
		base.normalize("NFD"),
		base.replace(/'/g, "\u2019"),
		base.normalize("NFD").replace(/'/g, "\u2019"),
	];
	return [base, ...variants.filter((v, i, all) => v !== base && all.indexOf(v) === i)];
}

/** True when the raw form starts with `~` followed by a user name (not supported). */
export function isUnsupportedTilde(raw: string): boolean {
	const value = raw.replace(/^@/, "");
	return /^~[^/]/.test(value);
}
```

1b. Edit `confine.ts` → `confineToolDefinition` → inside `execute`, replace the
line `const candidate = ...` and `assertPathInScope(...)` with:

```ts
const rawPath = typeof raw === "string" && raw.trim().length > 0 ? raw : options.cwd;
if (isUnsupportedTilde(rawPath)) {
	throw new ScopeRefusalError(`${definition.name}.${spec.field}: ~user paths are not supported: ${rawPath}`);
}
const normalized = normalizeToolPath(rawPath);
for (const candidate of candidatePaths(normalized, options.cwd)) {
	assertPathInScope(options.roots, candidate, `${definition.name}.${spec.field}`);
}
```

Add the imports from `./../paths.js` (note the explicit `.js`).

1c. Create `packages/mx-pi-agents/src/paths.test.ts` with these cases (use `home = "/home/u"`, `cwd = "/work/proj"`):
- `normalizeToolPath("~/x", "/home/u")` → `/home/u/x`
- `normalizeToolPath("~", "/home/u")` → `/home/u`
- `normalizeToolPath("@x", "/home/u")` → `x`
- `normalizeToolPath("a\u00A0b", "/home/u")` → `a b`
- `isUnsupportedTilde("~bob/x")` → true; `isUnsupportedTilde("~/x")` → false
- `candidatePaths("a.txt", "/work/proj")` includes `/work/proj/a.txt`

1d. Add to `confine.test.ts`: a `read` call with `path: "~/secret"` is refused
when the scope root is `<cwd>` (use a temp dir as cwd).

Commit: `fix(mx-pi-agents): check tool paths in the form pi opens them`

---

## Step 2 — Allowlist env for sandboxed bash (MEDIUM)

Problem: `sandbox: os` bash gets the full parent env (API keys, tokens).

2a. In `packages/mx-pi-agents/src/runners/sandbox.ts` add:

```ts
const ENV_ALLOW = ["PATH", "LANG", "TERM", "SHELL", "USER", "LOGNAME", "HOME", "npm_config_cache"];

/** Env for sandboxed bash: allowlist only, TMPDIR pinned to the run temp dir. */
export function sandboxEnv(parent: NodeJS.ProcessEnv, runTmp: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOW) {
		const value = parent[key];
		if (value !== undefined) out[key] = value;
	}
	for (const key of Object.keys(parent)) {
		if (key.startsWith("LC_") && parent[key] !== undefined) out[key] = parent[key];
	}
	out.TMPDIR = runTmp;
	return out;
}
```

2b. In the same file, wherever the sandboxed bash spawn sets `env`, pass
`sandboxEnv(process.env, runTmp)`. If pi's `exec` receives `env` in its options,
set it there. Do not pass the parent env through.

2c. Add tests to `sandbox.test.ts`:
- parent with `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `PI_SESSION_ID`, `FOO` →
  output has none of them.
- output has `TMPDIR` equal to the run temp dir.
- `LC_ALL` is kept.

Do not change unsandboxed bash.

Commit: `fix(mx-pi-agents): scrub environment for sandboxed bash`

---

## Step 3 — Private temp dir for sandboxed runs (LOW)

Problem: `sandboxTempRoots()` gives write access to the shared `/tmp` and `$TMPDIR`.

3a. In `sandbox.ts`, create a per-run dir where the sandboxed bash is built:
`const runTmp = mkdtempSync(join(realpathSync(tmpdir()), "mx-pi-run-"))`.
Remove it in `finally` after the run (`rmSync(runTmp, { recursive: true, force: true })`).

3b. Pass `runTmp` to `buildSeatbeltProfile` and `buildBwrapArgv` as the only
temp write root. Remove the `sandboxTempRoots()` write grant in both.
Keep `sandboxTempRoots()` for read only if the tests need it.

3c. Update golden tests in `sandbox.test.ts`. Add a test: the shared `/tmp`
root is not in the profile text.

3d. If a sandboxed test run fails only because a tool needs `/tmp`: stop, keep
the old grant, and write one line in `packages/mx-pi-agents/SECURITY.md` saying
the shared temp dir is writable. Tell the user in the commit message.

Commit: `fix(mx-pi-agents): give sandboxed runs a private temp dir`

---

## Step 4 — Cap chain and pipeline length (LOW)

4a. In `packages/mx-pi-agents/src/modes.ts`:
- At the start of `runChain`, add:
  ```ts
  const chainError = taskCountError(steps.length);
  if (chainError !== undefined) {
  	return { mode: "chain", results: [], stoppedAt: undefined, diagnostics: [], refusal: { reason: "invalid-request", message: chainError, diagnostics: [] } };
  }
  ```
- At the start of `runPipeline`, add the same check on `stages.length`
  (use `mode: "pipeline"`).

4b. In `modes.test.ts` add:
- chain of 9 steps → refusal `invalid-request`, no child planned.
- chain of 8 steps → runs.
- pipeline of 9 stages → refusal.

4c. In `packages/mx-pi-agents/index.ts`, in the `mx_pi_agent` tool
`description` array, change "Modes: ..." so it says chain and pipeline are
capped at 8 steps.

Commit: `fix(mx-pi-agents): cap chain and pipeline length at 8`

---

## Step 5 — Small nits (one commit each)

5a. `index.ts` `status` case: change the text `unconfined runs: refused` to
`unconfined runs: refused (default)` when `config.scope` is not set. Update the
test that checks this text, if any.

5b. Move `unavailable()` and `unavailableRunner` out of `index.ts` exports.
Put them in `packages/mx-pi-agents/test/harness.ts`. Update the import in
`index.test.ts`. Remove the `export { unavailableRunner }` line from `index.ts`.

5c. `.gitignore`: delete the second `reports/` line added by this branch.

---

## Step 6 — Branch hygiene (do last)

6a. `git fetch origin`
6b. `git merge origin/master` → resolve conflicts (CI files only). Run check + test.
6c. `git merge origin/agents-v1-patch-3` → run check + test.
6d. Do not rewrite pushed history. Do not force push.

Done when `git status` is clean and `git log --oneline origin/master..HEAD` shows the new commits.

---

## Final verification

```bash
npm run check
npm test
npm run mutation:changed
npm run security:packages
```

All four must pass. Then report:
- list of commits
- list of files changed
- any step skipped and why
