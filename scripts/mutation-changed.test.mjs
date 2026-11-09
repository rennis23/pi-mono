import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedFiles, makeMutableFilter, parseArgs, readMutatePatterns } from "./mutation-changed.mjs";

const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("mutation path selection", () => {
	it("matches any package and excludes tests and sandbox", () => {
		const isMutable = makeMutableFilter([
			"packages/*/index.ts",
			"packages/*/src/**/*.ts",
			"!packages/*/**/*.test.ts",
			"!sandbox/**",
		]);

		expect(isMutable("packages/mx-pi-one/index.ts")).toBe(true);
		expect(isMutable("packages/mx-pi-two/src/deep/module.ts")).toBe(true);
		expect(isMutable("packages/mx-pi-two/src/module.test.ts")).toBe(false);
		expect(isMutable("sandbox/scripts/run-agent.sh")).toBe(false);
		expect(isMutable("packages/mx-pi-two/README.md")).toBe(false);
	});

	it("parses a base ref, list flag, and passthrough arguments", () => {
		expect(parseArgs(["origin/master", "--list", "--", "--ignoreStatic"])).toEqual({
			base: "origin/master",
			list: true,
			help: false,
			forwarded: ["--ignoreStatic"],
		});
		expect(parseArgs(["--ignoreStatic"])).toEqual({
			base: "HEAD",
			list: false,
			help: false,
			forwarded: ["--ignoreStatic"],
		});
	});

	it("collects tracked changes and untracked files while excluding sandbox from the filter", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-mutation-changed-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "packages", "mx-pi-demo"), { recursive: true });
		await writeFile(join(root, "packages", "mx-pi-demo", "index.ts"), "export {}\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
		execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
		execFileSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
		await writeFile(join(root, "packages", "mx-pi-demo", "index.ts"), "export const changed = true;\n");
		await writeFile(join(root, "packages", "mx-pi-demo", "new.ts"), "export const added = true;\n");
		await writeFile(join(root, "notes.md"), "documentation\n");

		expect(changedFiles("HEAD", root)).toEqual([
			"notes.md",
			"packages/mx-pi-demo/index.ts",
			"packages/mx-pi-demo/new.ts",
		]);
		expect(readMutatePatterns("stryker.config.json")).toContain("packages/*/src/**/*.ts");
	});
});
