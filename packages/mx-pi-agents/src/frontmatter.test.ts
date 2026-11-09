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

describe("parseFrontmatter: mutation-hardening boundaries", () => {
	it("rejects a key with a trailing invalid character", () => {
		expectError(["---", "key!: x", "---"].join("\n"), "cannot parse line 2: key!: x");
	});

	it("rejects a key starting with a digit", () => {
		expectError(["---", "1key: x", "---"].join("\n"), "cannot parse line 2: 1key: x");
	});

	it("rejects a key containing a dot", () => {
		expectError(["---", "a.b: x", "---"].join("\n"), "cannot parse line 2: a.b: x");
	});

	it("accepts a key with hyphens, underscores and digits", () => {
		const { data } = parseOk(["---", "_a-b_c-1: x", "---"].join("\n"));
		expect(data).toEqual({ "_a-b_c-1": "x" });
	});

	it("accepts a first line of --- with trailing spaces", () => {
		const { data } = parseOk(["---   ", "name: x", "---"].join("\n"));
		expect(data).toEqual({ name: "x" });
	});

	it("rejects a first line of ----", () => {
		expectError(["----", "name: x", "---"].join("\n"), "missing frontmatter block");
	});

	it("rejects a first line of ---x", () => {
		expectError(["---x", "name: x", "---"].join("\n"), "missing frontmatter block");
	});

	it("rejects a first line with leading space", () => {
		expectError([" ---", "name: x", "---"].join("\n"), "missing frontmatter block");
	});

	it("accepts a terminator of --- with trailing spaces", () => {
		const { data } = parseOk(["---", "name: x", "---  ", "body"].join("\n"));
		expect(data).toEqual({ name: "x" });
	});

	it("accepts a terminator of ... with trailing spaces", () => {
		const { data } = parseOk(["---", "name: x", "... ", "body"].join("\n"));
		expect(data).toEqual({ name: "x" });
	});

	it("rejects .... as a terminator", () => {
		expectError(["---", "name: x", "...."].join("\n"), "unterminated frontmatter block");
	});

	it("rejects -- as a terminator", () => {
		expectError(["---", "name: x", "--"].join("\n"), "unterminated frontmatter block");
	});

	it("rejects ...x as a terminator", () => {
		expectError(["---", "name: x", "...x"].join("\n"), "unterminated frontmatter block");
	});

	it("keeps an unknown escape sequence verbatim", () => {
		const { data } = parseOk(["---", 'key: "a\\nb"', "---"].join("\n"));
		expect(data).toEqual({ key: "a\\nb" });
	});

	it("unescapes a backslash and an escaped quote", () => {
		const { data } = parseOk(["---", 'key: "a\\\\b\\"c"', "---"].join("\n"));
		expect(data).toEqual({ key: 'a\\b"c' });
	});

	it("rejects trailing text after a closing double quote", () => {
		expectError(["---", 'key: "x" y', "---"].join("\n"), 'cannot parse line 2: "x" y');
	});

	it("rejects trailing text after a closing single quote", () => {
		expectError(["---", "key: 'x' y", "---"].join("\n"), "cannot parse line 2: 'x' y");
	});

	it("collapses doubled single quotes", () => {
		const { data } = parseOk(["---", "key: 'a''b''c'", "---"].join("\n"));
		expect(data).toEqual({ key: "a'b'c" });
	});

	it("parses an empty quoted string as an empty string", () => {
		const { data } = parseOk(["---", 'a: ""', "b: ''", "---"].join("\n"));
		expect(data).toEqual({ a: "", b: "" });
	});

	it("parses a quoted number as a string", () => {
		const { data } = parseOk(["---", 'key: "42"', "---"].join("\n"));
		expect(data).toEqual({ key: "42" });
	});

	it("accepts signed decimals and bare decimals", () => {
		const { data } = parseOk(["---", "a: +1.5", "b: -.5", "c: .5", "d: +.5", "---"].join("\n"));
		expect(data).toEqual({ a: 1.5, b: -0.5, c: 0.5, d: 0.5 });
	});

	it("rejects a trailing decimal point", () => {
		expectError(["---", "key: 1.", "---"].join("\n"), 'unsupported numeric value "1."');
	});

	it("rejects a value with two decimal points", () => {
		expectError(["---", "key: 1.2.3", "---"].join("\n"), 'unsupported numeric value "1.2.3"');
	});

	it("rejects a signed exponent", () => {
		expectError(["---", "key: -1e3", "---"].join("\n"), 'unsupported numeric value "-1e3"');
	});

	it("rejects an unsafe integer", () => {
		expectError(["---", "key: 9007199254740993", "---"].join("\n"), "unsafe integer value");
	});

	it("accepts the largest safe integer", () => {
		const { data } = parseOk(["---", "key: 9007199254740991", "---"].join("\n"));
		expect(data).toEqual({ key: 9007199254740991 });
	});

	it("treats capitalised booleans and YAML 1.1 words as plain strings", () => {
		const { data } = parseOk(["---", "a: True", "b: yes", "c: on", "d: off", "---"].join("\n"));
		expect(data).toEqual({ a: "True", b: "yes", c: "on", d: "off" });
	});

	it("rejects a bare flow item containing a colon", () => {
		expectError(["---", "key: [a:b]", "---"].join("\n"), "cannot parse line 2: [a:b]");
	});

	it("rejects a bare flow item containing a bracket", () => {
		expectError(["---", "key: [a[b]", "---"].join("\n"), "cannot parse line 2: [a[b]");
	});

	it("rejects a bare flow item containing a brace", () => {
		expectError(["---", "key: [a{b]", "---"].join("\n"), "cannot parse line 2: [a{b]");
	});

	it("accepts quoted flow items containing forbidden characters", () => {
		const { data } = parseOk(["---", "key: [\"a:b\", 'c,d']", "---"].join("\n"));
		expect(data).toEqual({ key: ["a:b", "c,d"] });
	});

	it("rejects a flow list containing an empty bare item", () => {
		expectError(["---", "key: [a,,b]", "---"].join("\n"), "cannot parse line 2");
	});

	it("rejects junk after a closed flow list", () => {
		expectError(["---", "key: [a] x", "---"].join("\n"), "cannot parse line 2");
	});

	it("rejects a quoted item immediately followed by a bare item", () => {
		expectError(["---", 'key: ["a"b]', "---"].join("\n"), "cannot parse line 2");
	});

	it("accepts a flow list with inner spaces and an empty list with spaces", () => {
		const spaced = parseOk(["---", "key: [ a , b ]", "---"].join("\n"));
		expect(spaced.data).toEqual({ key: ["a", "b"] });
		const empty = parseOk(["---", "key: [ ]", "---"].join("\n"));
		expect(empty.data).toEqual({ key: [] });
	});

	it("rejects an unterminated flow list at the end of input", () => {
		expectError(["---", "key: [   ", "---"].join("\n"), "unterminated flow list on line 2");
	});

	it("rejects a duplicate key that repeats the pending key", () => {
		expectError(["---", "key:", "key: x", "---"].join("\n"), 'duplicate key "key" on line 3');
	});

	it("treats a whitespace-only line as blank", () => {
		const { data } = parseOk(["---", "name: x", "   ", "tools:", "  - read", "---"].join("\n"));
		expect(data).toEqual({ name: "x", tools: ["read"] });
	});

	it("trims surrounding whitespace from the body", () => {
		const result = parseOk(["---", "name: x", "---", "", "  body text  ", ""].join("\n"));
		expect(result.body).toBe("body text");
	});

	it("rejects a body whose first non-blank line is ---", () => {
		expectError(["---", "name: x", "---", "   ", "---", "more"].join("\n"), "multi-document frontmatter");
	});

	it("rejects empty content", () => {
		expectError("", "missing frontmatter block");
	});
});

