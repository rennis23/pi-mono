import { describe, expect, it } from "vitest";
import { parseAssignments, parseFlagAssignments } from "./flags.js";

describe("mx-pi-settings CLI assignment parser", () => {
	it("parses multiple namespaced values and trims spaces", () => {
		expect(parseAssignments("mx-pi-a.enabled=true, mx-pi-b.rows=8")).toEqual({
			assignments: [
				{ id: "mx-pi-a", key: "enabled", value: "true" },
				{ id: "mx-pi-b", key: "rows", value: "8" },
			],
			errors: [],
		});
	});

	it("allows commas inside quoted values and supports escaped quote characters", () => {
		expect(parseAssignments("mx-pi-a.label=\"one,two\",mx-pi-a.note='it\\'s fine'").assignments).toEqual([
			{ id: "mx-pi-a", key: "label", value: "one,two" },
			{ id: "mx-pi-a", key: "note", value: "it's fine" },
		]);
	});

	it("unescapes embedded quotes and backslashes and preserves quoted spaces", () => {
		const raw = String.raw`mx-pi-a.label="a\"b",mx-pi-a.path="c\\d",mx-pi-a.note=" keep spaces "`;
		expect(parseAssignments(raw).assignments).toEqual([
			{ id: "mx-pi-a", key: "label", value: 'a"b' },
			{ id: "mx-pi-a", key: "path", value: "c\\d" },
			{ id: "mx-pi-a", key: "note", value: " keep spaces " },
		]);
	});

	it("drops an unfinished quoted assignment but keeps preceding valid ones", () => {
		const result = parseAssignments('mx-pi-a.enabled=true,mx-pi-b.label="unfinished');
		expect(result.assignments).toEqual([{ id: "mx-pi-a", key: "enabled", value: "true" }]);
		expect(result.errors).toEqual(["unclosed quote in assignment list"]);
	});

	it("ignores empty comma-separated pieces", () => {
		expect(parseAssignments(",,mx-pi-a.enabled=true,,").assignments).toEqual([
			{ id: "mx-pi-a", key: "enabled", value: "true" },
		]);
	});

	it("reports malformed entries without discarding valid assignments", () => {
		const result = parseAssignments("mx-pi-a.enabled=true,broken,mx-pi-b.rows=8");
		expect(result.assignments).toHaveLength(2);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("expected id.key=value");
	});

	it("rejects extra path separators, empty path segments, and invalid identifiers", () => {
		const result = parseAssignments("mx-pi-a.one.two=3,../bad.key=x,mx-pi-a.=x,.key=x,=no");
		expect(result.assignments).toEqual([]);
		expect(result.errors).toHaveLength(5);
	});

	it("trims id and key segments and leaves unquoted values intact", () => {
		expect(parseAssignments(" mx-pi-a . enabled = value with spaces ").assignments).toEqual([
			{ id: "mx-pi-a", key: "enabled", value: "value with spaces" },
		]);
	});

	it("rejects uppercase provider ids and invalid field keys", () => {
		const result = parseAssignments("Mx-pi-a.enabled=true,mx-pi-a.1bad=true");
		expect(result.assignments).toEqual([]);
		expect(result.errors).toEqual(['invalid id or key in "Mx-pi-a.enabled"', 'invalid id or key in "mx-pi-a.1bad"']);
	});

	it("keeps a backslash that appears outside quotes", () => {
		expect(parseAssignments(String.raw`mx-pi-a.path=x\y`).assignments).toEqual([
			{ id: "mx-pi-a", key: "path", value: String.raw`x\y` },
		]);
	});

	it("unwraps an empty quoted value and trims path segments", () => {
		expect(parseAssignments('mx-pi-a.label=""').assignments).toEqual([{ id: "mx-pi-a", key: "label", value: "" }]);
		expect(parseAssignments(" mx-pi-a . enabled =x").assignments).toEqual([
			{ id: "mx-pi-a", key: "enabled", value: "x" },
		]);
	});

	it("reports the exact reason for an empty path segment and a missing id", () => {
		expect(parseAssignments("=x").errors).toEqual(['expected id.key=value, got "=x"']);
		expect(parseAssignments("a..b=x").errors).toEqual(['expected one extension id and one key in "a..b"']);
	});

	it("accepts trailing invalid characters only when the identifier rules allow them", () => {
		expect(parseAssignments("mx-pi-a!.key=x").errors).toEqual(['invalid id or key in "mx-pi-a!.key"']);
		expect(parseAssignments("mx-pi-a.enabled!=x").errors).toEqual(['invalid id or key in "mx-pi-a.enabled!"']);
		expect(parseAssignments("mx-pi-a.KEY_2=x").assignments).toEqual([{ id: "mx-pi-a", key: "KEY_2", value: "x" }]);
	});

	it("ignores absent or non-string flags", () => {
		expect(parseFlagAssignments(undefined)).toEqual({ assignments: [], errors: [] });
		expect(parseFlagAssignments(true)).toEqual({ assignments: [], errors: [] });
		expect(parseFlagAssignments("  ")).toEqual({ assignments: [], errors: [] });
	});
});
