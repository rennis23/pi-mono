/**
 * Tests for the main-session resource allow-lists.
 *
 * The contract is fail-closed and total: absent means inherit, `[]` means none,
 * a list means only those entries, and no input can widen the loaded set.
 */

import { describe, expect, it } from "vitest";
import { contextFileAllowed, filterContextFiles, filterSkills, skillAllowed } from "./resources.js";

const CWD = "/repo";

describe("skillAllowed", () => {
	it("allows everything when the allow-list is absent", () => {
		expect(skillAllowed("alpha", undefined)).toBe(true);
	});

	it("allows nothing for an empty allow-list", () => {
		expect(skillAllowed("alpha", [])).toBe(false);
	});

	it("allows only exact names", () => {
		expect(skillAllowed("alpha", ["alpha", "beta"])).toBe(true);
		expect(skillAllowed("alpha-2", ["alpha"])).toBe(false);
	});
});

describe("contextFileAllowed", () => {
	const files = ["/home/u/.pi/agent/AGENTS.md", "/repo/AGENTS.md", "/repo/docs/notes.md"];

	it("allows everything when the allow-list is absent", () => {
		for (const file of files) expect(contextFileAllowed(file, undefined, CWD)).toBe(true);
	});

	it("allows nothing for an empty allow-list", () => {
		for (const file of files) expect(contextFileAllowed(file, [], CWD)).toBe(false);
	});

	it("matches by basename", () => {
		expect(contextFileAllowed(files[0], ["AGENTS.md"], CWD)).toBe(true);
		expect(contextFileAllowed(files[1], ["AGENTS.md"], CWD)).toBe(true);
		expect(contextFileAllowed(files[2], ["notes.md"], CWD)).toBe(true);
	});

	it("matches by cwd-relative path", () => {
		expect(contextFileAllowed(files[1], ["AGENTS.md"], CWD)).toBe(true);
		expect(contextFileAllowed(files[2], ["docs/notes.md"], CWD)).toBe(true);
		expect(contextFileAllowed(files[0], ["docs/notes.md"], CWD)).toBe(false);
	});

	it("matches by absolute path", () => {
		expect(contextFileAllowed(files[2], ["/repo/docs/notes.md"], CWD)).toBe(true);
		expect(contextFileAllowed(files[0], ["/home/u/.pi/agent/AGENTS.md"], CWD)).toBe(true);
	});

	it("does not treat a sibling directory as the cwd", () => {
		expect(contextFileAllowed("/repo-other/AGENTS.md", ["/repo/AGENTS.md"], CWD)).toBe(false);
		expect(contextFileAllowed("/repos/docs/notes.md", ["docs/notes.md"], CWD)).toBe(false);
	});

	it("trims entries and normalizes separators and trailing slashes", () => {
		expect(contextFileAllowed("/repo/AGENTS.md", [" AGENTS.md "], CWD)).toBe(true);
		expect(contextFileAllowed("/repo/AGENTS.md", ["/repo/AGENTS.md/"], CWD)).toBe(true);
		expect(contextFileAllowed("C:\\repo\\AGENTS.md", ["AGENTS.md"], "C:\\repo")).toBe(true);
		expect(contextFileAllowed("C:\\repo\\docs\\notes.md", ["docs/notes.md"], "C:\\repo")).toBe(true);
	});

	it("does not invent a cwd-relative match when cwd is empty", () => {
		expect(contextFileAllowed("/repo/AGENTS.md", ["/repo/AGENTS.md"], "")).toBe(true);
		expect(contextFileAllowed("/repo/AGENTS.md", ["repo/AGENTS.md"], "")).toBe(false);
	});
});

describe("filterSkills", () => {
	it("passes everything through when the field is absent, returning a copy", () => {
		const skills = [{ name: "alpha" }, { name: "beta" }];
		const filtered = filterSkills(skills, undefined);
		expect(filtered).toEqual(skills);
		expect(filtered).not.toBe(skills);
	});

	it("removes every skill for an empty allow-list", () => {
		expect(filterSkills([{ name: "alpha" }], [])).toEqual([]);
	});

	it("keeps only the named skills, preserving order", () => {
		const skills = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
		expect(filterSkills(skills, ["gamma", "alpha"]).map((skill) => skill.name)).toEqual(["alpha", "gamma"]);
	});

	it("ignores unknown names instead of widening the set", () => {
		expect(filterSkills([{ name: "alpha" }], ["nope", "alpha"])).toEqual([{ name: "alpha" }]);
	});

	it("keeps extra fields on the skill objects", () => {
		const skills = [{ name: "alpha", description: "d", filePath: "/x" }];
		expect(filterSkills(skills, ["alpha"])[0]).toMatchObject({ name: "alpha", filePath: "/x" });
	});
});

describe("filterContextFiles", () => {
	const files = [
		{ path: "/repo/AGENTS.md", content: "a" },
		{ path: "/repo/docs/notes.md", content: "b" },
	];

	it("passes everything through when the field is absent, returning a copy", () => {
		const filtered = filterContextFiles(files, undefined, CWD);
		expect(filtered).toEqual(files);
		expect(filtered).not.toBe(files);
	});

	it("removes every file for an empty allow-list", () => {
		expect(filterContextFiles(files, [], CWD)).toEqual([]);
	});

	it("keeps only the matching files, preserving order and extra fields", () => {
		const filtered = filterContextFiles(files, ["docs/notes.md", "AGENTS.md"], CWD);
		expect(filtered.map((file) => file.path)).toEqual(["/repo/AGENTS.md", "/repo/docs/notes.md"]);
		expect(filtered[0].content).toBe("a");
	});

	it("ignores unknown paths", () => {
		expect(filterContextFiles(files, ["nope.md"], CWD)).toEqual([]);
	});
});