describe("parseFrontmatter: survivor kills", () => {
	it("accepts trailing spaces after a closing double or single quote", () => {
		expect(parseOk(["---", 'a: "x"   ', "b: 'y'   ", "---"].join("\n")).data).toEqual({ a: "x", b: "y" });
	});

	it("keeps a backslash verbatim inside single quotes", () => {
		expect(parseOk(["---", "key: 'a\\b'", "---"].join("\n")).data).toEqual({ key: "a\\b" });
	});

	it("keeps an unknown escape verbatim inside double quotes", () => {
		expect(parseOk(["---", 'key: "a\\qb"', "---"].join("\n")).data).toEqual({ key: "a\\qb" });
	});

	it("keeps doubled single quotes inside a double-quoted string", () => {
		expect(parseOk(["---", `key: "a''b"`, "---"].join("\n")).data).toEqual({ key: "a''b" });
	});

	it("accepts multi-digit decimals on both sides of the point", () => {
		expect(parseOk(["---", "a: 1.25", "b: 0.125", "c: .25", "d: 12.5", "---"].join("\n")).data).toEqual({
			a: 1.25,
			b: 0.125,
			c: 0.25,
			d: 12.5,
		});
	});

	it("accepts trailing spaces after a closed flow list", () => {
		expect(parseOk(["---", "key: [a, b]   ", "---"].join("\n")).data).toEqual({ key: ["a", "b"] });
	});

	it("accepts spaces around items and the flow-list brackets", () => {
		expect(parseOk(["---", "key: [ a , b ]", "---"].join("\n")).data).toEqual({ key: ["a", "b"] });
		expect(parseOk(["---", "key: [a ,b]", "---"].join("\n")).data).toEqual({ key: ["a", "b"] });
	});

	it("rejects a bare flow item containing each forbidden character", () => {
		for (const bad of ["[,a]", "[[]", "[{]", "[}]", "[a:b]"]) {
			const result = parseFrontmatter(["---", `key: ${bad}`, "---"].join("\n"));
			expect(result.ok).toBe(false);
		}
	});

	it("names the trimmed line for an out-of-ceiling bare item", () => {
		const result = parseFrontmatter(["---", "key: [a:b]   ", "---"].join("\n"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("cannot parse line 2: [a:b]");
	});

	it("rejects a top-level line without a colon", () => {
		const result = parseFrontmatter(["---", "name", "---"].join("\n"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("cannot parse line 2: name");
	});

	it("trims trailing whitespace from the invalid-key message", () => {
		const result = parseFrontmatter(["---", "a.b: x   ", "---"].join("\n"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("cannot parse line 2: a.b: x");
	});
});
