#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkSarifFile } from "./sarif-gate.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const CODEQL_ROOT = join(REPOSITORY_ROOT, ".codeql");
const DATABASE_PATH = join(CODEQL_ROOT, "database");
const SARIF_PATH = join(CODEQL_ROOT, "results.sarif");
const QUERY_PACK = "codeql/javascript-queries:codeql-suites/javascript-security-extended.qls";

export function buildCodeqlCommands({ databasePath = DATABASE_PATH, sarifPath = SARIF_PATH } = {}) {
	return [
		["pack", "download", "codeql/javascript-queries"],
		["database", "create", databasePath, "--language=javascript", "--source-root=packages", "--build-mode=none"],
		["database", "analyze", databasePath, "--format=sarifv2.1.0", `--output=${sarifPath}`, QUERY_PACK],
	];
}

function run(command, args) {
	try {
		execFileSync(command, args, { cwd: REPOSITORY_ROOT, stdio: "inherit" });
	} catch (error) {
		const detail = error.stderr?.toString().trim() || error.message;
		throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
	}
}

export function runCodeql({
	command = process.env.CODEQL_BIN ?? "codeql",
	databasePath = DATABASE_PATH,
	sarifPath = SARIF_PATH,
} = {}) {
	mkdirSync(CODEQL_ROOT, { recursive: true });
	rmSync(databasePath, { recursive: true, force: true });
	rmSync(sarifPath, { force: true });
	for (const args of buildCodeqlCommands({ databasePath, sarifPath })) run(command, args);
	checkSarifFile(sarifPath);
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
		runCodeql();
		console.log(`CodeQL passed: no findings. SARIF written to ${SARIF_PATH}`);
	} catch (error) {
		console.error(`CodeQL failed: ${error.message}`);
		process.exitCode = 1;
	}
}
