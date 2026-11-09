import { describe, expect, it } from "vitest";
import { definitionFromRaw, MAX_DESCRIPTION_CHARS, parseAgentDefinition } from "./schema.js";
import type { AgentDefinition } from "./types.js";

const BODY = "You are a test agent.";

function md(frontmatter: string, body = BODY): string {
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function expectOk(result: ReturnType<typeof parseAgentDefinition>): AgentDefinition {
	if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
	return result.definition;
}

function expectErr(result: ReturnType<typeof parseAgentDefinition>, fragment: string): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error).toContain(fragment);
}

describe("parseAgentDefinition", () => {
	it("parses a full definition", () => {
		const definition = expectOk(
			parseAgentDefinition(
				md(
					[
						"name: reviewer",
						"description: Read-only code review",
						"system_prompt: replace",
						"tools: [read, grep, find, ls]",
						"skills: [alpha, beta-1]",
						"context_files: [AGENTS.md, docs/notes.md]",
						"model: anthropic/claude-sonnet-4-5",
						"thinking: medium",
					].join("\n"),
				),
			),
		);

		expect(definition.name).toBe("reviewer");
		expect(definition.description).toBe("Read-only code review");
		expect(definition.systemPrompt).toBe("replace");
		expect(definition.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(definition.skills).toEqual(["alpha", "beta-1"]);
		expect(definition.contextFiles).toEqual(["AGENTS.md", "docs/notes.md"]);
		expect(definition.model).toBe("anthropic/claude-sonnet-4-5");
		expect(definition.thinking).toBe("medium");
		expect(definition.body).toBe(BODY);
	});

	it("defaults system_prompt to append when absent", () => {
		const definition = expectOk(parseAgentDefinition(md("name: a\ndescription: d")));
		expect(definition.systemPrompt).toBe("append");
	});

	it("parses each valid system_prompt mode", () => {
		expect(expectOk(parseAgentDefinition(md("name: a\ndescription: d\nsystem_prompt: replace"))).systemPrompt).toBe(
			"replace",
		);
		expect(expectOk(parseAgentDefinition(md("name: a\ndescription: d\nsystem_prompt: append"))).systemPrompt).toBe(
			"append",
		);
	});

	it("drops a definition with an unknown or non-string system_prompt", () => {
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nsystem_prompt: persona")),
			"system_prompt must be one of",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nsystem_prompt: REPLACE")),
			"system_prompt must be one of",
		);
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nsystem_prompt: 3")), "system_prompt must be one of");
	});

	it("distinguishes absent tools from an empty tools list", () => {
		const absent = expectOk(parseAgentDefinition(md("name: a\ndescription: d")));
		const empty = expectOk(parseAgentDefinition(md("name: a\ndescription: d\ntools: []")));
		expect(absent.tools).toBeUndefined();
		expect(empty.tools).toEqual([]);
	});

	it("parses skills and context_files, keeping an empty list empty", () => {
		const absent = expectOk(parseAgentDefinition(md("name: a\ndescription: d")));
		expect(absent.skills).toBeUndefined();
		expect(absent.contextFiles).toBeUndefined();

		const empty = expectOk(parseAgentDefinition(md("name: a\ndescription: d\nskills: []\ncontext_files: []")));
		expect(empty.skills).toEqual([]);
		expect(empty.contextFiles).toEqual([]);

		const listed = expectOk(
			parseAgentDefinition(
				md(
					"name: a\ndescription: d\nskills: [alpha, alpha, beta-1]\ncontext_files: [AGENTS.md, docs/notes.md, docs/notes.md]",
				),
			),
		);
		expect(listed.skills).toEqual(["alpha", "beta-1"]);
		expect(listed.contextFiles).toEqual(["AGENTS.md", "docs/notes.md"]);
	});

	it("dedupes tool names and keeps unknown-but-valid tool names", () => {
		const definition = expectOk(
			parseAgentDefinition(md("name: a\ndescription: d\ntools: [read, read, mcp__srv__tool]")),
		);
		expect(definition.tools).toEqual(["read", "mcp__srv__tool"]);
	});

	it("drops a definition whose skills or context_files are malformed", () => {
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nskills: alpha")), "skills must be a list");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nskills: [Alpha]")), "invalid skill name");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nskills: [a_b]")), "invalid skill name");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nskills: [a--b]")), "invalid skill name");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nskills: [a-]")), "invalid skill name");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nskills: [1]")), "invalid skill name");
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\ncontext_files: AGENTS.md")),
			"must be a list of paths",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\ncontext_files: [AGENTS.md, 2]")),
			"invalid path entry",
		);
	});

	it("rejects unknown fields", () => {
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nallowed_tools: [read]")),
			'unknown field "allowed_tools"',
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\ndisallowed_tools: [bash]")),
			'unknown field "disallowed_tools"',
		);
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nkind: persona")), 'unknown field "kind"');
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nscope: [src]")), 'unknown field "scope"');
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nmax_turns: 5")), 'unknown field "max_turns"');
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\ndelegate: true")), 'unknown field "delegate"');
	});

	it("requires name and description", () => {
		expectErr(parseAgentDefinition(md("description: d")), "name is required");
		expectErr(parseAgentDefinition(md("name: a")), "description is required");
		expectErr(parseAgentDefinition(md("name: a\ndescription: ''")), "description is required");
	});

	it("bounds the description length", () => {
		expectErr(
			parseAgentDefinition(md(`name: a\ndescription: ${"d".repeat(MAX_DESCRIPTION_CHARS + 1)}`)),
			"description must be at most",
		);
	});

	it("enforces the name charset", () => {
		expectErr(parseAgentDefinition(md("name: Reviewer\ndescription: d")), "name must match");
		expectErr(parseAgentDefinition(md("name: ../evil\ndescription: d")), "name must match");
		expectErr(parseAgentDefinition(md(`name: ${"a".repeat(65)}\ndescription: d`)), "name must match");
		expect(expectOk(parseAgentDefinition(md("name: a-1_b\ndescription: d"))).name).toBe("a-1_b");
	});

	it("rejects wrong types", () => {
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\ntools: read")), "tools must be a list");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\ntools: [read, 1]")), "invalid tool name");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nthinking: extreme")), "thinking must be one of");
		expectErr(parseAgentDefinition(md("name: 3\ndescription: d")), "name must be a string");
		expectErr(parseAgentDefinition(md("name: a\ndescription: 3")), "description must be a string");
	});

	it("parses each valid thinking level", () => {
		for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(expectOk(parseAgentDefinition(md(`name: a\ndescription: d\nthinking: ${thinking}`))).thinking).toBe(
				thinking,
			);
		}
	});

	it("rejects a model with invalid characters", () => {
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nmodel: 'bad model'")), "model contains invalid");
	});

	it("ignores an explicit null system_prompt", () => {
		const definition = expectOk(parseAgentDefinition(md("name: a\ndescription: d\nsystem_prompt:")));
		expect(definition.systemPrompt).toBe("append");
	});

	it("rejects an empty body", () => {
		expectErr(parseAgentDefinition("---\nname: a\ndescription: d\n---\n"), "definition body is empty");
	});

	it("surfaces frontmatter parse errors", () => {
		expectErr(parseAgentDefinition("no frontmatter here"), "missing frontmatter block");
		expectErr(parseAgentDefinition("---\nname: a\nname: b\ndescription: d\n---\nbody"), "duplicate key");
	});

	it("rejects control characters in the name via the charset check", () => {
		expectErr(parseAgentDefinition(md('name: "a\\u0007b"\ndescription: d')), "name must match");
	});

	it("drops a definition named none because the reset name is reserved", () => {
		expectErr(parseAgentDefinition(md("name: none\ndescription: d")), "reserved");
	});
});

describe("definitionFromRaw", () => {
	it("returns a definition with an empty body and defers body validation", () => {
		const result = definitionFromRaw({ name: "a", description: "d" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition.body).toBe("");
		expect(result.definition.systemPrompt).toBe("append");
	});

	it("reports unknown fields directly", () => {
		const result = definitionFromRaw({ name: "a", description: "d", wat: true });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain('unknown field "wat"');
	});
});
