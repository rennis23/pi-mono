import { describe, expect, it } from "vitest";
import { applySubagentPatch, parseSpawnArgs, parseSubagentPayload } from "./subagents.js";
import type { SubagentInfo } from "./types.js";

/** Nested (maister-style) payload: usage under `details`. */
const nestedPayload = {
	details: {
		usage: { turns: 3, input: 15_000, output: 2_000, totalTokens: 18_000, cost: 0.005 },
		model: "anthropic/claude-sonnet-4-5",
		toolsUsed: ["read", "grep"],
	},
};

/** Flat payload: usage at the top level, long-form field names. */
const flatPayload = {
	usage: { turnCount: 2, inputTokens: 8000, outputTokens: 1000, contextTokens: 10_000, totalCost: 0.002 },
	model: "gpt-5",
	tools: ["read"],
};

function makeInfo(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
	return {
		toolCallId: "call-1",
		agentName: "Explore",
		tools: [],
		model: undefined,
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		cost: 0,
		status: "running",
		promptNum: 1,
		startTime: 0,
		duration: 0,
		tokPerSec: 0,
		...overrides,
	};
}

describe("parseSubagentPayload", () => {
	it("reads the nested details.usage shape", () => {
		expect(parseSubagentPayload(nestedPayload)).toEqual({
			usage: { turns: 3, input: 15_000, output: 2_000, context: 18_000, cost: 0.005 },
			model: "anthropic/claude-sonnet-4-5",
			tools: ["read", "grep"],
		});
	});

	it("reads the flat shape with long-form field names", () => {
		expect(parseSubagentPayload(flatPayload)).toEqual({
			usage: { turns: 2, input: 8000, output: 1000, context: 10_000, cost: 0.002 },
			model: "gpt-5",
			tools: ["read"],
		});
	});

	it("accepts a cost object or a plain number", () => {
		expect(parseSubagentPayload({ usage: { cost: { total: 0.25 } } }).usage?.cost).toBe(0.25);
		expect(parseSubagentPayload({ usage: { cost: 0.5 } }).usage?.cost).toBe(0.5);
	});

	it("returns an empty patch for unrecognized input", () => {
		expect(parseSubagentPayload(undefined)).toEqual({});
		expect(parseSubagentPayload(null)).toEqual({});
		expect(parseSubagentPayload("done")).toEqual({});
		expect(parseSubagentPayload(42)).toEqual({});
		expect(parseSubagentPayload([])).toEqual({});
		expect(parseSubagentPayload({ details: { note: "no usage here" } })).toEqual({});
	});

	it("does not attach an empty usage object", () => {
		// An empty usage would zero out good values on a final payload.
		expect(parseSubagentPayload({ details: { usage: { unknownField: 1 } } }).usage).toBeUndefined();
	});

	it("ignores non-finite numbers instead of poisoning state", () => {
		const patch = parseSubagentPayload({ usage: { input: Number.NaN, output: 500 } });
		expect(patch.usage?.input).toBeUndefined();
		expect(patch.usage?.output).toBe(500);
	});
});

describe("parseSpawnArgs", () => {
	it("reads snake_case args", () => {
		expect(parseSpawnArgs({ agent_name: "Explore", tools: ["read", "grep"] })).toEqual({
			agentName: "Explore",
			tools: ["read", "grep"],
		});
	});

	it("reads camelCase args and the toolsUsed alias", () => {
		expect(parseSpawnArgs({ agentName: "gap-analyzer", toolsUsed: ["read"] })).toEqual({
			agentName: "gap-analyzer",
			tools: ["read"],
		});
	});

	it("falls back to unknown/[]", () => {
		expect(parseSpawnArgs(undefined)).toEqual({ agentName: "unknown", tools: [] });
		expect(parseSpawnArgs({})).toEqual({ agentName: "unknown", tools: [] });
		expect(parseSpawnArgs({ name: "solo" })).toEqual({ agentName: "solo", tools: [] });
	});
});

describe("applySubagentPatch", () => {
	it("merges only present fields on a streaming update", () => {
		const info = makeInfo({ turns: 2, inputTokens: 4000, cost: 0.01 });
		applySubagentPatch(info, { usage: { output: 900 } });
		// Untouched fields keep their previous values instead of dropping to 0.
		expect(info).toMatchObject({ turns: 2, inputTokens: 4000, outputTokens: 900, cost: 0.01 });
	});

	it("replaces usage wholesale on a final payload", () => {
		const info = makeInfo({ turns: 2, inputTokens: 4000, outputTokens: 900, cost: 0.01 });
		applySubagentPatch(info, { usage: { turns: 5, input: 9000 } }, true);
		expect(info).toMatchObject({ turns: 5, inputTokens: 9000, outputTokens: 0, cost: 0 });
	});

	it("fills model and tools only once while streaming", () => {
		const info = makeInfo();
		applySubagentPatch(info, { model: "sonnet-4-5", tools: ["read"] });
		applySubagentPatch(info, { model: "opus-4-6", tools: ["bash"] });
		expect(info.model).toBe("sonnet-4-5");
		expect(info.tools).toEqual(["read"]);
	});

	it("lets the final payload correct model and tools", () => {
		const info = makeInfo({ model: "sonnet-4-5", tools: ["read"] });
		applySubagentPatch(info, { model: "opus-4-6", tools: ["read", "bash"] }, true);
		expect(info.model).toBe("opus-4-6");
		expect(info.tools).toEqual(["read", "bash"]);
	});

	it("ignores an empty patch", () => {
		const info = makeInfo({ turns: 3 });
		applySubagentPatch(info, {}, true);
		expect(info.turns).toBe(3);
	});
});
