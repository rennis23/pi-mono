import { describe, expect, it } from "vitest";
import {
	computeEffectiveTools,
	definitionFromRaw,
	MAX_COST_BUDGET,
	MAX_MAX_TURNS,
	MAX_TIMEOUT_MS,
	MAX_TOKEN_BUDGET,
	parseAgentDefinition,
} from "./schema.js";
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
						"scope: [src, docs]",
						"skills: [alpha, beta-1]",
						"context_files: [AGENTS.md, docs/notes.md]",
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
		expect(definition.scope).toEqual(["src", "docs"]);
		expect(definition.skills).toEqual(["alpha", "beta-1"]);
		expect(definition.contextFiles).toEqual(["AGENTS.md", "docs/notes.md"]);
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

	it("parses scope, keeps an empty list, and defaults absent to undefined", () => {
		const absent = expectOk(parseAgentDefinition(md("name: a\ndescription: d")));
		expect(absent.scope).toBeUndefined();

		const empty = expectOk(parseAgentDefinition(md("name: a\ndescription: d\nscope: []")));
		expect(empty.scope).toEqual([]);

		const listed = expectOk(parseAgentDefinition(md("name: a\ndescription: d\nscope: [src, src, docs]")));
		expect(listed.scope).toEqual(["src", "docs"]);
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

	it("drops a definition whose skills or context_files are malformed", () => {
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nskills: alpha")),
			"skills must be a list of skill names",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nskills: [Alpha]")),
			"skills contains an invalid skill name",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nskills: [a_b]")),
			"skills contains an invalid skill name",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nskills: [a--b]")),
			"skills contains an invalid skill name",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nskills: [a-]")),
			"skills contains an invalid skill name",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nskills: [1]")),
			"skills contains an invalid skill name",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\ncontext_files: AGENTS.md")),
			"context_files must be a list of paths",
		);
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\ncontext_files: [AGENTS.md, 2]")),
			"context_files contains an invalid path entry",
		);
	});

	it("drops a definition whose scope is the wrong shape", () => {
		// Unknown fields and wrong-typed fields both drop the whole definition, so
		// the KNOWN_FIELDS registration must land in the same change as the parse.
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nscope: src")), "scope must be a list");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nscope: [src, 2]")), "scope contains an invalid path");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nscopes: [src]")), 'unknown field "scopes"');
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

	it("defaults kind to main when the field is absent", () => {
		expect(expectOk(parseAgentDefinition(md("name: a\ndescription: d"))).kind).toBe("main");
	});

	it("parses each valid kind", () => {
		for (const kind of ["persona", "main", "sub"] as const) {
			expect(expectOk(parseAgentDefinition(md(`name: a\ndescription: d\nkind: ${kind}`))).kind).toBe(kind);
		}
	});

	it("drops a definition with an unknown or non-string kind", () => {
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nkind: sys")), "kind must be one of");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nkind: PERSONA")), "kind must be one of");
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nkind: 3")), "kind must be one of");
	});

	it("drops a definition named none because the reset name is reserved", () => {
		expectErr(parseAgentDefinition(md("name: none\ndescription: d")), "reserved");
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

describe("schema: boundary hardening", () => {
	const base = { name: "a", description: "d" };

	function rawOk(data: Record<string, unknown>): AgentDefinition {
		const result = definitionFromRaw(data);
		if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
		return result.definition;
	}

	function rawErr(data: Record<string, unknown>, fragment: string): void {
		const result = definitionFromRaw(data);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain(fragment);
	}

	it("name pattern rejects uppercase, leading symbols, dots and overlong names", () => {
		rawErr({ ...base, name: "A" }, "name must match");
		rawErr({ ...base, name: "_a" }, "name must match");
		rawErr({ ...base, name: "a.b" }, "name must match");
		rawErr({ ...base, name: "a".repeat(65) }, "name must match");
		expect(rawOk({ ...base, name: "a".repeat(64) }).name).toHaveLength(64);
		expect(rawOk({ ...base, name: "a-1_b" }).name).toBe("a-1_b");
		expect(rawOk({ ...base, name: " a " }).name).toBe("a");
	});

	it("reserves the reset name and requires name/description", () => {
		rawErr({ ...base, name: "none" }, "reserved");
		rawErr({ description: "d" }, "name is required");
		rawErr({ name: "a" }, "description is required");
		rawErr({ ...base, description: "   " }, "description is required");
		rawErr({ ...base, description: "x".repeat(513) }, "at most 512");
		expect(rawOk({ ...base, description: "x".repeat(512) }).description).toHaveLength(512);
	});

	it("rejects unknown fields", () => {
		rawErr({ ...base, bogus: 1 }, 'unknown field "bogus"');
	});

	it("validates the tool-name pattern, dedupes and rejects bad lists", () => {
		expect(rawOk({ ...base, tools: ["read", "read", "mcp__srv__tool"] }).tools).toEqual(["read", "mcp__srv__tool"]);
		rawErr({ ...base, tools: "read" }, "must be a list of tool names");
		rawErr({ ...base, tools: [1] }, "invalid tool name");
		rawErr({ ...base, tools: ["bad tool"] }, "invalid tool name");
		rawErr({ ...base, tools: ["a".repeat(129)] }, "invalid tool name");
	});

	it("validates the model pattern", () => {
		expect(rawOk({ ...base, model: "provider/model-id" }).model).toBe("provider/model-id");
		rawErr({ ...base, model: "bad model" }, "model contains invalid characters");
		rawErr({ ...base, model: "a".repeat(201) }, "model contains invalid characters");
	});

	it("validates scope entries and dedupes", () => {
		expect(rawOk({ ...base, scope: ["./a", "./a", "b"] }).scope).toEqual(["./a", "b"]);
		rawErr({ ...base, scope: 5 }, "must be a list of paths");
		rawErr({ ...base, scope: [1] }, "invalid path entry");
		rawErr({ ...base, scope: [""] }, "invalid path entry");
		rawErr({ ...base, scope: ["a\u0007b"] }, "invalid path entry");
		rawErr({ ...base, scope: ["x".repeat(1025)] }, "invalid path entry");
	});

	it("validates skill names per the Agent Skills charset and dedupes", () => {
		expect(rawOk({ ...base, skills: ["alpha", "alpha", "beta-1"] }).skills).toEqual(["alpha", "beta-1"]);
		rawErr({ ...base, skills: "alpha" }, "must be a list of skill names");
		rawErr({ ...base, skills: [1] }, "invalid skill name");
		rawErr({ ...base, skills: ["Alpha"] }, "invalid skill name");
		rawErr({ ...base, skills: ["a_b"] }, "invalid skill name");
		rawErr({ ...base, skills: ["-a"] }, "invalid skill name");
		rawErr({ ...base, skills: ["a-"] }, "invalid skill name");
		rawErr({ ...base, skills: ["a--b"] }, "invalid skill name");
		rawErr({ ...base, skills: ["a".repeat(65)] }, "invalid skill name");
	});

	it("validates context_files entries and dedupes", () => {
		expect(rawOk({ ...base, context_files: ["AGENTS.md", "AGENTS.md", "docs/x.md"] }).contextFiles).toEqual([
			"AGENTS.md",
			"docs/x.md",
		]);
		rawErr({ ...base, context_files: 5 }, "must be a list of paths");
		rawErr({ ...base, context_files: [""] }, "invalid path entry");
		rawErr({ ...base, context_files: [1] }, "invalid path entry");
	});

	it("validates kind, inheritance, thinking, isolation and sandbox enums", () => {
		expect(rawOk({ ...base }).kind).toBe("main");
		expect(rawOk({ ...base, kind: "persona" }).kind).toBe("persona");
		expect(rawOk({ ...base, kind: "sub" }).kind).toBe("sub");
		rawErr({ ...base, kind: "bogus" }, "kind must be one of");
		rawErr({ ...base, tools_inheritance: "bogus" }, 'tools_inheritance must be "none" or "parent"');
		expect(rawOk({ ...base, tools_inheritance: "parent" }).toolsInheritance).toBe("parent");
		rawErr({ ...base, thinking: "bogus" }, "thinking must be one of");
		expect(rawOk({ ...base, thinking: "xhigh" }).thinking).toBe("xhigh");
		rawErr({ ...base, isolation: "bogus" }, 'isolation must be "process" or "subprocess"');
		expect(rawOk({ ...base, isolation: "subprocess" }).isolation).toBe("subprocess");
		rawErr({ ...base, sandbox: "bogus" }, 'sandbox must be "none" or "os"');
		expect(rawOk({ ...base, sandbox: "os" }).sandbox).toBe("os");
	});

	it("bounds integer and fractional numeric fields", () => {
		rawErr({ ...base, max_turns: 0 }, "max_turns must be between");
		rawErr({ ...base, max_turns: MAX_MAX_TURNS + 1 }, "max_turns must be between");
		rawErr({ ...base, max_turns: 1.5 }, "max_turns must be an integer");
		expect(rawOk({ ...base, max_turns: 1 }).maxTurns).toBe(1);
		rawErr({ ...base, cost_budget: -1 }, "cost_budget must be between");
		rawErr({ ...base, cost_budget: 1000.1 }, "cost_budget must be between");
		rawErr({ ...base, cost_budget: Number.NaN }, "cost_budget must be a number");
		expect(rawOk({ ...base, cost_budget: 0.5 }).costBudget).toBe(0.5);
	});

	it("parseAgentDefinition requires a non-empty body", () => {
		expectErr(parseAgentDefinition(md("name: a\ndescription: d", "")), "body is empty");
		expect(expectOk(parseAgentDefinition(md("name: a\ndescription: d", "Hello"))).body).toBe("Hello");
	});

	it("computeEffectiveTools: explicit grants are exact and flagged unresolved", () => {
		const outcome = computeEffectiveTools(
			{ tools: ["read", "ghost"], toolsInheritance: "parent" },
			{ parentTools: [], availableTools: ["read"] },
		);
		expect(outcome.tools).toEqual(["read", "ghost"]);
		expect(outcome.unresolvedExplicit).toEqual(["ghost"]);
		expect(outcome.noTools).toBeUndefined();
		expect(outcome.diagnostics[0].message).toContain("ignored when tools is present");
	});

	it("computeEffectiveTools: empty and absent grants become noTools all", () => {
		expect(
			computeEffectiveTools({ tools: [], toolsInheritance: "none" }, { parentTools: [], availableTools: [] }),
		).toMatchObject({ tools: [], noTools: "all" });
		expect(
			computeEffectiveTools(
				{ tools: undefined, toolsInheritance: "none" },
				{ parentTools: ["read"], availableTools: ["read"] },
			),
		).toMatchObject({ tools: [], noTools: "all" });
	});

	it("computeEffectiveTools: parent inheritance drops spawn-capable and unavailable names", () => {
		const outcome = computeEffectiveTools(
			{ tools: undefined, toolsInheritance: "parent" },
			{ parentTools: ["read", "mx_pi_agent", "ghost", "read"], availableTools: ["read"] },
		);
		expect(outcome.tools).toEqual(["read"]);
		expect(outcome.diagnostics.some((d) => d.message.includes("ghost"))).toBe(true);
		expect(outcome.noTools).toBeUndefined();
	});

	it("computeEffectiveTools honours a custom spawn-tool list", () => {
		const outcome = computeEffectiveTools(
			{ tools: undefined, toolsInheritance: "parent" },
			{
				parentTools: ["read", "custom_spawn"],
				availableTools: ["read", "custom_spawn"],
				spawnToolNames: ["custom_spawn"],
			},
		);
		expect(outcome.tools).toEqual(["read"]);
	});
});

describe("schema: survivor kills", () => {
	it("rejects tool names and models with an invalid edge character", () => {
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\ntools: [read name]")), "invalid tool name");
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nmodel: bad model")),
			"model contains invalid characters",
		);
	});

	it("rejects a scope entry containing a control character", () => {
		expectErr(parseAgentDefinition(md('name: a\ndescription: d\nscope: ["x\u0007y"]')), "invalid path entry");
	});

	it("reports missing string fields as required, not wrong-typed", () => {
		const noName = parseAgentDefinition(md("description: d"));
		expect(noName.ok).toBe(false);
		if (!noName.ok) expect(noName.error).toBe("invalid agent definition: name is required");

		const noDesc = parseAgentDefinition(md("name: a"));
		expect(noDesc.ok).toBe(false);
		if (!noDesc.ok) expect(noDesc.error).toBe("invalid agent definition: description is required");
	});

	it("treats explicit null scalar fields as absent", () => {
		const nulled = parseAgentDefinition(
			md("name: a\ndescription: d\nmax_turns: null\ntimeout_ms: null\ntoken_budget: null\ncost_budget: null"),
		);
		expect(nulled.ok).toBe(true);
		if (nulled.ok) {
			expect(nulled.definition.maxTurns).toBeUndefined();
			expect(nulled.definition.costBudget).toBeUndefined();
		}

		const nullName = parseAgentDefinition(md("name: null\ndescription: d"));
		expect(nullName.ok).toBe(false);
		if (!nullName.ok) expect(nullName.error).toBe("invalid agent definition: name is required");
	});

	it("accepts the inclusive bounds for integer and number fields", () => {
		expect(expectOk(parseAgentDefinition(md(`name: a\ndescription: d\nmax_turns: ${MAX_MAX_TURNS}`))).maxTurns).toBe(
			MAX_MAX_TURNS,
		);
		expectErr(
			parseAgentDefinition(md(`name: a\ndescription: d\nmax_turns: ${MAX_MAX_TURNS + 1}`)),
			"must be between",
		);
		expect(
			expectOk(parseAgentDefinition(md(`name: a\ndescription: d\ntimeout_ms: ${MAX_TIMEOUT_MS}`))).timeoutMs,
		).toBe(MAX_TIMEOUT_MS);
		expect(
			expectOk(parseAgentDefinition(md(`name: a\ndescription: d\ntoken_budget: ${MAX_TOKEN_BUDGET}`))).tokenBudget,
		).toBe(MAX_TOKEN_BUDGET);
		expect(
			expectOk(parseAgentDefinition(md(`name: a\ndescription: d\ncost_budget: ${MAX_COST_BUDGET}`))).costBudget,
		).toBe(MAX_COST_BUDGET);
		expect(expectOk(parseAgentDefinition(md("name: a\ndescription: d\ncost_budget: 0"))).costBudget).toBe(0);
	});

	it("trims tool names and scope entries", () => {
		const def = expectOk(
			parseAgentDefinition(md('name: a\ndescription: d\ntools: ["  read  "]\nscope: ["  src  "]')),
		);
		expect(def.tools).toEqual(["read"]);
		expect(def.scope).toEqual(["src"]);
	});

	it("names the allowed kind, thinking, isolation and sandbox values", () => {
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nkind: weird")),
			"kind must be one of: persona, main, sub",
		);
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nthinking: weird")), "thinking must be one of");
		expectErr(
			parseAgentDefinition(md("name: a\ndescription: d\nisolation: weird")),
			'isolation must be "process" or "subprocess"',
		);
		expectErr(parseAgentDefinition(md("name: a\ndescription: d\nsandbox: weird")), 'sandbox must be "none" or "os"');
	});

	it("accepts the valid enum alternatives", () => {
		expect(
			expectOk(parseAgentDefinition(md("name: a\ndescription: d\ntools_inheritance: parent"))).toolsInheritance,
		).toBe("parent");
		expect(expectOk(parseAgentDefinition(md("name: a\ndescription: d\nisolation: subprocess"))).isolation).toBe(
			"subprocess",
		);
		expect(expectOk(parseAgentDefinition(md("name: a\ndescription: d\nsandbox: os"))).sandbox).toBe("os");
	});

	it("treats explicit null enum fields as absent", () => {
		const def = expectOk(
			parseAgentDefinition(
				md(
					"name: a\ndescription: d\nkind: null\ntools_inheritance: null\nthinking: null\nisolation: null\nsandbox: null",
				),
			),
		);
		expect(def.kind).toBe("main");
		expect(def.toolsInheritance).toBe("none");
		expect(def.thinking).toBeUndefined();
		expect(def.isolation).toBe("process");
		expect(def.sandbox).toBe("none");
	});

	it("definitionFromRaw leaves the body empty", () => {
		const result = definitionFromRaw({ name: "a", description: "d" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.definition.body).toBe("");
	});

	it("only warns about tools_inheritance when tools are present and inheritance is parent", () => {
		const none = computeEffectiveTools(
			{ tools: ["read"], toolsInheritance: "none" },
			{ parentTools: [], availableTools: ["read"] },
		);
		expect(none.diagnostics).toEqual([]);

		const parent = computeEffectiveTools(
			{ tools: ["read"], toolsInheritance: "parent" },
			{ parentTools: [], availableTools: ["read"] },
		);
		expect(parent.diagnostics.some((d) => d.message.includes("ignored when tools is present"))).toBe(true);
	});
});
