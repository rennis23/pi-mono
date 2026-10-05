import { describe, expect, it } from "vitest";
import { buildCodeqlCommands, codeqlFailureMessage } from "./codeql.mjs";

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

describe("CodeQL failure reporting", () => {
	const args = ["pack", "download", "codeql/javascript-queries"];

	it("explains how to fix a missing CLI executable", () => {
		const message = codeqlFailureMessage({ command: "codeql", args, error: { code: "ENOENT" } });

		expect(message).toContain("the `codeql` executable was not found");
		expect(message).toContain("CODEQL_BIN");
		expect(message).toContain("github/codeql-action/init");
		expect(message).toContain("https://codeql.github.com/docs/codeql-cli/");
	});

	it("names the configured executable when CODEQL_BIN cannot be spawned", () => {
		const message = codeqlFailureMessage({
			command: "/opt/codeql/codeql",
			args,
			error: { code: "ENOENT" },
		});

		expect(message).toContain("the `/opt/codeql/codeql` executable was not found");
	});

	it("reports the invocation and detail for ordinary CLI failures", () => {
		const message = codeqlFailureMessage({
			command: "codeql",
			args: ["version"],
			error: { message: "exit status 2", stderr: Buffer.from("bad flag\n") },
		});

		expect(message).toBe("codeql version failed: bad flag");
	});

	it("falls back to the error message when stderr is empty", () => {
		const message = codeqlFailureMessage({
			command: "codeql",
			args: ["version"],
			error: { message: "Command failed", stderr: Buffer.from("") },
		});

		expect(message).toBe("codeql version failed: Command failed");
	});
});
