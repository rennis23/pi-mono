#!/usr/bin/env node
/**
 * Run Stryker mutation testing only for the source files changed since a git
 * base ref, so local feedback stays fast.
 *
 * Usage:
 *   node scripts/mutation-changed.mjs [base-ref] [--list] [-- <stryker args>]
 *
 *   npm run mutation:changed                 # staged + unstaged + untracked vs HEAD
 *   npm run mutation:changed -- master       # everything changed vs master
 *   npm run mutation:changed -- HEAD --list  # print the mutate list, run nothing
 *
 * The mutable set is derived from `stryker.config.json` (`mutate` patterns), so
 * this script never drifts from the full-run configuration. When no mutable file
 * changed it exits 0 without invoking Stryker, so a docs-only change does not
 * pay for a mutation run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CONFIG_PATH = "stryker.config.json";
const DEFAULT_BASE = "HEAD";

/** Local `npx` binary, accounting for the Windows shim. */
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function fail(message) {
	console.error(`mutation-changed: ${message}`);
	process.exit(1);
}

const HELP = `Usage: node scripts/mutation-changed.mjs [base-ref] [--list] [-- <stryker args>]

  base-ref   git ref to diff against (default: ${DEFAULT_BASE})
  --list     print the files that would be mutated and exit without running Stryker
  --         everything after is passed to \`stryker run\`

Unknown flags (e.g. \`--ignoreStatic\`) are passed straight to \`stryker run\`.

Examples:
  npm run mutation:changed
  npm run mutation:changed -- master
  npm run mutation:changed -- HEAD --list
  npm run mutation:changed -- --ignoreStatic
`;

/**
 * Split argv into this script's arguments and the passthrough for `stryker run`.
 * Everything after a literal `--`, plus any unknown `-`-prefixed flag, is
 * forwarded; the first positional is the base ref.
 */
function parseArgs(argv) {
	const separator = argv.indexOf("--");
	const own = separator === -1 ? argv : argv.slice(0, separator);
	const afterSeparator = separator === -1 ? [] : argv.slice(separator + 1);
	const positional = own.filter((arg) => !arg.startsWith("-"));
	const forwarded = [
		...own.filter((arg) => arg.startsWith("-") && !["--list", "-l", "--help", "-h"].includes(arg)),
		...afterSeparator,
	];
	return {
		base: positional[0] ?? DEFAULT_BASE,
		list: own.includes("--list") || own.includes("-l"),
		help: own.includes("--help") || own.includes("-h"),
		forwarded,
	};
}

/**
 * Turn one `mutate` pattern into a predicate. Only the glob shapes Stryker's
 * config actually uses are supported: an exact path, a `<dir>/**` subtree, and
 * a `<dir>/**` infix with a file suffix (which also matches files directly
 * under `<dir>`).
 */
function patternMatcher(pattern) {
	const normalized = pattern.startsWith("/") ? pattern.slice(1) : pattern;
	const marker = normalized.indexOf("/**/");
	if (marker !== -1) {
		const prefix = normalized.slice(0, marker + 1);
		const rawSuffix = normalized.slice(marker + 4);
		const suffix = rawSuffix.startsWith("*") ? rawSuffix.slice(1) : rawSuffix;
		return (file) => file.startsWith(prefix) && (suffix === "" || file.endsWith(suffix));
	}
	if (normalized.endsWith("/**")) {
		const prefix = `${normalized.slice(0, -"/**".length)}/`;
		return (file) => file.startsWith(prefix);
	}
	return (file) => file === normalized;
}

/** First positive pattern wins; any negative pattern excludes the file. */
function makeMutableFilter(patterns) {
	const includes = patterns.filter((pattern) => !pattern.startsWith("!")).map(patternMatcher);
	const excludes = patterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => patternMatcher(pattern.slice(1)));
	return (file) => includes.some((matches) => matches(file)) && !excludes.some((matches) => matches(file));
}

/** Read the `mutate` patterns from Stryker's config. */
function readMutatePatterns() {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch (error) {
		fail(`cannot read ${CONFIG_PATH}: ${error.message}`);
	}
	const patterns = parsed?.mutate;
	if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((p) => typeof p !== "string")) {
		fail(`${CONFIG_PATH} has no usable "mutate" patterns`);
	}
	return patterns;
}

/** Run a git command and return its non-empty output lines. */
function gitLines(args) {
	try {
		return execFileSync("git", args, { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch (error) {
		const detail = error.stderr?.toString().trim() || error.message;
		fail(`git ${args.join(" ")} failed: ${detail}`);
	}
}

/** Paths changed vs `base`, including untracked files (deletions excluded). */
function changedFiles(base) {
	const tracked = gitLines(["diff", "--name-only", "--diff-filter=ACMR", base]);
	const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
	return [...new Set([...tracked, ...untracked])].sort();
}

const { base, list, help, forwarded } = parseArgs(process.argv.slice(2));
if (help) {
	console.log(HELP);
	process.exit(0);
}

const isMutable = makeMutableFilter(readMutatePatterns());
const files = changedFiles(base).filter(isMutable);

if (files.length === 0) {
	console.log(`No mutable source files changed vs ${base}; skipping Stryker.`);
	process.exit(0);
}

console.log(`Mutating ${files.length} changed file(s) vs ${base}:`);
for (const file of files) console.log(`  ${file}`);

if (list) process.exit(0);

const result = spawnSync(NPX, ["stryker", "run", "--mutate", files.join(","), ...forwarded], { stdio: "inherit" });
if (result.error) fail(result.error.message);
process.exit(result.status ?? 1);
