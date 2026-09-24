import { describe, expect, it } from "vitest";
import { type FrontmatterOk, parseFrontmatter } from "./frontmatter.js";

/** Assert a parse fails and that the message mentions `fragment`. */
function expectError(content: string, fragment: string): void {
	const result = parseFrontmatter(content);
	if (result.ok) {
		throw new Error(`expected parse failure containing "${fragment}" but got ok: ${JSON.stringify(result.data)}`);
	}
	expect(result.error).toContain(fragment);
}

/** Assert a parse succeeds and return the decoded result. */
function parseOk(content: string): FrontmatterOk {
	const result = parseFrontmatter(content);
	if (!result.ok) throw new Error(`expected ok but got error: ${result.error}`);
	return result;
}

describe("parseFrontmatter", () => {
	describe("happy paths", () => {
		it("parses a flat map and extracts the body", () => {
			const result = parseOk(
				[
					"---",
					"name: reviewer",
					"description: A test agent",
					"model: anthropic/claude-sonnet-4-5",
					"---",
					"You are a reviewer.",
					"Be terse.",
				].join("\n"),
			);
			expect(result.data).toEqual({
				name: "reviewer",
				description: "A test agent",
				model: "anthropic/claude-sonnet-4-5",
			});
			expect(result.body).toBe("You are a reviewer.\nBe terse.");
		});

		it("parses every supported scalar type", () => {
			const { data } = parseOk(
				[
					"---",
					"answer: 42",
					"neg: -7",
					"plus: +3",
					"yes: true",
					"no: false",
					"nul: null",
					"tilde: ~",
					"nulUpper: Null",
					"nulUpper2: NULL",
					"plain: hello world",
					'dq: "say \\"hi\\" and \\\\bye"',
					"sq: 'it''s fine'",
					"---",
				].join("\n"),
			);
			expect(data).toEqual({
				answer: 42,
				neg: -7,
				plus: 3,
				yes: true,
				no: false,
				nul: null,
				tilde: null,
				nulUpper: null,
				nulUpper2: null,
				plain: "hello world",
				dq: 'say "hi" and \\bye',
				sq: "it's fine",
			});
		});

		it("parses an inline flow list", () => {
			const { data } = parseOk(
				["---", "tools: [read, write, grep]", 'mixed: [1, two, "three four"]', "---"].join("\n"),
			);
			expect(data).toEqual({ tools: ["read", "write", "grep"], mixed: [1, "two", "three four"] });
		});

		it("parses an empty flow list", () => {
			const { data } = parseOk(["---", "tools: []", "---"].join("\n"));
			expect(data).toEqual({ tools: [] });
		});

		it("parses a block list", () => {
			const { data } = parseOk(["---", "tools:", "  - read", "  - write", "  - grep", "---"].join("\n"));
			expect(data).toEqual({ tools: ["read", "write", "grep"] });
		});

		it("treats an empty value with no list items as null", () => {
			const { data } = parseOk(["---", "model:", "name: x", "---"].join("\n"));
			expect(data).toEqual({ model: null, name: "x" });
		});

		it("skips comments and blank lines", () => {
			const { data } = parseOk(
				["---", "# leading comment", "", "name: x", "  # indented comment", "", "tools:", "  - read", "---"].join(
					"\n",
				),
			);
			expect(data).toEqual({ name: "x", tools: ["read"] });
		});

		it("allows a --- line far below the frontmatter in the body", () => {
			const result = parseOk(["---", "name: x", "---", "First paragraph.", "", "---", "", "Second."].join("\n"));
			expect(result.data).toEqual({ name: "x" });
			expect(result.body).toBe("First paragraph.\n\n---\n\nSecond.");
		});

		it("returns an empty body when nothing follows the block", () => {
			const result = parseOk(["---", "name: x", "---"].join("\n"));
			expect(result.body).toBe("");
		});

		it("accepts ... as a terminator", () => {
			const result = parseOk(["---", "name: x", "...", "body text"].join("\n"));
			expect(result.data).toEqual({ name: "x" });
			expect(result.body).toBe("body text");
		});

		it("strips a UTF-8 BOM and normalizes CRLF", () => {
			const result = parseOk("\uFEFF---\r\nname: x\r\n---\r\nbody\r\n");
			expect(result.data).toEqual({ name: "x" });
			expect(result.body).toBe("body");
		});
	});

	describe("hostile input", () => {
		it("rejects missing frontmatter", () => {
			expectError("hello\nname: x\n---\n", 'missing frontmatter block (expected "---" on line 1)');
		});

		it("rejects an unterminated block", () => {
			expectError("---\nname: x\n", "unterminated frontmatter block starting on line 1");
		});

		it("rejects duplicate keys with the line number", () => {
			expectError(
				["---", "name: a", "description: d", "name: b", "---"].join("\n"),
				'duplicate key "name" on line 4',
			);
		});

		it("rejects anchors", () => {
			expectError(
				["---", "key: &anchor val", "---"].join("\n"),
				"anchors, aliases and tags are not supported (line 2)",
			);
		});

		it("rejects aliases", () => {
			expectError(["---", "key: *ref", "---"].join("\n"), "anchors, aliases and tags are not supported (line 2)");
		});

		it("rejects tags", () => {
			expectError(["---", "key: !!str x", "---"].join("\n"), "anchors, aliases and tags are not supported (line 2)");
		});

		it("rejects flow mappings", () => {
			expectError(["---", "key: {a: b}", "---"].join("\n"), "flow mappings are not supported (line 2)");
		});

		it("rejects nested mappings", () => {
			expectError(["---", "key:", "  sub: 1", "---"].join("\n"), "nested mappings are not supported (line 3)");
		});

		it("rejects tab indentation", () => {
			expectError(["---", "\tkey: value", "---"].join("\n"), "tab indentation is not supported (line 2)");
		});

		it("accepts a decimal (cost budgets are fractional)", () => {
			const result = parseFrontmatter(["---", "key: 1.5", "---"].join("\n"));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data.key).toBe(1.5);
		});

		it("rejects a bare decimal point", () => {
			expectError(["---", "key: .5.", "---"].join("\n"), 'unsupported numeric value ".5." on line 2');
		});

		it("rejects an exponent", () => {
			expectError(["---", "key: 1e3", "---"].join("\n"), 'unsupported numeric value "1e3" on line 2');
		});

		it("rejects a hex literal", () => {
			expectError(["---", "key: 0x10", "---"].join("\n"), 'unsupported numeric value "0x10" on line 2');
		});

		it("rejects an unterminated double quote", () => {
			expectError(["---", 'key: "oops', "---"].join("\n"), "unterminated double-quoted string on line 2");
		});

		it("rejects an unterminated single quote", () => {
			expectError(["---", "key: 'oops", "---"].join("\n"), "unterminated single-quoted string on line 2");
		});

		it("rejects an unterminated flow list", () => {
			expectError(["---", "key: [a, b", "---"].join("\n"), "unterminated flow list on line 2");
		});

		it("rejects a trailing comma in a flow list", () => {
			expectError(["---", "key: [a, b,]", "---"].join("\n"), "trailing comma in flow list on line 2");
		});

		it("rejects multi-document frontmatter", () => {
			expectError(
				["---", "name: a", "---", "", "---", "name: b", "---"].join("\n"),
				"multi-document frontmatter is not supported",
			);
		});

		it("rejects a list item before any key", () => {
			expectError(["---", "  - orphan", "---"].join("\n"), "list item without a key on line 2");
		});

		it("rejects an indented key", () => {
			expectError(["---", "  key: value", "---"].join("\n"), "cannot parse line 2: key: value");
		});

		it("reports the true line number for a bad value deeper in the block", () => {
			expectError(["---", "name: a", "", "# comment", "count: 1e5", "---"].join("\n"), "line 5");
		});
	});
});
