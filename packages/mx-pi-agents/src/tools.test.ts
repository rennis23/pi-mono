import { describe, expect, it } from "vitest";
import { formatToolEntry, parseToolEntry, resolveToolSelection } from "./tools.js";
import type { ToolEntry } from "./types.js";

function entry(op: ToolEntry["op"], name: string): ToolEntry {
	return { op, name };
}

describe("parseToolEntry", () => {
	it("reads plain, add and remove entries", () => {
		expect(parseToolEntry("read")).toEqual(entry("plain", "read"));
		expect(parseToolEntry("+codemode")).toEqual(entry("add", "codemode"));
		expect(parseToolEntry("-write")).toEqual(entry("remove", "write"));
		expect(parseToolEntry(" mcp__srv__tool ")).toEqual(entry("plain", "mcp__srv__tool"));
	});

	it("rejects a bare modifier and an invalid name", () => {
		expect(parseToolEntry("+")).toBeUndefined();
		expect(parseToolEntry("-")).toBeUndefined();
		expect(parseToolEntry("+read tool")).toBeUndefined();
		expect(parseToolEntry("")).toBeUndefined();
	});

	it("formats an entry back to the text it was declared as", () => {
		expect(formatToolEntry(entry("plain", "read"))).toBe("read");
		expect(formatToolEntry(entry("add", "codemode"))).toBe("+codemode");
		expect(formatToolEntry(entry("remove", "write"))).toBe("-write");
	});
});

describe("resolveToolSelection", () => {
	it("keeps a plain-only list as an exact preset", () => {
		expect(resolveToolSelection([entry("plain", "read"), entry("plain", "grep")], ["read", "bash"])).toEqual([
			"read",
			"grep",
		]);
	});

	it("applies a modifier-only list on top of the inherited selection", () => {
		const inherited = ["read", "bash", "edit", "write"];
		expect(resolveToolSelection([entry("add", "codemode")], inherited)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"codemode",
		]);
		expect(resolveToolSelection([entry("add", "codemode"), entry("remove", "write")], inherited)).toEqual([
			"read",
			"bash",
			"edit",
			"codemode",
		]);
	});

	it("lets plain names form the base and applies modifiers after them, in order", () => {
		// Plain names form the selection first, so `-bash` matches nothing here.
		expect(resolveToolSelection([entry("remove", "bash"), entry("plain", "read")], ["read", "bash"])).toEqual([
			"read",
		]);
		// Order matters: the removal lands on the plain base, the add appends.
		expect(
			resolveToolSelection([entry("plain", "read"), entry("plain", "bash"), entry("remove", "bash")], ["write"]),
		).toEqual(["read"]);
	});

	it("treats a redundant add and a non-matching removal as no-ops", () => {
		expect(resolveToolSelection([entry("add", "read")], ["read", "bash"])).toEqual(["read", "bash"]);
		expect(resolveToolSelection([entry("remove", "grep")], ["read", "bash"])).toEqual(["read", "bash"]);
	});

	it("deduplicates names on both the plain base and the inherited selection", () => {
		expect(
			resolveToolSelection(
				[entry("plain", "read"), entry("plain", "read"), entry("add", "bash")],
				["read", "bash", "edit"],
			),
		).toEqual(["read", "bash"]);
		expect(resolveToolSelection([entry("add", "grep")], ["read", "read"])).toEqual(["read", "grep"]);
	});

	it("an empty declared list means no tools", () => {
		expect(resolveToolSelection([], ["read", "bash"])).toEqual([]);
	});

	it("does not mutate the inherited selection", () => {
		const inherited = ["read", "bash"];
		resolveToolSelection([entry("add", "grep")], inherited);
		expect(inherited).toEqual(["read", "bash"]);
	});
});
