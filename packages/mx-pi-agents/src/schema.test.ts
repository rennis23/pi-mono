import { describe, expect, it } from "vitest";
import { computeEffectiveTools, definitionFromRaw, MAX_MAX_TURNS, parseAgentDefinition } from "./schema.js";
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
						"tools: [read, grep, find, ls]",
						"model: anthropic/claude-sonnet-4-5",
						"thinking: medium",
						"max_turns: 20",
						"timeout_ms: 300000",
						"token_budget: 100000",
						"cost_budget: 0.5",
						"isolation: subprocess",
						"sandbox: os",
					].join("\n"),
				),
			),
		);

		expect(definition.name).toBe("reviewer");
		expect(definition.description).toBe("Read-only code review");
		expect(definition.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(definition.model).toBe("anthropic/claude-sonnet-4-5");
		expect(definition.thinking).toBe("medium");
		expect(definition.maxTurns).toBe(20);
		expect(definition.timeoutMs).toBe(300_000);
		expect(definition.tokenBudget).toBe(100_000);
		expect(definition.costBudget).toBe(0.5);
		expect(definition.isolation).toBe("subprocess");
		expect(definition.sandbox).toBe("os");
		expect(definition.body).toBe(BODY);
	});

	it("defaults isolation to process and sandbox to none", () => {
		const definition = expectOk(parseAgentDefinition(md("name: a\ndescription: d")));
		expect(definition.isolation).toBe("process");
		expect(definition.sandbox).toBe("none");
		expect(definition.toolsInheritance).toBe("none");
	});

	it("distinguishes absent tools from an empty tools list", () => {
		const absent = expectOk(parseAgentDefinition(md("name: a\ndescription: d")));
		const empty = expectOk(parseAgentDefinition(md("name: a\ndescription: d\ntools: []")));
		expect(absent.tools).toBeUndefined();
		expect(empty.tools).toEqual([]);
	});

	it("keeps an empty tool list empty rather than defaulting to all tools", () => {
		const definition = expectOk(parseAgentDefinition(md("name: a\ndescription: d\ntools: []")));
		const grants = computeEffectiveTools(definition, {
			parentTools: ["read", "bash"],
			availableTools: ["read", "bash"],
		});
		expect(grants.tools).toEqual([]);
		expect(grants.noTools).toBe("all");
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
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nmemory: true")), 'unknown field "memory"');
	});

	it("requires name and description", () => {
		expectErr(parseAgentDefinition(md("description: d")), "name is required");
		expectErr(parseAgentDefinition(md("name: a")), "description is required");
		expectErr(parseAgentDefinition(md("name: a\ndescription: ''")), "description is required");
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
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nmax_turns: many")), "max_turns must be an integer");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nthinking: extreme")), "thinking must be one of");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nisolation: container")), "isolation must be");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nsandbox: docker")), "sandbox must be");
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\ntools_inheritance: all")),
			"tools_inheritance must be",
		);
	});

	it("bounds numeric fields", () => {
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nmax_turns: 0")), "max_turns must be between");
		expectErr(
			parseAgentDefinition(md(`name: a\ndescription: d\nmax_turns: ${MAX_MAX_TURNS + 1}`)),
			"max_turns must be between",
		);
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\ntimeout_ms: 999")), "timeout_ms must be between");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\ntoken_budget: 1")), "token_budget must be between");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\ncost_budget: -1")), "cost_budget must be between");
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
});

describe("computeEffectiveTools", () => {
	const base = {
		parentTools: ["read", "grep", "bash", "mx_pi_agent", "subagent"],
		availableTools: ["read", "grep", "bash", "mx_pi_agent", "subagent", "find", "ls", "write"],
	};

	it("uses exactly the explicit list", () => {
		const grants = computeEffectiveTools({ tools: ["read", "grep"], toolsInheritance: "none" }, base);
		expect(grants.tools).toEqual(["read", "grep"]);
		expect(grants.noTools).toBeUndefined();
	});

	it("treats an empty explicit list as no tools", () => {
		const grants = computeEffectiveTools({ tools: [], toolsInheritance: "none" }, base);
		expect(grants.tools).toEqual([]);
		expect(grants.noTools).toBe("all");
	});

	it("treats absent tools with inheritance none as no tools", () => {
		const grants = computeEffectiveTools({ tools: undefined, toolsInheritance: "none" }, base);
		expect(grants.tools).toEqual([]);
		expect(grants.noTools).toBe("all");
	});

	it("inherits parent tools minus spawn-capable names", () => {
		const grants = computeEffectiveTools({ tools: undefined, toolsInheritance: "parent" }, base);
		expect(grants.tools).toEqual(["read", "grep", "bash"]);
		expect(grants.noTools).toBeUndefined();
	});

	it("ignores inheritance when tools is present", () => {
		const grants = computeEffectiveTools({ tools: ["read"], toolsInheritance: "parent" }, base);
		expect(grants.tools).toEqual(["read"]);
		expect(grants.diagnostics.some((d) => d.message.includes("ignored"))).toBe(true);
	});

	it("reports unresolved explicit tools without silently dropping them", () => {
		const grants = computeEffectiveTools({ tools: ["read", "mcp__x__y"], toolsInheritance: "none" }, base);
		expect(grants.tools).toEqual(["read", "mcp__x__y"]);
		expect(grants.unresolvedExplicit).toEqual(["mcp__x__y"]);
	});

	it("drops unresolved inherited tools with a diagnostic", () => {
		const grants = computeEffectiveTools(
			{ tools: undefined, toolsInheritance: "parent" },
			{ parentTools: ["read", "ghost"], availableTools: ["read"] },
		);
		expect(grants.tools).toEqual(["read"]);
		expect(grants.diagnostics.some((d) => d.message.includes("ghost"))).toBe(true);
	});

	it("never inherits a spawn-capable tool even under an alias name", () => {
		const grants = computeEffectiveTools(
			{ tools: undefined, toolsInheritance: "parent" },
			{
				parentTools: ["read", "spawn_subagent", "subagent_task", "Task"],
				availableTools: ["read", "spawn_subagent", "subagent_task", "Task"],
			},
		);
		expect(grants.tools).toEqual(["read"]);
	});

	it("produces no tools when the parent has none and inheritance is parent", () => {
		const grants = computeEffectiveTools(
			{ tools: undefined, toolsInheritance: "parent" },
			{ parentTools: [], availableTools: ["read"] },
		);
		expect(grants.tools).toEqual([]);
		expect(grants.noTools).toBe("all");
	});

	it("is never additive: another field cannot widen the grant", () => {
		const definition = expectOk(
			parseAgentDefinition(md("name: a\ndescription: d\ntools: [read]\ntools_inheritance: parent")),
		);
		const grants = computeEffectiveTools(definition, base);
		expect(grants.tools).toEqual(["read"]);
		expect(grants.tools).not.toContain("bash");
	});
});

describe("definitionFromRaw", () => {
	it("rejects non-object input", () => {
		// The parser guards this, but the raw validator should not accept an array either.
		const result = definitionFromRaw({ name: "a", description: "d" });
		expect(result.ok).toBe(true);
	});

	it("trims whitespace from string fields", () => {
		const result = definitionFromRaw({ name: "  a  ", description: "  d  " });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.definition.name).toBe("a");
		expect(result.definition.description).toBe("d");
	});
});
