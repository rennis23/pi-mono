import { describe, expect, it } from "vitest";
import { candidatePaths, isUnsupportedTilde, normalizeToolPath } from "./paths.js";

const HOME = "/home/u";
const CWD = "/work/proj";

describe("normalizeToolPath", () => {
	it("expands `~/` against the home directory like pi does", () => {
		expect(normalizeToolPath("~/x", HOME)).toBe("/home/u/x");
	});

	it("expands a bare `~` to the home directory", () => {
		expect(normalizeToolPath("~", HOME)).toBe(HOME);
	});

	it("strips a leading `@` like pi does", () => {
		expect(normalizeToolPath("@x", HOME)).toBe("x");
	});

	it("collapses Unicode spaces to an ASCII space", () => {
		expect(normalizeToolPath("a\u00A0b", HOME)).toBe("a b");
	});

	it("leaves an already-absolute path alone", () => {
		expect(normalizeToolPath("/etc/passwd", HOME)).toBe("/etc/passwd");
	});

	it("keeps a cwd-relative path relative for the caller to resolve", () => {
		expect(normalizeToolPath("src/main.ts", HOME)).toBe("src/main.ts");
	});
});

describe("isUnsupportedTilde", () => {
	it("flags `~user` as unsupported", () => {
		expect(isUnsupportedTilde("~bob/x")).toBe(true);
	});

	it("does not flag `~/`", () => {
		expect(isUnsupportedTilde("~/x")).toBe(false);
	});

	it("flags `~user` behind a leading `@`", () => {
		expect(isUnsupportedTilde("@~bob/x")).toBe(true);
	});

	it("does not flag a bare `~`", () => {
		expect(isUnsupportedTilde("~")).toBe(false);
	});
});

describe("candidatePaths", () => {
	it("includes the resolved base path", () => {
		expect(candidatePaths("a.txt", CWD)).toContain("/work/proj/a.txt");
	});

	it("resolves a normalized home path against the cwd only when it is relative", () => {
		expect(candidatePaths("/home/u/x", CWD)).toEqual(["/home/u/x"]);
	});

	it("includes the macOS name variants", () => {
		const candidates = candidatePaths("a PM.txt", CWD);
		expect(candidates).toContain("/work/proj/a PM.txt");
		expect(candidates).toContain("/work/proj/a\u202FPM.txt");
	});

	it("dedupes variants that equal the base path", () => {
		expect(candidatePaths("plain.txt", CWD)).toEqual(["/work/proj/plain.txt"]);
	});
});
