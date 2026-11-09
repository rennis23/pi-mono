#!/usr/bin/env node
/**
 * Run Stryker mutation testing only for package source files changed since a Git
 * base ref. The mutable set is derived from stryker.config.json.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = "stryker.config.json";
const DEFAULT_BASE = "HEAD";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function matchSegment(pattern, value) {
	let patternIndex = 0;
	let valueIndex = 0;
	let starIndex = -1;
	let starValueIndex = -1;

	while (valueIndex < value.length) {
		const character = pattern[patternIndex];
		if (character === "?" || character === value[valueIndex]) {
			patternIndex += 1;
			valueIndex += 1;
		} else if (character === "*") {
			starIndex = patternIndex;
			starValueIndex = valueIndex;
			patternIndex += 1;
		} else if (starIndex !== -1) {
			patternIndex = starIndex + 1;
			starValueIndex += 1;
			valueIndex = starValueIndex;
		} else {
			return false;
		}
	}

	while (pattern[patternIndex] === "*") patternIndex += 1;
	return patternIndex === pattern.length;
}

function matchGlob(patternParts, fileParts, patternIndex, fileIndex, memo) {
	const key = `${patternIndex}:${fileIndex}`;
	const cached = memo.get(key);
	if (cached !== undefined) return cached;
	let result;
	if (patternIndex === patternParts.length) {
		result = fileIndex === fileParts.length;
	} else if (patternParts[patternIndex] === "**") {
		result =
			matchGlob(patternParts, fileParts, patternIndex + 1, fileIndex, memo) ||
			(fileIndex < fileParts.length && matchGlob(patternParts, fileParts, patternIndex, fileIndex + 1, memo));
	} else {
		result =
			fileIndex < fileParts.length &&
			matchSegment(patternParts[patternIndex], fileParts[fileIndex]) &&
			matchGlob(patternParts, fileParts, patternIndex + 1, fileIndex + 1, memo);
	}
	memo.set(key, result);
	return result;
}

export function globMatcher(pattern) {
	const patternParts = pattern.replace(/^\//, "").split("/");
	return (file) => matchGlob(patternParts, file.replaceAll("\\", "/").split("/"), 0, 0, new Map());
}

export function makeMutableFilter(patterns) {
	const includes = patterns.filter((pattern) => !pattern.startsWith("!")).map(globMatcher);
	const excludes = patterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => globMatcher(pattern.slice(1)));
	return (file) => includes.some((matches) => matches(file)) && !excludes.some((matches) => matches(file));
}

export function parseArgs(argv) {
	const separator = argv.indexOf("--");
	const own = separator === -1 ? argv : argv.slice(0, separator);
	const afterSeparator = separator === -1 ? [] : argv.slice(separator + 1);
	const baseIndex = own.findIndex((argument) => !argument.startsWith("-"));
	const base = baseIndex === -1 ? DEFAULT_BASE : own[baseIndex];
	const forwarded = [
		...own.filter((argument) => argument.startsWith("-") && !["--list", "-l", "--help", "-h"].includes(argument)),
		...afterSeparator,
	];
	return {
		base,
		list: own.includes("--list") || own.includes("-l"),
		help: own.includes("--help") || own.includes("-h"),
		forwarded,
	};
}

function fail(message) {
	throw new Error(`mutation-changed: ${message}`);
}

export function readMutatePatterns(configPath = CONFIG_PATH) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		fail(`cannot read ${configPath}: ${error.message}`);
	}
	const patterns = parsed?.mutate;
	if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((pattern) => typeof pattern !== "string")) {
		fail(`${configPath} has no usable "mutate" patterns`);
	}
	return patterns;
}

function gitLines(args, cwd = process.cwd()) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch (error) {
		const detail = error.stderr?.toString().trim() || error.message;
		fail(`git ${args.join(" ")} failed: ${detail}`);
	}
}

export function changedFiles(base, cwd = process.cwd()) {
	const tracked = gitLines(["diff", "--name-only", "--diff-filter=ACMR", base], cwd);
	const untracked = gitLines(["ls-files", "--others", "--exclude-standard"], cwd);
	return [...new Set([...tracked, ...untracked])].sort();
}

function printHelp() {
	console.log(`Usage: node scripts/mutation-changed.mjs [base-ref] [--list] [-- <stryker args>]

  base-ref   git ref to diff against (default: ${DEFAULT_BASE})
  --list     print the files that would be mutated and exit without running Stryker
  --         everything after this marker is passed to stryker run
`);
}

export function runChangedMutation({ argv = process.argv.slice(2), configPath = CONFIG_PATH } = {}) {
	const { base, list, help, forwarded } = parseArgs(argv);
	if (help) {
		printHelp();
		return 0;
	}

	const isMutable = makeMutableFilter(readMutatePatterns(configPath));
	const files = changedFiles(base).filter(isMutable);
	if (files.length === 0) {
		console.log(`No mutable source files changed vs ${base}; skipping Stryker.`);
		return 0;
	}

	console.log(`Mutating ${files.length} changed file(s) vs ${base}:`);
	for (const file of files) console.log(`  ${file}`);
	if (list) return 0;

	const result = spawnSync(NPX, ["stryker", "run", "--mutate", files.join(","), ...forwarded], { stdio: "inherit" });
	if (result.error) fail(result.error.message);
	return result.status ?? 1;
}

function isMainModule() {
	try {
		return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
	} catch {
		return false;
	}
}

if (isMainModule()) {
	try {
		process.exitCode = runChangedMutation();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
