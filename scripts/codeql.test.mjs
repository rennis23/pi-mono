import { describe, expect, it } from "vitest";
import { buildCodeqlCommands } from "./codeql.mjs";

describe("CodeQL command setup", () => {
	it("downloads the JavaScript query pack and scopes extraction to packages", () => {
		const commands = buildCodeqlCommands({ databasePath: "/tmp/database", sarifPath: "/tmp/results.sarif" });

		expect(commands[0]).toEqual(["pack", "download", "codeql/javascript-queries"]);
		expect(commands[1]).toEqual([
			"database",
			"create",
			"/tmp/database",
			"--language=javascript",
			"--source-root=packages",
			"--build-mode=none",
		]);
		expect(commands[2]).toEqual([
			"database",
			"analyze",
			"/tmp/database",
			"--format=sarifv2.1.0",
			"--output=/tmp/results.sarif",
			"codeql/javascript-queries:codeql-suites/javascript-security-extended.qls",
		]);
	});
});
